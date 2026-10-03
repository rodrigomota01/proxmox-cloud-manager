"""Clusters, credentials, inventory sync, discovered instances and adoption."""

import logging
from dataclasses import replace

import pytest
from sqlalchemy import func, select

from app.compute.models import Instance
from app.db.session import set_tenant_scope
from app.inventory.models import ProviderCluster, ProviderCredential
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.queue import run_one
from app.providers.registry import ProviderRegistry
from app.worker.main import reconcile_all
from tests.integration.factories import (
    PASSWORD,
    add_member,
    grant_platform,
    make_project,
    make_tenant,
    make_user,
)

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

SECRET = "8c1b7f2e-5a4d-4e8b-9f3c-2d6a1b0e7c55"
CLUSTER = {"name": "lab", "api_url": "https://hv08.example.test:8006"}
CREDS = {"token_id": "cloudmgr@pve!cm", "secret": SECRET}


async def _login(client, email):
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
async def ctx(owner_db, client, app, registry):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    root = await make_user(owner_db, "root@example.com")
    await grant_platform(owner_db, root, "PLATFORM_ADMIN")
    alice = await make_user(owner_db, "alice@example.com")
    acme, globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    web = await make_project(owner_db, acme, "web")
    api = await make_project(owner_db, globex, "api")
    await add_member(owner_db, acme, alice, "TENANT_ADMIN")
    return {
        "root": await _login(client, "root@example.com"),
        "alice": await _login(client, "alice@example.com"),
        "acme": acme, "globex": globex, "web": web, "api": api,
    }


async def _cluster_with_creds(client, root) -> str:
    r = await client.post("/api/v1/admin/clusters", json=CLUSTER, headers=root)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    r = await client.put(f"/api/v1/admin/clusters/{cid}/credentials", json=CREDS, headers=root)
    assert r.status_code == 200, r.text
    return cid


async def _sync(client, root, cid) -> dict:
    """POST /sync (202 + job), run the queue like the worker would, return the outcome."""
    r = await client.post(f"/api/v1/admin/clusters/{cid}/sync", headers=root)
    assert r.status_code == 202, r.text
    job_id = r.json()["job"]["id"]
    assert r.headers["location"] == f"/api/v1/admin/jobs/{job_id}"
    app = client._transport.app
    while await run_one(app.state.sessionmaker, app.state.providers, "test-worker"):
        pass
    job = (await client.get(f"/api/v1/admin/jobs/{job_id}", headers=root)).json()
    return {
        "status": job["status"],
        "stats": (job["result"] or {}).get("stats", {}),
        "error": job["error_message"],
    }


# --- access ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", "/api/v1/admin/clusters"), ("POST", "/api/v1/admin/clusters"),
     ("GET", "/api/v1/admin/nodes"), ("GET", "/api/v1/admin/instances"),
     ("GET", "/api/v1/admin/storage"), ("GET", "/api/v1/admin/tenants")],
)
async def test_admin_requires_platform_role(client, ctx, method, path):
    r = await client.request(method, path, json=CLUSTER, headers=ctx["alice"])
    assert r.status_code == 403
    assert (await client.request(method, path, json=CLUSTER)).status_code == 401


# --- clusters and credentials ----------------------------------------------------------


async def test_credentials_are_write_only_and_encrypted(client, ctx, registry, owner_db, caplog):
    caplog.set_level(logging.DEBUG)
    cid = await _cluster_with_creds(client, ctx["root"])
    responses = [
        await client.get(f"/api/v1/admin/clusters/{cid}", headers=ctx["root"]),
        await client.get("/api/v1/admin/clusters", headers=ctx["root"]),
        await client.put(f"/api/v1/admin/clusters/{cid}/credentials", json=CREDS,
                         headers=ctx["root"]),
        await client.post(f"/api/v1/admin/clusters/{cid}/test", headers=ctx["root"]),
    ]
    for r in responses:
        assert SECRET not in r.text
    body = responses[0].json()
    assert body["has_credentials"] and body["token_id"] == "cloudmgr@pve!cm"

    cred = await owner_db.scalar(select(ProviderCredential))
    assert SECRET.encode() not in cred.secret_ciphertext + cred.dek_wrapped
    assert cred.kek_ref == "local:v1"
    # decrypted only when talking to the provider
    assert registry.received == {"token_id": "cloudmgr@pve!cm", "secret": SECRET}
    logs = "\n".join(r.getMessage() + str(r.__dict__) for r in caplog.records)
    assert SECRET not in logs


async def test_connection_test(client, ctx, fake):
    cid = await _cluster_with_creds(client, ctx["root"])
    r = await client.post(f"/api/v1/admin/clusters/{cid}/test", headers=ctx["root"])
    assert r.json() == {
        "ok": True, "version": "fake-1.0", "nodes_online": 1, "nodes_total": 1,
        "guests_visible": 2, "error": None,
    }
    fake.available = False
    r = await client.post(f"/api/v1/admin/clusters/{cid}/test", headers=ctx["root"])
    assert r.json()["ok"] is False and "down" in r.json()["error"]


async def test_cluster_validation(client, ctx):
    root = ctx["root"]
    bad = [
        {**CLUSTER, "insecure_skip_verify": True},  # only in dev (tests run as env=test)
        {**CLUSTER, "api_url": "http://pve:8006"},
        {**CLUSTER, "api_url": "ftp://pve"},
        {**CLUSTER, "ca_pem": "not a certificate"},
    ]
    for body in bad:
        r = await client.post("/api/v1/admin/clusters", json=body, headers=root)
        assert r.status_code == 422, body
    for expected in (201, 409):  # created, then duplicate name
        r = await client.post("/api/v1/admin/clusters", json=CLUSTER, headers=root)
        assert r.status_code == expected
    r = await client.put(
        "/api/v1/admin/clusters/00000000-0000-0000-0000-000000000000/credentials",
        json={"token_id": "no-realm", "secret": "x"}, headers=root,
    )
    assert r.status_code == 422
    r = await client.put(  # a password pasted where the token secret goes
        "/api/v1/admin/clusters/00000000-0000-0000-0000-000000000000/credentials",
        json={"token_id": "cloudmgr@pve!cm", "secret": "my-admin-password"}, headers=root,
    )
    assert r.status_code == 422 and "UUID" in r.text and "my-admin-password" not in r.text


async def test_missing_kek_is_a_clear_503(client, ctx, app, settings):
    app.state.providers = ProviderRegistry(settings, None)
    r = await client.post("/api/v1/admin/clusters", json=CLUSTER, headers=ctx["root"])
    cid = r.json()["id"]
    r = await client.put(f"/api/v1/admin/clusters/{cid}/credentials", json=CREDS,
                         headers=ctx["root"])
    assert r.status_code == 503 and r.json()["code"] == "SECRETS_UNAVAILABLE"


# --- sync, discovery, adoption ---------------------------------------------------------


async def test_sync_discovers_and_admin_adopts(client, ctx, owner_db, app_db):
    root = ctx["root"]
    cid = await _cluster_with_creds(client, root)
    run = await _sync(client, root, cid)
    assert run["status"] == "succeeded"
    assert run["stats"]["discovered"] == 2 and run["stats"]["nodes"] == 1

    found = (await client.get("/api/v1/admin/instances?managed=false", headers=root)).json()
    by_vmid = {i["vmid"]: i for i in found}
    assert set(by_vmid) == {10001, 10002}
    assert by_vmid[10002]["kind"] == "container" and by_vmid[10002]["power_state"] == "running"
    assert by_vmid[10001]["node"] == "tagima" and by_vmid[10001]["tenant_id"] is None

    target = by_vmid[10001]["id"]
    # project must belong to the tenant
    r = await client.post(
        f"/api/v1/admin/instances/{target}/adopt",
        json={"tenant_id": str(ctx["globex"].id), "project_id": str(ctx["web"].id)},
        headers=root,
    )
    assert r.status_code == 422
    r = await client.post(
        f"/api/v1/admin/instances/{target}/adopt",
        json={"tenant_id": str(ctx["acme"].id), "project_id": str(ctx["web"].id),
              "name": "web-01"},
        headers=root,
    )
    assert r.status_code == 200 and r.json()["managed"] and r.json()["name"] == "web-01"
    again = await client.post(
        f"/api/v1/admin/instances/{target}/adopt",
        json={"tenant_id": str(ctx["acme"].id), "project_id": str(ctx["web"].id)},
        headers=root,
    )
    assert again.status_code == 409

    # RLS: the adopted instance belongs to acme only; discovered ones to nobody
    for tenant, expected in ((ctx["acme"], ["web-01"]), (ctx["globex"], [])):
        async with app_db.begin():
            await set_tenant_scope(app_db, [tenant.id])
            names = (await app_db.execute(select(Instance.name))).scalars().all()
            assert names == expected

    # a later sync keeps the platform name and ownership
    await _sync(client, root, cid)
    owner_db.expire_all()
    adopted = await owner_db.get(Instance, target)
    assert adopted.name == "web-01" and adopted.provider_name == "cm-test-1" and adopted.managed


async def test_reconcile_missing_offline_and_failures(client, ctx, fake, owner_db):
    root = ctx["root"]
    cid = await _cluster_with_creds(client, root)
    await _sync(client, root, cid)

    async def live_vmids() -> set[int]:
        owner_db.expire_all()
        rows = await owner_db.execute(
            select(Instance.provider_ref["vmid"].as_integer()).where(Instance.deleted_at.is_(None))
        )
        return set(rows.scalars())

    # provider down: sync fails, nothing is considered missing
    fake.available = False
    assert (await _sync(client, root, cid))["status"] == "failed"
    cluster = await owner_db.get(ProviderCluster, cid)
    await owner_db.refresh(cluster)
    assert cluster.status == "offline" and "down" in cluster.last_error
    fake.available = True
    assert await live_vmids() == {10001, 10002}

    # guest disappears: missing once, deleted_externally on the second sync
    del fake.instances["10002"]
    assert (await _sync(client, root, cid))["stats"]["missing"] == 1
    assert await live_vmids() == {10001, 10002}
    assert (await _sync(client, root, cid))["stats"]["deleted_externally"] == 1
    assert await live_vmids() == {10001}

    # same vmid reappears later: discovered as a new instance
    fake.add_instance(10002, "cm-test-2b", node="tagima")
    assert (await _sync(client, root, cid))["stats"]["discovered"] == 1

    # node offline: power state unknown
    fake.nodes[0] = replace(fake.nodes[0], online=False)
    await _sync(client, root, cid)
    owner_db.expire_all()
    states = (await owner_db.execute(
        select(Instance.power_state).where(Instance.deleted_at.is_(None))
    )).scalars().all()
    assert set(states) == {"unknown"}


async def test_sync_without_credentials_fails_cleanly(client, ctx):
    r = await client.post("/api/v1/admin/clusters", json=CLUSTER, headers=ctx["root"])
    run = await _sync(client, ctx["root"], r.json()["id"])
    assert run["status"] == "failed" and "credentials" in run["error"]


async def test_delete_cluster_blocked_by_managed_instances(client, ctx, owner_db):
    root = ctx["root"]
    cid = await _cluster_with_creds(client, root)
    await _sync(client, root, cid)
    instances = (await client.get("/api/v1/admin/instances", headers=root)).json()
    await client.post(
        f"/api/v1/admin/instances/{instances[0]['id']}/adopt",
        json={"tenant_id": str(ctx["acme"].id), "project_id": str(ctx["web"].id)},
        headers=root,
    )
    url = f"/api/v1/admin/clusters/{cid}"
    r = await client.request("DELETE", url, json={"confirm": "lab"}, headers=root)
    assert r.status_code == 409


async def test_worker_reconciles_all_clusters(client, ctx, app, registry, owner_db):
    await _cluster_with_creds(client, ctx["root"])
    await reconcile_all(app.state.sessionmaker, registry)
    count = await owner_db.scalar(select(func.count()).select_from(Instance))
    assert count == 2


async def test_admin_lists_all_tenants(client, ctx):
    r = await client.get("/api/v1/admin/tenants", headers=ctx["root"])
    assert [t["slug"] for t in r.json()] == ["acme", "globex"]


async def test_worker_skips_clusters_with_rejected_credentials(
    client, ctx, app, registry, fake, owner_db
):
    from app.providers.base import ProviderAuthError

    cid = await _cluster_with_creds(client, ctx["root"])

    async def rejected():
        raise ProviderAuthError("GET /cluster/resources: HTTP 401 (check token/ACL)")

    fake.inventory = rejected  # type: ignore[method-assign]
    await reconcile_all(app.state.sessionmaker, registry)
    cluster = await owner_db.get(ProviderCluster, cid)
    await owner_db.refresh(cluster)
    assert cluster.status == "auth_error"

    calls = []

    async def counting():
        calls.append(1)
        raise ProviderAuthError("401")

    fake.inventory = counting  # type: ignore[method-assign]
    await reconcile_all(app.state.sessionmaker, registry)
    assert calls == []  # not retried every tick

    # new credentials re-enable the scheduled sync
    await client.put(f"/api/v1/admin/clusters/{cid}/credentials", json=CREDS, headers=ctx["root"])
    await owner_db.refresh(cluster)
    assert cluster.status == "unknown"
    await reconcile_all(app.state.sessionmaker, registry)
    assert calls == [1]


async def test_nodes_show_allocation_and_metrics(client, ctx, fake):
    root = ctx["root"]
    cid = await _cluster_with_creds(client, root)
    await _sync(client, root, cid)
    [node] = (await client.get("/api/v1/admin/nodes", headers=root)).json()
    # fake guests on tagima: 2 vCPU/2048 MB each, one running
    assert node["name"] == "tagima" and node["cluster_name"] == "lab"
    assert (node["instances_total"], node["instances_running"]) == (2, 1)
    assert (node["vcpus_allocated"], node["memory_allocated_mb"]) == (4, 4096)
    assert (await client.get(f"/api/v1/admin/nodes/{node['id']}", headers=root)).json() == node

    url = f"/api/v1/admin/nodes/{node['id']}/metrics"
    r = await client.get(url, params={"range": "day"}, headers=root)
    assert r.status_code == 200 and len(r.json()["points"]) == 70
    assert set(r.json()["points"][0]) == {"t", "cpu", "memory_used_mb", "memory_total_mb",
                                          "net_in_bps", "net_out_bps", "load", "iowait"}
    assert (await client.get(url, headers=ctx["alice"])).status_code == 403
