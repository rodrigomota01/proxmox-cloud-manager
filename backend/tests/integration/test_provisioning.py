"""Phase 2a: images, SSH keys, quotas, create from template (cloud-init) and delete."""

import asyncio
import base64
import hashlib
import os
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import select

from app.audit.models import AuditLog
from app.compute.models import Instance
from app.infra.secrets import LocalKek
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.models import Job, JobEvent
from app.jobs.queue import run_one
from app.providers.base import InstanceSpec, ProviderError, ProviderRef, StaticIPv4
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
NET = {"address": "203.0.113.10/28", "gateway": "203.0.113.14", "dns": ["1.1.1.1"]}


def new_public_key(comment: str = "user@laptop") -> tuple[str, str]:
    """(OpenSSH public key line, SHA256 fingerprint as ssh-keygen prints it)."""
    pub = Ed25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
    ).decode()
    blob = base64.b64decode(pub.split()[1])
    fp = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    return f"{pub} {comment}", fp


@pytest.fixture
def fake() -> FakeProvider:
    f = FakeProvider()
    f.add_node("tagima")
    f.add_template(9998, "debian13-base", node="tagima", disk_gb=32)
    f.add_template(9997, "no-cloudinit", node="tagima", cloudinit=False)
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

    async def drain(self) -> None:
        state = self.app.state
        while await run_one(state.sessionmaker, state.providers, "test-worker"):
            pass

    async def add_key(self, who: str) -> tuple[str, str]:
        line, _ = new_public_key(f"{who}@laptop")
        r = await self.client.post(
            "/api/v1/ssh-keys", json={"name": "laptop", "public_key": line},
            headers=await self.h(who),
        )
        assert r.status_code == 201, r.text
        return r.json()["id"], line

    def body(self, key_id: str, **over) -> dict:
        return {
            "project_id": str(self.web.id), "name": "web-01", "image_id": self.image,
            "vcpus": 2, "memory_mb": 2048, "root_disk_gb": 40, "ssh_key_ids": [key_id],
            "ipv4": NET, **over,
        }

    async def create(self, who: str, body: dict, tenant=None):
        return await self.client.post(
            "/api/v1/instances", json=body, headers=await self.h(who, tenant or self.acme)
        )


@pytest.fixture
async def env(owner_db, client, app, prov_registry):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    e = Env(client, app)
    e.acme, e.globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    e.web = await make_project(owner_db, e.acme, "web")
    e.api = await make_project(owner_db, e.globex, "api")
    for name in ("root", "alice", "olga", "carol", "dave", "eve"):
        setattr(e, name, await make_user(owner_db, f"{name}@example.com"))
    await grant_platform(owner_db, e.root, "PLATFORM_ADMIN")
    await add_member(owner_db, e.acme, e.alice, "TENANT_ADMIN")
    await add_member(owner_db, e.acme, e.olga, "OPERATOR")
    await add_member(owner_db, e.acme, e.carol, "USER", e.web)
    await add_member(owner_db, e.acme, e.dave, "READ_ONLY", e.web)
    await add_member(owner_db, e.globex, e.eve, "TENANT_ADMIN")

    root = await e.h("root")
    r = await client.post(
        "/api/v1/admin/clusters",
        json={"name": "lab", "api_url": "https://pve.test:8006", "pool": "cm-lab"},
        headers=root,
    )
    e.cluster = r.json()["id"]
    await client.put(
        f"/api/v1/admin/clusters/{e.cluster}/credentials",
        json={"token_id": "cloudmgr@pve!cm", "secret": SECRET}, headers=root,
    )
    r = await client.post(
        "/api/v1/admin/images",
        json={"cluster_id": e.cluster, "template_vmid": 9998, "name": "Debian 13"},
        headers=root,
    )
    assert r.status_code == 201, r.text
    e.image = r.json()["id"]
    return e


# --- images ----------------------------------------------------------------------------


async def test_admin_registers_templates_as_images(client, env):
    root = await env.h("root")
    templates = (await client.get(f"/api/v1/admin/clusters/{env.cluster}/templates",
                                  headers=root)).json()
    assert {t["vmid"]: t["image_id"] is not None for t in templates} == {9997: False, 9998: True}

    base = {"cluster_id": env.cluster, "name": "x"}
    dup = await client.post("/api/v1/admin/images", json={**base, "template_vmid": 9998},
                            headers=root)
    assert dup.status_code == 409
    no_ci = await client.post("/api/v1/admin/images", json={**base, "template_vmid": 9997},
                              headers=root)
    assert no_ci.status_code == 422 and "cloud-init" in no_ci.text
    missing = await client.post("/api/v1/admin/images", json={**base, "template_vmid": 1201},
                                headers=root)
    assert missing.status_code == 422
    tenant_admin = await client.post(
        "/api/v1/admin/images", json={**base, "template_vmid": 9997},
        headers=await env.h("alice"),
    )
    assert tenant_admin.status_code == 403


async def test_image_visibility(client, env, fake):
    fake.add_template(9996, "acme-golden", node="tagima")
    await client.post(
        "/api/v1/admin/images",
        json={"cluster_id": env.cluster, "template_vmid": 9996, "name": "ACME golden",
              "visibility": "tenant", "tenant_id": str(env.acme.id)},
        headers=await env.h("root"),
    )
    acme = {i["name"] for i in (await client.get(
        "/api/v1/images", headers=await env.h("alice", env.acme))).json()}
    globex = {i["name"] for i in (await client.get(
        "/api/v1/images", headers=await env.h("eve", env.globex))).json()}
    assert acme == {"Debian 13", "ACME golden"} and globex == {"Debian 13"}
    item = (await client.get("/api/v1/images", headers=await env.h("eve", env.globex))).json()[0]
    assert "template_vmid" not in item and "cluster_id" not in item


# --- SSH keys --------------------------------------------------------------------------


async def test_ssh_keys(client, env):
    line, fp = new_public_key()
    h = await env.h("carol")
    r = await client.post("/api/v1/ssh-keys", json={"name": "mac", "public_key": line}, headers=h)
    assert r.status_code == 201 and r.json()["fingerprint"] == fp
    dup = await client.post("/api/v1/ssh-keys", json={"name": "again", "public_key": line},
                            headers=h)
    assert dup.status_code == 409
    for bad in ("-----BEGIN OPENSSH PRIVATE KEY-----\nabc", "ssh-ed25519 !!notbase64",
                "ssh-dss AAAAB3NzaC1kc3M=", "hello"):
        r = await client.post("/api/v1/ssh-keys", json={"name": "x", "public_key": bad},
                              headers=h)
        assert r.status_code == 422, bad
    key_id = (await client.get("/api/v1/ssh-keys", headers=h)).json()[0]["id"]
    # other users neither see nor delete it
    assert (await client.get("/api/v1/ssh-keys", headers=await env.h("alice"))).json() == []
    assert (await client.delete(f"/api/v1/ssh-keys/{key_id}",
                                headers=await env.h("alice"))).status_code == 404
    assert (await client.delete(f"/api/v1/ssh-keys/{key_id}", headers=h)).status_code == 204


# --- create ----------------------------------------------------------------------------


async def test_create_instance_from_template(client, env, fake, owner_db):
    key_id, key_line = await env.add_key("carol")
    fake.hidden_vmids = {10000}  # used by a guest the token cannot see
    r = await env.create("carol", env.body(key_id))
    assert r.status_code == 202, r.text
    inst, job = r.json()["instance"], r.json()["job"]
    assert inst["state"] == "provisioning" and inst["ipv4"] == "203.0.113.10/28"
    assert "vmid" not in inst and "ssh_keys" in job["payload"]

    await env.drain()
    h = await env.h("carol", env.acme)
    detail = (await client.get(f"/api/v1/jobs/{job['id']}", headers=h)).json()
    assert detail["status"] == "succeeded", detail
    kinds = [e["kind"] for e in detail["events"]]
    assert kinds == ["started", "allocated", "provider_task", "configured",
                     "provider_task", "succeeded"]

    created = (await client.get(f"/api/v1/instances/{inst['id']}", headers=h)).json()
    assert created["state"] == "active" and created["power_state"] == "running"
    row = await owner_db.get(Instance, inst["id"])
    assert row.provider_ref["vmid"] == 10001 and row.provider_ref["pool"] == "cm-lab"

    spec = fake.configured["10001"]
    # access comes only from the request: never the template's keys/password/IP
    assert spec.ssh_keys == (key_line,) and spec.user == "debian"
    assert spec.ipv4.address == "203.0.113.10/28" and spec.ipv4.dns == ("1.1.1.1",)
    assert "cm-managed" in spec.tags
    assert fake.instances["10001"].disk_gb == 40 and fake.instances["10001"].vcpus == 2


@pytest.mark.parametrize(
    ("override", "field"),
    [
        ({"root_disk_gb": 10}, "root_disk_gb"),  # smaller than the template
        ({"ipv4": {**NET, "gateway": "198.51.100.1"}}, "ipv4"),
        ({"ipv4": {**NET, "address": "203.0.113.0/28"}}, "ipv4"),  # network address
        ({"ipv4": {**NET, "address": "203.0.113.10"}}, "ipv4"),  # no prefix
        ({"name": "Web_01"}, "name"),
        ({"memory_mb": 1000}, "memory_mb"),
        ({"vcpus": 0}, "vcpus"),
    ],
)
async def test_create_validation(env, override, field):
    key_id, _ = await env.add_key("carol")
    r = await env.create("carol", env.body(key_id, **override))
    assert r.status_code == 422, r.text
    assert any(field in e["field"] for e in r.json()["errors"])


async def test_create_rejects_someone_elses_key(env):
    alice_key, _ = await env.add_key("alice")
    r = await env.create("carol", env.body(alice_key))
    assert r.status_code == 422 and "ssh_key_ids" in r.text


@pytest.mark.parametrize(("who", "expected"), [("olga", 403), ("dave", 403), ("alice", 202)])
async def test_create_rbac(env, who, expected):
    key_id, _ = await env.add_key(who)
    assert (await env.create(who, env.body(key_id))).status_code == expected


async def test_create_cross_tenant(env):
    key_id, _ = await env.add_key("eve")
    # eve names acme's project from her own tenant
    assert (await env.create("eve", env.body(key_id), tenant=env.globex)).status_code == 404
    assert (await env.create("eve", env.body(key_id), tenant=env.acme)).status_code == 404


async def test_create_needs_target_pool(client, env):
    await client.patch(f"/api/v1/admin/clusters/{env.cluster}", json={"pool": None},
                       headers=await env.h("root"))
    key_id, _ = await env.add_key("carol")
    r = await env.create("carol", env.body(key_id))
    assert r.status_code == 409 and "pool" in r.text


async def test_duplicate_ip_is_refused_and_freed_on_delete(client, env):
    key_id, _ = await env.add_key("alice")
    first = await env.create("alice", env.body(key_id, name="a"))
    assert first.status_code == 202
    dup = await env.create("alice", env.body(key_id, name="b"))
    assert dup.status_code == 409 and "203.0.113.10" in dup.text
    await env.drain()
    iid = first.json()["instance"]["id"]
    r = await client.request("DELETE", f"/api/v1/instances/{iid}", json={"confirm": "a"},
                             headers=await env.h("alice", env.acme))
    assert r.status_code == 202
    await env.drain()
    assert (await env.create("alice", env.body(key_id, name="b"))).status_code == 202


# --- quota -----------------------------------------------------------------------------


async def test_quota_is_enforced_and_reported(client, env):
    await client.put(f"/api/v1/admin/tenants/{env.acme.id}/quotas",
                     json={"instances": 1, "vcpus": 4}, headers=await env.h("root"))
    key_id, _ = await env.add_key("alice")
    too_big = await env.create("alice", env.body(key_id, vcpus=8))
    assert too_big.status_code == 409 and too_big.json()["code"] == "QUOTA_EXCEEDED"
    assert too_big.json()["errors"][0]["field"] == "vcpus"
    assert (await env.create("alice", env.body(key_id))).status_code == 202
    other_ip = {**NET, "address": "203.0.113.11/28"}
    second = await env.create("alice", env.body(key_id, name="b", ipv4=other_ip))
    assert second.status_code == 409 and second.json()["errors"][0]["field"] == "instances"

    report = {q["resource"]: q for q in (await client.get(
        "/api/v1/quotas", headers=await env.h("alice", env.acme))).json()}
    assert report["instances"] == {"resource": "instances", "limit": 1, "used": 1, "available": 0}
    assert report["vcpus"]["used"] == 2


async def test_concurrent_creations_cannot_both_take_the_last_slot(client, env):
    await client.put(f"/api/v1/admin/tenants/{env.acme.id}/quotas", json={"instances": 1},
                     headers=await env.h("root"))
    key_id, _ = await env.add_key("alice")
    bodies = [env.body(key_id, name=f"n{i}", ipv4={**NET, "address": f"203.0.113.{i}/28"})
              for i in (2, 3)]
    results = await asyncio.gather(*(env.create("alice", b) for b in bodies))
    assert sorted(r.status_code for r in results) == [202, 409]


# --- failures --------------------------------------------------------------------------


async def test_failed_creation_is_rolled_back(client, env, fake, owner_db):
    fake.fail_steps = {"configure"}
    key_id, _ = await env.add_key("alice")
    r = await env.create("alice", env.body(key_id))
    job_id, iid = r.json()["job"]["id"], r.json()["instance"]["id"]
    await env.drain()  # ProviderError is final -> failure hook
    h = await env.h("alice", env.acme)
    job = (await client.get(f"/api/v1/jobs/{job_id}", headers=h)).json()
    assert job["status"] == "failed" and job["error_code"] == "PROVIDER_ERROR"
    assert "compensated" in [e["kind"] for e in job["events"]]
    assert fake.instances == {}  # the cloned guest was destroyed
    assert (await client.get(f"/api/v1/instances/{iid}", headers=h)).status_code == 404
    quotas = (await client.get("/api/v1/quotas", headers=h)).json()
    usage = {q["resource"]: q["used"] for q in quotas}
    assert usage["instances"] == 0
    actions = (await owner_db.execute(select(AuditLog.action))).scalars().all()
    assert "INSTANCE_CREATE_FAILED" in actions


async def test_compensation_never_deletes_a_guest_that_is_not_ours(env, fake, owner_db):
    original = fake.configure_instance

    async def renamed_then_fail(ref, spec):
        await original(ref, spec)
        obs = fake.instances[ref.key]
        fake.instances[ref.key] = obs.__class__(**{**obs.__dict__, "name": "someone-else"})
        raise ProviderError("boom")

    fake.configure_instance = renamed_then_fail  # type: ignore[method-assign]
    key_id, _ = await env.add_key("alice")
    job_id = (await env.create("alice", env.body(key_id))).json()["job"]["id"]
    await env.drain()
    assert list(fake.instances) == ["10000"]  # left alone
    events = (await owner_db.execute(
        select(JobEvent.kind, JobEvent.message).where(JobEvent.job_id == job_id)
    )).all()
    assert any(k == "compensation_failed" and "not deleting" in m for k, m in events)


async def test_create_resumes_after_a_worker_crash(env, fake, owner_db):
    key_id, _ = await env.add_key("alice")
    r = await env.create("alice", env.body(key_id))
    job_id, iid = r.json()["job"]["id"], r.json()["instance"]["id"]
    # first worker: allocated + cloned, then died before configuring
    inst = await owner_db.get(Instance, iid)
    inst.provider_ref = {"vmid": 10000, "node": "tagima", "type": "qemu", "pool": "cm-lab"}
    template = fake.templates["9998"].ref
    ip = StaticIPv4(NET["address"], NET["gateway"])
    spec = InstanceSpec("web-01", 2, 2048, 40, "debian", (), ip)
    op = await fake.clone_template(template, ProviderRef(inst.provider_ref), spec)
    fake.calls.clear()
    job = await owner_db.get(Job, job_id)
    owner_db.add(JobEvent(job_id=job.id, tenant_id=job.tenant_id, kind="provider_task",
                          data={"step": "clone", "operation": op.data}))
    job.status, job.attempts = "running", 1
    job.locked_until = datetime.now(UTC) - timedelta(minutes=1)
    await owner_db.commit()

    await env.drain()
    await owner_db.refresh(job)
    assert job.status == "succeeded"
    assert ("10000", "clone") not in fake.calls  # not cloned twice


# --- delete ----------------------------------------------------------------------------


async def test_delete_instance(client, env, fake, owner_db):
    key_id, _ = await env.add_key("carol")
    iid = (await env.create("carol", env.body(key_id))).json()["instance"]["id"]
    await env.drain()
    h = await env.h("carol", env.acme)
    url = f"/api/v1/instances/{iid}"
    wrong = await client.request("DELETE", url, json={"confirm": "nope"}, headers=h)
    assert wrong.status_code == 422
    dave = await client.request("DELETE", url, json={"confirm": "web-01"},
                                headers=await env.h("dave", env.acme))
    assert dave.status_code == 403
    r = await client.request("DELETE", url, json={"confirm": "web-01"}, headers=h)
    assert r.status_code == 202
    again = await client.request("DELETE", url, json={"confirm": "web-01"}, headers=h)
    assert again.status_code == 409  # already deleting
    await env.drain()
    assert fake.instances == {}
    assert ("10000", "delete") in fake.calls and ("10000", "stop") in fake.calls
    assert (await client.get(url, headers=h)).status_code == 404


async def test_delete_when_guest_already_gone(client, env, fake):
    key_id, _ = await env.add_key("carol")
    iid = (await env.create("carol", env.body(key_id))).json()["instance"]["id"]
    await env.drain()
    fake.instances.clear()  # removed by hand in Proxmox
    h = await env.h("carol", env.acme)
    job = (await client.request("DELETE", f"/api/v1/instances/{iid}",
                                json={"confirm": "web-01"}, headers=h)).json()["job"]
    await env.drain()
    status = (await client.get(f"/api/v1/jobs/{job['id']}", headers=h)).json()["status"]
    assert status == "succeeded"
