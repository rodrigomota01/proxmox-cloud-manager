"""Legacy Kubernetes clusters: sync from the MySQL table, admin-only views, kubeconfig."""

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import func, select, text

from app.audit.models import AuditLog
from app.k8s.models import K8sCluster
from app.k8s.source import K8sRow
from app.k8s.sync import sync_k8s
from tests.integration.factories import (
    PASSWORD,
    add_member,
    grant_platform,
    make_tenant,
    make_user,
)
from tests.k8s_fixtures import kubeconfig_b64

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


@dataclass
class FakeK8sSource:
    rows: list[K8sRow] = field(default_factory=list)

    async def fetch(self) -> list[K8sRow]:
        return list(self.rows)


def row(id_, client, role, *, config=None, expires=None, dns=None):
    return K8sRow(id=id_, client=client, host=1000 + id_, role=role, certs_expire_on=expires,
                  api_server=dns, config=config, modified_at=datetime(2026, 9, 1, tzinfo=UTC))


async def _login(client, email):
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
async def env(app, client, owner_db, registry):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    root, alice = (await make_user(owner_db, "root@example.com"),
                   await make_user(owner_db, "alice@example.com"))
    await grant_platform(owner_db, root, "PLATFORM_ADMIN")
    await add_member(owner_db, await make_tenant(owner_db, "acme"), alice, "TENANT_ADMIN")
    today = datetime.now(UTC).date()
    soon = datetime.combine(today + timedelta(days=5), datetime.min.time(), UTC)
    source = FakeK8sSource([
        row(1, "prod", "load-balancer"),
        row(2, "prod", "control-plane", dns="prod.k8s.example", expires=soon.date(),
            config=kubeconfig_b64("https://prod.k8s.example:6443", soon)),
        row(3, "prod", "worker"),
        # the table says 2099, the certificate expired last month
        row(4, "drift", "control-plane", expires=date(2099, 1, 1),
            config=kubeconfig_b64("https://10.0.0.1:6443", soon - timedelta(days=40))),
        row(5, "broken", "control-plane", config="not-a-kubeconfig"),
        row(6, "bare", "worker"),
    ])
    return {"root": await _login(client, "root@example.com"),
            "alice": await _login(client, "alice@example.com"),
            "source": source, "registry": registry}


async def _sync(app, env):
    return await sync_k8s(app.state.sessionmaker, env["source"], env["registry"].secrets)


async def test_sync_groups_nodes_and_flags_expiry(client, app, env):
    assert await _sync(app, env) == {"clusters": 4, "nodes": 6, "removed": 0}
    r = await client.get("/api/v1/admin/kubernetes/clusters", headers=env["root"])
    assert r.status_code == 200, r.text
    by = {c["name"]: c for c in r.json()}
    assert [c["name"] for c in r.json()][:2] == ["drift", "prod"]  # soonest first

    prod = by["prod"]
    assert prod["api_server"] == "prod.k8s.example"
    assert prod["server_url"] == "https://prod.k8s.example:6443"
    assert [n["role"] for n in prod["nodes"]] == ["control-plane", "load-balancer", "worker"]
    assert prod["days_left"] == 5 and prod["status"] == "critical"
    assert prod["has_kubeconfig"] and not prod["dates_differ"]

    drift = by["drift"]
    assert drift["certs_expire_on"] == "2099-01-01" and drift["dates_differ"]
    assert drift["status"] == "expired" and drift["days_left"] == -35

    assert by["broken"]["kubeconfig_error"].startswith("config is not")
    assert not by["broken"]["has_kubeconfig"]
    assert by["bare"]["status"] == "unknown"


async def test_kubeconfig_is_sealed_and_download_is_audited(client, app, env, owner_db):
    await _sync(app, env)
    cluster = (await owner_db.execute(
        select(K8sCluster).where(K8sCluster.name == "prod")
    )).scalar_one()
    assert b"client-key-data" not in cluster.kubeconfig_ciphertext
    sealed_before = cluster.kubeconfig_ciphertext

    await _sync(app, env)  # unchanged kubeconfig: not re-sealed
    await owner_db.refresh(cluster)
    assert cluster.kubeconfig_ciphertext == sealed_before

    r = await client.get(f"/api/v1/admin/kubernetes/clusters/{cluster.id}/kubeconfig",
                         headers=env["root"])
    assert r.status_code == 200
    assert "client-key-data" in r.text and "https://prod.k8s.example:6443" in r.text
    assert r.headers["cache-control"] == "no-store"
    assert 'filename="prod.kubeconfig"' in r.headers["content-disposition"]
    audited = await owner_db.scalar(
        select(func.count()).select_from(AuditLog).where(
            AuditLog.action == "K8S_KUBECONFIG_DOWNLOAD", AuditLog.resource_id == str(cluster.id)
        )
    )
    assert audited == 1

    broken = (await owner_db.execute(
        select(K8sCluster).where(K8sCluster.name == "broken")
    )).scalar_one()
    r = await client.get(f"/api/v1/admin/kubernetes/clusters/{broken.id}/kubeconfig",
                         headers=env["root"])
    assert r.status_code == 409


async def test_only_platform_admins_see_clusters(client, app, env, owner_db):
    await _sync(app, env)
    cid = await owner_db.scalar(select(K8sCluster.id).limit(1))
    for path in ("/api/v1/admin/kubernetes/clusters",
                 f"/api/v1/admin/kubernetes/clusters/{cid}/kubeconfig"):
        assert (await client.get(path, headers=env["alice"])).status_code == 403
        assert (await client.get(path)).status_code == 401
    # RLS: outside platform scope the table is empty, whatever the route
    async with app.state.sessionmaker() as db, db.begin():
        assert await db.scalar(select(func.count()).select_from(K8sCluster)) == 0
        await db.execute(text("SELECT set_config('app.platform_scope', 'on', true)"))
        assert await db.scalar(select(func.count()).select_from(K8sCluster)) == 4


async def test_clusters_removed_at_the_source_leave_the_copy(client, app, env):
    await _sync(app, env)
    env["source"].rows = [r for r in env["source"].rows if r.client != "bare"]
    assert (await _sync(app, env))["removed"] == 1
    names = {c["name"] for c in
             (await client.get("/api/v1/admin/kubernetes/clusters", headers=env["root"])).json()}
    assert names == {"prod", "drift", "broken"}


# --- collection through the cluster API and manual clusters (ADR-0017) ----------------


def _reader_factory(apis):
    """Per kubeconfig text: the fake API of the cluster whose server it names."""
    from app.k8s.client import K8sApiError
    from tests.k8s_api import FakeReader

    def factory(text):
        for server, api in apis.items():
            if server in text:
                return FakeReader(api)
        raise K8sApiError("ConnectError: connection refused")
    return factory


async def test_collection_feeds_list_and_detail(client, app, env):
    from app.k8s.collect import poll_clusters
    from tests.k8s_api import healthy_cluster

    await _sync(app, env)
    counts = await poll_clusters(
        app.state.sessionmaker, env["registry"].secrets,
        reader_factory=_reader_factory({"prod.k8s.example": healthy_cluster()}),
    )
    assert counts == {"warning": 1, "unreachable": 1}  # prod read; drift refuses

    listed = {c["name"]: c for c in (await client.get(
        "/api/v1/admin/kubernetes/clusters", headers=env["root"])).json()}
    prod = listed["prod"]["snapshot"]
    assert prod["health"] == "warning" and prod["nodes"] == 2 and prod["pods_problem"] == 2
    assert prod["metrics"] and prod["cpu_usage"] == pytest.approx(2.0)
    drift = listed["drift"]["snapshot"]
    assert drift["health"] == "unreachable" and "connection refused" in drift["error"]
    assert drift["ok_at"] is None
    assert listed["bare"]["snapshot"] is None  # no kubeconfig: never collected

    r = await client.get(f"/api/v1/admin/kubernetes/clusters/{listed['prod']['id']}",
                         headers=env["root"])
    assert r.status_code == 200, r.text
    d = r.json()
    assert {n["name"] for n in d["k8s_nodes"]} == {"n1", "n2"}
    assert {n["name"] for n in d["namespaces"]} == {"shop", "jobs", "kube-system"}
    assert d["ingresses"][0]["ingress_class"] == "nginx"
    assert d["pods"][0]["problem"] and len(d["workloads"]) == 3

    # unreachable later: the last good picture stays, with its age
    await poll_clusters(app.state.sessionmaker, env["registry"].secrets,
                        reader_factory=_reader_factory({}))
    d = (await client.get(f"/api/v1/admin/kubernetes/clusters/{listed['prod']['id']}",
                          headers=env["root"])).json()
    assert d["snapshot"]["health"] == "unreachable" and d["snapshot"]["nodes"] == 2
    assert d["snapshot"]["ok_at"] is not None and len(d["k8s_nodes"]) == 2


async def test_manual_cluster_lifecycle(client, app, env, owner_db):
    import base64

    await _sync(app, env)
    root = env["root"]
    yaml_text = base64.b64decode(kubeconfig_b64(
        "https://pluxee.example:6443", datetime(2027, 6, 1, tzinfo=UTC))).decode()
    r = await client.post("/api/v1/admin/kubernetes/clusters", headers=root,
                          json={"name": "pluxee-prod", "kubeconfig": yaml_text})
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["source"] == "manual" and c["has_kubeconfig"]
    assert c["server_url"] == "https://pluxee.example:6443"
    assert c["cert_expires_at"].startswith("2027-06-01") and c["days_left"] is not None

    # duplicate name, invalid kubeconfig
    again = await client.post("/api/v1/admin/kubernetes/clusters", headers=root,
                              json={"name": "pluxee-prod", "kubeconfig": yaml_text})
    assert again.status_code == 409
    bad = await client.post("/api/v1/admin/kubernetes/clusters", headers=root,
                            json={"name": "x", "kubeconfig": "kind: Pod\nmetadata: {}\n"})
    assert bad.status_code == 422

    # the table sync leaves manual clusters alone
    await _sync(app, env)
    names = {x["name"] for x in (await client.get(
        "/api/v1/admin/kubernetes/clusters", headers=root)).json()}
    assert "pluxee-prod" in names

    # replace the kubeconfig (base64 accepted too), then remove the registration
    new = kubeconfig_b64("https://pluxee2.example:6443", datetime(2028, 1, 1, tzinfo=UTC))
    r = await client.put(f"/api/v1/admin/kubernetes/clusters/{c['id']}/kubeconfig",
                         headers=root, json={"kubeconfig": new})
    assert r.status_code == 200 and r.json()["server_url"] == "https://pluxee2.example:6443"
    assert (await client.delete(f"/api/v1/admin/kubernetes/clusters/{c['id']}",
                                headers=root)).status_code == 204
    actions = set((await owner_db.execute(select(AuditLog.action).where(
        AuditLog.resource_id == c["id"]))).scalars())
    assert actions == {"K8S_CLUSTER_CREATE", "K8S_KUBECONFIG_REPLACE", "K8S_CLUSTER_DELETE"}

    # clusters from the table are managed there
    prod_id = await owner_db.scalar(select(K8sCluster.id).where(K8sCluster.name == "prod"))
    assert (await client.delete(f"/api/v1/admin/kubernetes/clusters/{prod_id}",
                                headers=root)).status_code == 409
    assert (await client.put(f"/api/v1/admin/kubernetes/clusters/{prod_id}/kubeconfig",
                             headers=root, json={"kubeconfig": new})).status_code == 409


async def test_new_routes_are_platform_only(client, app, env, owner_db):
    await _sync(app, env)
    cid = await owner_db.scalar(select(K8sCluster.id).limit(1))
    alice = env["alice"]
    assert (await client.get(f"/api/v1/admin/kubernetes/clusters/{cid}",
                             headers=alice)).status_code == 403
    assert (await client.post("/api/v1/admin/kubernetes/clusters", headers=alice,
                              json={"name": "x", "kubeconfig": "a" * 40})).status_code == 403
    assert (await client.delete(f"/api/v1/admin/kubernetes/clusters/{cid}",
                                headers=alice)).status_code == 403


async def test_snapshot_from_before_httproutes_still_renders(client, app, env, owner_db):
    from app.k8s.models import K8sSnapshot

    await _sync(app, env)
    cid = await owner_db.scalar(select(K8sCluster.id).where(K8sCluster.name == "prod"))
    owner_db.add(K8sSnapshot(
        cluster_id=cid, health="healthy", reasons=[], collected_at=datetime.now(UTC),
        summary={"nodes": 1, "nodes_ready": 1},  # no httproutes / gateway_api yet
        data={"namespaces": [{"name": "shop", "phase": "Active", "created_at": None,
                              "pods": 1, "running": 1, "problems": 0, "workloads": 1,
                              "services": 0, "ingresses": 0, "cpu_usage": None,
                              "mem_usage": None, "cpu_requests": 0, "mem_requests": 0}]},
    ))
    await owner_db.commit()
    r = await client.get(f"/api/v1/admin/kubernetes/clusters/{cid}", headers=env["root"])
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["httproutes"] == [] and d["namespaces"][0]["httproutes"] == 0
    assert d["snapshot"]["httproutes"] == 0 and d["snapshot"]["gateway_api"] is False
