"""Kubernetes clusters created by the platform (ADR-0018): request, quota, node VMs,
kubeadm through the guest agent, kubeconfig for the client, and deletion."""

import os

import pytest
from sqlalchemy import select, update

from app.audit.models import AuditLog
from app.compute.models import Instance
from app.infra.secrets import LocalKek
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.models import Job, JobEvent
from app.jobs.queue import run_one
from app.k8s.models import K8sCluster
from app.providers.fake import FakeProvider
from app.providers.registry import ProviderRegistry
from tests.integration.factories import (
    PASSWORD,
    add_member,
    grant_platform,
    make_project,
    make_tenant,
    make_user,
)

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

SECRET = "3f6d2c1b-8a7e-4d5c-9b0a-1e2f3a4b5c6d"
JOIN = ("kubeadm join 203.0.113.2:6443 --token abcdef.0123456789abcdef "
        "--discovery-token-ca-cert-hash sha256:" + "ab" * 32)
ADMIN_CONF = """apiVersion: v1
kind: Config
clusters:
- name: lab-k8s
  cluster: {server: "https://203.0.113.2:6443"}
users:
- name: kubernetes-admin
  user: {token: not-a-real-token}
contexts:
- name: admin
  context: {cluster: lab-k8s, user: kubernetes-admin}
current-context: admin
"""


def script_of(command: list[str]) -> str:
    """The platform runs its scripts as `env K=V ... bash -c <script> <name>`."""
    return command[-1] if command[0] == "env" else command[0]


@pytest.fixture
def fake() -> FakeProvider:
    f = FakeProvider()
    f.add_node("tagima")
    f.add_template(10900, "debian13-k8s-1.37", node="tagima", disk_gb=10)

    def run(vmid: str, command: list[str], stdin: str | None) -> tuple[int, str, str]:
        name = script_of(command)
        if name == "join-command":
            return 0, JOIN + "\n", ""
        if command[:2] == ["cat", "/etc/kubernetes/admin.conf"]:
            return 0, ADMIN_CONF, ""
        if name == "join-node" and stdin != JOIN + "\n":
            return 2, "", "unexpected join command"
        return 0, f"{name} ok", ""

    f.exec_handler = run
    return f


@pytest.fixture
def prov_registry(app, settings, fake) -> ProviderRegistry:
    reg = ProviderRegistry(settings, LocalKek(os.urandom(32)), factory=lambda *_: fake)
    app.state.providers = reg
    return reg


class Env:
    def __init__(self, client, app):
        self.client, self.app = client, app
        self.tokens: dict[str, str] = {}

    async def h(self, who: str, tenant=None) -> dict[str, str]:
        if who not in self.tokens:
            r = await self.client.post(
                "/api/v1/auth/login", json={"email": f"{who}@example.com", "password": PASSWORD}
            )
            self.tokens[who] = r.json()["access_token"]
        headers = {"Authorization": f"Bearer {self.tokens[who]}"}
        if tenant is not None:
            headers["X-Tenant-Id"] = str(tenant.id)
        return headers

    async def settle(self, owner_db, rounds: int = 60) -> None:
        """Runs jobs until none is pending, skipping their reschedule delays."""
        state = self.app.state
        for _ in range(rounds):
            while await run_one(state.sessionmaker, state.providers, "test-worker"):
                pass
            await owner_db.execute(
                update(Job).where(Job.status == "pending").values(run_after=Job.created_at)
            )
            await owner_db.commit()
            pending = await owner_db.scalar(select(Job.id).where(Job.status == "pending"))
            if pending is None:
                return
        raise AssertionError("jobs did not settle")

    def body(self, **over) -> dict:
        return {
            "name": "lab", "project_id": str(self.web.id), "zone_id": self.zone,
            "image_id": self.image,
            "control_plane": {"vcpus": 2, "memory_mb": 4096, "disk_gb": 40},
            "workers": [{"name": "app", "count": 2, "vcpus": 2, "memory_mb": 4096,
                         "disk_gb": 40}],
            "network": {
                "mode": "static", "lb_ip": "203.0.113.9",
                "node_ipv4": [{"address": f"203.0.113.{i}/28", "gateway": "203.0.113.14"}
                              for i in (2, 3, 4)],
            },
            **over,
        }


@pytest.fixture
async def env(owner_db, client, app, prov_registry):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    e = Env(client, app)
    e.acme, e.globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    e.web = await make_project(owner_db, e.acme, "web")
    for name in ("root", "alice", "carol", "eve"):
        setattr(e, name, await make_user(owner_db, f"{name}@example.com"))
    await grant_platform(owner_db, e.root, "PLATFORM_ADMIN")
    await add_member(owner_db, e.acme, e.alice, "TENANT_ADMIN")
    await add_member(owner_db, e.acme, e.carol, "USER", e.web)
    await add_member(owner_db, e.globex, e.eve, "TENANT_ADMIN")

    root = await e.h("root")
    r = await client.post("/api/v1/admin/regions",
                          json={"slug": "br-sp", "name": "SP", "country_code": "br"}, headers=root)
    r = await client.post(f"/api/v1/admin/regions/{r.json()['id']}/zones",
                          json={"slug": "sp02", "name": "SP02"}, headers=root)
    e.zone = r.json()["zones"][0]["id"]
    r = await client.post("/api/v1/admin/clusters", headers=root, json={
        "name": "hv", "api_url": "https://pve.test:8006", "pool": "cm-lab", "zone_id": e.zone,
    })
    e.cluster = r.json()["id"]
    await client.put(f"/api/v1/admin/clusters/{e.cluster}/credentials", headers=root,
                     json={"token_id": "cloudmgr@pve!cm", "secret": SECRET})
    r = await client.post("/api/v1/admin/images", headers=root, json={
        "cluster_id": e.cluster, "template_vmid": 10900, "name": "Debian 13 · Kubernetes 1.37",
        "kubernetes_version": "1.37.1",
    })
    assert r.status_code == 201, r.text
    e.image = r.json()["id"]
    return e


async def test_kubernetes_images_are_listed_apart(client, env):
    h = await env.h("alice", env.acme)
    assert (await client.get("/api/v1/images", headers=h)).json() == []
    [image] = (await client.get("/api/v1/kubernetes/images", headers=h)).json()
    assert image["kubernetes_version"] == "1.37.1" and image["zone_ids"] == [env.zone]


async def test_client_creates_cluster_end_to_end(client, env, fake, owner_db):
    h = await env.h("alice", env.acme)
    r = await client.post("/api/v1/kubernetes/clusters", json=env.body(), headers=h)
    assert r.status_code == 202, r.text
    await env.settle(owner_db)

    [c] = (await client.get("/api/v1/kubernetes/clusters", headers=h)).json()
    assert c["source"] == "managed" and c["has_kubeconfig"] is False  # never to tenants here
    m = c["managed"]
    assert m["state"] == "active" and m["kubernetes_version"] == "1.37.1"
    assert m["lb_ip"] == "203.0.113.9" and m["api_endpoint"] == "203.0.113.2"
    assert [(p["name"], p["role"], p["count"]) for p in m["pools"]] == [
        ("cp", "control-plane", 1), ("app", "worker", 2)]

    nodes = (await owner_db.execute(
        select(Instance).where(Instance.k8s_cluster_id == c["id"]).order_by(Instance.name)
    )).scalars().all()
    assert [(n.name, n.state, str(n.ipv4)) for n in nodes] == [
        ("lab-app-1", "active", "203.0.113.3"), ("lab-app-2", "active", "203.0.113.4"),
        ("lab-cp-1", "active", "203.0.113.2")]

    # what ran inside the guests, in order, and where
    by_vmid = {n.provider_ref["vmid"]: n.name for n in nodes}
    ran = [(by_vmid[int(vmid)], script_of(cmd)) for vmid, cmd, _ in fake.execs]
    cp_steps = [s for n, s in ran if n == "lab-cp-1"]
    assert cp_steps == ["prepare-node", "init-control-plane", "join-command",
                        "install-addons", "cat"]
    assert sorted(s for n, s in ran if n != "lab-cp-1") == ["join-node", "join-node",
                                                            "prepare-node", "prepare-node"]
    # the join secret only travels on stdin, never in argv or events
    joins = [(cmd, stdin) for _, cmd, stdin in fake.execs if script_of(cmd) == "join-node"]
    assert all(stdin == JOIN + "\n" and JOIN not in " ".join(cmd) for cmd, stdin in joins)
    events = " ".join(str(e.data) + e.message for e in (await owner_db.execute(
        select(JobEvent))).scalars())
    assert "abcdef.0123456789abcdef" not in events and "not-a-real-token" not in events

    # nodes are operated through the cluster only
    r = await client.post(f"/api/v1/instances/{nodes[0].id}/stop", headers=h)
    assert r.status_code == 409 and "Kubernetes cluster" in r.text
    r = await client.request("DELETE", f"/api/v1/instances/{nodes[0].id}",
                             json={"confirm": nodes[0].name}, headers=h)
    assert r.status_code == 409

    # kubeconfig: k8s:admin (tenant admin yes, USER no), audited
    url = f"/api/v1/kubernetes/clusters/{c['id']}/kubeconfig"
    r = await client.get(url, headers=h)
    assert r.status_code == 200 and "203.0.113.2:6443" in r.text
    assert r.headers["cache-control"] == "no-store"
    assert (await client.get(url, headers=await env.h("carol", env.acme))).status_code == 403
    assert await owner_db.scalar(
        select(AuditLog.id).where(AuditLog.action == "K8S_KUBECONFIG_DOWNLOAD")
    )

    # another client sees nothing
    eve = await env.h("eve", env.globex)
    assert (await client.get("/api/v1/kubernetes/clusters", headers=eve)).json() == []
    assert (await client.get(url, headers=eve)).status_code == 404

    # delete: confirm by name, nodes destroyed, cluster gone
    durl = f"/api/v1/kubernetes/clusters/{c['id']}"
    assert (await client.request("DELETE", durl, json={"confirm": "x"},
                                 headers=h)).status_code == 422
    r = await client.request("DELETE", durl, json={"confirm": "lab"}, headers=h)
    assert r.status_code == 202, r.text
    await env.settle(owner_db)
    assert (await client.get("/api/v1/kubernetes/clusters", headers=h)).json() == []
    owner_db.expire_all()
    states = {n.state for n in (await owner_db.execute(
        select(Instance).where(Instance.name.like("lab-%")))).scalars()}
    assert states == {"deleted"}
    assert not any(k in fake.instances for k in by_vmid.values())


async def test_validation_quota_and_permissions(client, env, owner_db):
    h = await env.h("alice", env.acme)
    post = lambda body, who=h: client.post("/api/v1/kubernetes/clusters", json=body, headers=who)  # noqa: E731
    body = env.body()
    # wrong number of node addresses
    bad = env.body(workers=[{**body["workers"][0], "count": 3}])
    assert (await post(bad)).status_code == 422
    # LB outside the nodes' subnet / bridge reserved to platform admins
    r = await post(env.body(network={**body["network"], "lb_ip": "198.51.100.1"}))
    assert r.status_code == 422
    r = await post(env.body(network={**body["network"], "bridge": "vnet100"}))
    assert r.status_code == 422
    # control plane too small for kubeadm
    assert (await post(env.body(control_plane={"vcpus": 1, "memory_mb": 2048,
                                               "disk_gb": 40}))).status_code == 422
    # USER may not create clusters
    assert (await post(body, await env.h("carol", env.acme))).status_code == 403
    # quota counts every node at once (default instance quota is 10)
    many = env.body(
        workers=[{**body["workers"][0], "count": 10}],
        network={**body["network"], "node_ipv4": [
            {"address": f"203.0.113.{i}/27", "gateway": "203.0.113.30"} for i in range(1, 12)
        ], "lb_ip": "203.0.113.20"},
    )
    r = await post(many)
    assert r.status_code == 409 and "quota" in r.text.lower()
    assert await owner_db.scalar(select(K8sCluster.id)) is None


async def test_failed_step_marks_cluster_error_and_admin_can_destroy(client, env, fake, owner_db):
    def broken(vmid, command, stdin):
        if script_of(command) == "install-addons":
            return 1, "", "helm: timed out waiting for cilium"
        return fake_ok(command)

    def fake_ok(command):
        name = script_of(command)
        if name == "join-command":
            return 0, JOIN + "\n", ""
        return 0, "ok", ""

    fake.exec_handler = broken
    root = await env.h("root")
    r = await client.post("/api/v1/admin/kubernetes/clusters/provision", headers=root,
                          json={**env.body(), "tenant_id": str(env.acme.id)})
    assert r.status_code == 202, r.text
    await env.settle(owner_db)
    [c] = (await client.get("/api/v1/admin/kubernetes/clusters", headers=root)).json()
    assert c["managed"]["state"] == "error"
    assert "addons failed on lab-cp-1" in c["managed"]["state_message"]
    assert "timed out waiting for cilium" in c["managed"]["state_message"]
    assert c["tenant_name"] == env.acme.name

    # the old manual delete refuses; destroy removes VMs and the cluster
    assert (await client.delete(f"/api/v1/admin/kubernetes/clusters/{c['id']}",
                                headers=root)).status_code == 409
    r = await client.post(f"/api/v1/admin/kubernetes/clusters/{c['id']}/destroy",
                          json={"confirm": "lab"}, headers=root)
    assert r.status_code == 202, r.text
    await env.settle(owner_db)
    assert (await client.get("/api/v1/admin/kubernetes/clusters", headers=root)).json() == []
