"""Several independent Proxmox servers: identity per cluster, isolation of actions,
parallel sync with a per-cluster deadline, and concurrent job execution."""

import asyncio
import os
import time

import pytest
from sqlalchemy import select

from app.compute.models import Instance
from app.infra.secrets import LocalKek
from app.inventory.models import ProviderCluster
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.models import Job
from app.providers.fake import FakeProvider
from app.providers.registry import ProviderRegistry
from app.worker.main import reconcile_all, run_job_pool
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


@pytest.fixture
def fakes() -> dict[str, FakeProvider]:
    servers = {}
    for name, node in (("hv08", "tagima"), ("hv09", "pve-b")):
        f = FakeProvider()
        f.add_node(node)
        # the same vmid on both servers: they are independent VMID namespaces
        f.add_instance(10001, f"web-{name}", node=node)
        servers[name] = f
    return servers


@pytest.fixture
def multi_registry(app, settings, fakes) -> ProviderRegistry:
    reg = ProviderRegistry(
        settings, LocalKek(os.urandom(32)), factory=lambda cluster, _t, _s: fakes[cluster.name]
    )
    app.state.providers = reg
    return reg


@pytest.fixture
async def env(owner_db, client, app, multi_registry):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    root = await make_user(owner_db, "root@example.com")
    await grant_platform(owner_db, root, "PLATFORM_ADMIN")
    alice, eve = [await make_user(owner_db, f"{n}@example.com") for n in ("alice", "eve")]
    acme, globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    web = await make_project(owner_db, acme, "web")
    api = await make_project(owner_db, globex, "api")
    await add_member(owner_db, acme, alice)
    await add_member(owner_db, globex, eve)

    async def login(email: str) -> dict[str, str]:
        r = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    headers = {"root": await login("root@example.com")}
    clusters = {}
    for name in ("hv08", "hv09"):
        r = await client.post(
            "/api/v1/admin/clusters",
            json={"name": name, "api_url": f"https://{name}.example.test:8006"},
            headers=headers["root"],
        )
        clusters[name] = r.json()["id"]
        await client.put(
            f"/api/v1/admin/clusters/{clusters[name]}/credentials",
            json={"token_id": "cloudmgr@pve!cm", "secret": SECRET}, headers=headers["root"],
        )
    return {
        "headers": headers, "clusters": clusters, "login": login,
        "acme": acme, "globex": globex, "web": web, "api": api,
    }


async def test_same_vmid_on_two_servers_are_distinct_instances(
    client, env, app, multi_registry, fakes, owner_db
):
    await reconcile_all(app.state.sessionmaker, multi_registry)
    root = env["headers"]["root"]
    found = (await client.get("/api/v1/admin/instances", headers=root)).json()
    by_cluster = {(i["cluster_id"], i["vmid"]): i for i in found}
    assert len(found) == 2
    a = by_cluster[(env["clusters"]["hv08"], 10001)]
    b = by_cluster[(env["clusters"]["hv09"], 10001)]
    assert a["id"] != b["id"] and a["name"] == "web-hv08" and b["node"] == "pve-b"

    # each one adopted by a different tenant
    for inst, tenant, project in ((a, "acme", "web"), (b, "globex", "api")):
        r = await client.post(
            f"/api/v1/admin/instances/{inst['id']}/adopt",
            json={"tenant_id": str(env[tenant].id), "project_id": str(env[project].id)},
            headers=root,
        )
        assert r.status_code == 200

    # acting on acme's VM reaches only hv08
    alice = {**await env["login"]("alice@example.com"), "X-Tenant-Id": str(env["acme"].id)}
    r = await client.post(f"/api/v1/instances/{a['id']}/start", headers=alice)
    assert r.status_code == 202
    stop = asyncio.Event()
    pool = asyncio.create_task(run_job_pool(
        app.state.sessionmaker, multi_registry, worker_id="t", concurrency=2,
        wake=asyncio.Event(), stop=stop, poll_seconds=0.05,
    ))
    await _wait_job(owner_db, r.json()["job"]["id"], "succeeded")
    stop.set()
    await pool
    assert fakes["hv08"].calls == [("10001", "start")]
    assert fakes["hv09"].calls == []
    # and globex cannot reach it, even knowing its id
    eve = {**await env["login"]("eve@example.com"), "X-Tenant-Id": str(env["globex"].id)}
    assert (await client.post(f"/api/v1/instances/{a['id']}/stop", headers=eve)).status_code == 404


async def test_slow_server_does_not_delay_the_others(app, env, multi_registry, fakes, owner_db):
    fakes["hv09"].inventory_delay = 5.0
    started = time.monotonic()
    await reconcile_all(app.state.sessionmaker, multi_registry, cluster_timeout=0.5)
    assert time.monotonic() - started < 3  # not 5s+: the slow one was cut off

    owner_db.expire_all()
    fast = await owner_db.get(ProviderCluster, env["clusters"]["hv08"])
    slow = await owner_db.get(ProviderCluster, env["clusters"]["hv09"])
    assert fast.status == "online" and fast.last_synced_at is not None
    assert slow.status == "offline" and "timed out" in slow.last_error
    # nothing from the slow server was half-written
    vmids = (await owner_db.execute(select(Instance.cluster_id))).scalars().all()
    assert set(map(str, vmids)) == {env["clusters"]["hv08"]}


async def test_unreachable_server_does_not_block_the_others(
    app, env, multi_registry, fakes, owner_db
):
    fakes["hv08"].available = False
    await reconcile_all(app.state.sessionmaker, multi_registry)
    owner_db.expire_all()
    down = await owner_db.get(ProviderCluster, env["clusters"]["hv08"])
    up = await owner_db.get(ProviderCluster, env["clusters"]["hv09"])
    assert down.status == "offline" and up.status == "online"


async def test_long_operation_on_one_server_does_not_hold_the_queue(
    client, app, env, multi_registry, fakes, owner_db
):
    await reconcile_all(app.state.sessionmaker, multi_registry)
    root = env["headers"]["root"]
    found = {i["cluster_id"]: i["id"] for i in
             (await client.get("/api/v1/admin/instances", headers=root)).json()}
    slow_vm, fast_vm = found[env["clusters"]["hv08"]], found[env["clusters"]["hv09"]]
    for vm in (slow_vm, fast_vm):
        await client.post(
            f"/api/v1/admin/instances/{vm}/adopt",
            json={"tenant_id": str(env["acme"].id), "project_id": str(env["web"].id)},
            headers=root,
        )
    alice = {**await env["login"]("alice@example.com"), "X-Tenant-Id": str(env["acme"].id)}

    gate = asyncio.Event()
    fakes["hv08"].wait_gate = gate  # e.g. a guest that takes minutes to shut down
    slow_job, fast_job = [
        (await client.post(f"/api/v1/instances/{vm}/start", headers=alice)).json()["job"]["id"]
        for vm in (slow_vm, fast_vm)
    ]

    stop = asyncio.Event()
    pool = asyncio.create_task(run_job_pool(
        app.state.sessionmaker, multi_registry, worker_id="t", concurrency=2,
        wake=asyncio.Event(), stop=stop, poll_seconds=0.05,
    ))
    try:
        await _wait_job(owner_db, fast_job, "succeeded")
        assert (await _job(owner_db, slow_job)).status == "running"  # still blocked
        gate.set()
        await _wait_job(owner_db, slow_job, "succeeded")
    finally:
        gate.set()
        stop.set()
        await pool


async def _job(db, job_id) -> Job:
    # reload just this row (expire_all would also expire the fixture's objects)
    return await db.get(Job, job_id, populate_existing=True)


async def _wait_job(db, job_id, status: str, within: float = 5.0) -> None:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        job = await _job(db, job_id)
        if job.status == status:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"job {job_id} is {job.status}, expected {status}")
