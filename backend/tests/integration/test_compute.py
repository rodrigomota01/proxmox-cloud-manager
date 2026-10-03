"""Tenant instances, power actions as jobs, the job queue, jobs API and dashboard."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.compute.models import Instance
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.models import Job, JobEvent
from app.jobs.queue import run_one
from app.providers.base import PowerState
from tests.integration.factories import (
    PASSWORD,
    add_member,
    grant_platform,
    make_project,
    make_tenant,
    make_user,
)

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


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


@pytest.fixture
async def env(owner_db, client, app, registry):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    e = Env(client, app)
    e.acme, e.globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    e.web = await make_project(owner_db, e.acme, "web")
    e.db = await make_project(owner_db, e.acme, "db")
    for name in ("root", "alice", "olga", "carol", "dave", "eve"):
        setattr(e, name, await make_user(owner_db, f"{name}@example.com"))
    await grant_platform(owner_db, e.root, "PLATFORM_ADMIN")
    await add_member(owner_db, e.acme, e.alice, "TENANT_ADMIN")
    await add_member(owner_db, e.acme, e.olga, "OPERATOR")
    await add_member(owner_db, e.acme, e.carol, "USER", e.web)
    await add_member(owner_db, e.acme, e.dave, "READ_ONLY", e.db)
    await add_member(owner_db, e.globex, e.eve, "TENANT_ADMIN")

    # cluster -> sync (discovers 10001 vm, 10002 container) -> adopt
    root = await e.h("root")
    r = await client.post(
        "/api/v1/admin/clusters", json={"name": "lab", "api_url": "https://pve.test:8006"},
        headers=root,
    )
    e.cluster = cid = r.json()["id"]
    await client.put(
        f"/api/v1/admin/clusters/{cid}/credentials",
        json={"token_id": "cloudmgr@pve!cm", "secret": "0e5c6a3e-1b2d-4f6a-9c8b-7d6e5f4a3b2c"},
        headers=root,
    )
    await client.post(f"/api/v1/admin/clusters/{cid}/sync", headers=root)
    await e.drain()
    found = {
        i["vmid"]: i["id"]
        for i in (await client.get("/api/v1/admin/instances", headers=root)).json()
    }
    for vmid, project in ((10001, e.web), (10002, e.db)):
        await client.post(
            f"/api/v1/admin/instances/{found[vmid]}/adopt",
            json={"tenant_id": str(e.acme.id), "project_id": str(project.id)}, headers=root,
        )
    e.vm, e.ct = found[10001], found[10002]
    return e


# --- listing and detail ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("who", "expected"),
    [("alice", {"cm-test-1", "cm-test-2"}), ("olga", {"cm-test-1", "cm-test-2"}),
     ("carol", {"cm-test-1"}), ("dave", {"cm-test-2"})],
)
async def test_instance_visibility(client, env, who, expected):
    r = await client.get("/api/v1/instances", headers=await env.h(who, env.acme))
    assert r.status_code == 200
    items = r.json()["items"]
    assert {i["name"] for i in items} == expected
    for item in items:  # no provider identifiers for tenants (ADR-0010)
        assert not {"vmid", "node", "cluster_id", "provider_ref"} & set(item)


async def test_instance_filters(client, env):
    h = await env.h("alice", env.acme)
    r = await client.get("/api/v1/instances", params={"kind": "container"}, headers=h)
    assert [i["name"] for i in r.json()["items"]] == ["cm-test-2"]
    r = await client.get("/api/v1/instances", params={"power_state": "running"}, headers=h)
    assert [i["name"] for i in r.json()["items"]] == ["cm-test-2"]
    r = await client.get("/api/v1/instances", params={"project_id": str(env.web.id)}, headers=h)
    assert [i["name"] for i in r.json()["items"]] == ["cm-test-1"]


async def test_instance_detail_access(client, env, owner_db):
    assert (await client.get(f"/api/v1/instances/{env.vm}",
                             headers=await env.h("carol", env.acme))).status_code == 200
    # member without permission on that project: 403; other tenant: 404
    assert (await client.get(f"/api/v1/instances/{env.ct}",
                             headers=await env.h("carol", env.acme))).status_code == 403
    assert (await client.get(f"/api/v1/instances/{env.vm}",
                             headers=await env.h("eve", env.globex))).status_code == 404


async def test_unmanaged_instances_are_invisible_to_tenants(client, env, fake):
    fake.add_instance(10003, "manual-vm", node="tagima")
    await client.post(f"/api/v1/admin/clusters/{env.cluster}/sync", headers=await env.h("root"))
    await env.drain()
    r = await client.get("/api/v1/instances", headers=await env.h("alice", env.acme))
    assert "manual-vm" not in {i["name"] for i in r.json()["items"]}
    admin = await client.get("/api/v1/admin/instances?managed=false", headers=await env.h("root"))
    assert [i["name"] for i in admin.json()] == ["manual-vm"]


# --- power actions and the queue -------------------------------------------------------


async def test_power_action_runs_as_job(client, env, fake, owner_db):
    h = await env.h("carol", env.acme)
    r = await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)
    assert r.status_code == 202
    job = r.json()["job"]
    assert job["status"] == "pending" and job["type"] == "instance.power"
    assert r.headers["location"] == f"/api/v1/jobs/{job['id']}"

    await env.drain()
    assert fake.calls == [("10001", "start")]
    detail = (await client.get(f"/api/v1/jobs/{job['id']}", headers=h)).json()
    assert detail["status"] == "succeeded" and detail["result"] == {"power_state": "running"}
    # history reads as "who did what to which instance"
    assert detail["resource_name"] == "cm-test-1" and detail["requested_by_name"] == "carol"
    assert detail["payload"] == {"action": "start"}
    assert [e["kind"] for e in detail["events"]] == ["started", "provider_task", "succeeded"]
    assert all("data" not in e for e in detail["events"])  # provider ids stay admin-only
    inst = (await client.get(f"/api/v1/instances/{env.vm}", headers=h)).json()
    assert inst["power_state"] == "running"


@pytest.mark.parametrize(
    ("who", "action", "expected"),
    [("olga", "restart", 202), ("olga", "shutdown", 202), ("dave", "start", 403),
     ("carol", "stop", 202), ("alice", "start", 202)],
)
async def test_power_rbac(client, env, who, action, expected):
    target = env.ct if who == "dave" else env.vm
    r = await client.post(
        f"/api/v1/instances/{target}/{action}", headers=await env.h(who, env.acme)
    )
    assert r.status_code == expected


async def test_unknown_action_is_rejected(client, env):
    r = await client.post(
        f"/api/v1/instances/{env.vm}/destroy", headers=await env.h("alice", env.acme)
    )
    assert r.status_code == 422


async def test_one_active_operation_per_instance(client, env):
    h = await env.h("alice", env.acme)
    assert (await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)).status_code == 202
    r = await client.post(f"/api/v1/instances/{env.vm}/stop", headers=h)
    assert r.status_code == 409
    await env.drain()
    assert (await client.post(f"/api/v1/instances/{env.vm}/stop", headers=h)).status_code == 202


async def test_idempotency_key(client, env):
    h = {**await env.h("alice", env.acme), "Idempotency-Key": "k-123"}
    first = await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)
    again = await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)
    assert first.json()["job"]["id"] == again.json()["job"]["id"]
    other = await client.post(f"/api/v1/instances/{env.ct}/start", headers=h)
    assert other.status_code == 409


async def test_instance_not_active_conflicts(client, env, owner_db):
    inst = await owner_db.get(Instance, env.vm)
    inst.state = "error"
    await owner_db.commit()
    r = await client.post(
        f"/api/v1/instances/{env.vm}/start", headers=await env.h("alice", env.acme)
    )
    assert r.status_code == 409


async def test_provider_task_failure(client, env, fake):
    fake.task_error = "VM is locked (backup)"
    h = await env.h("alice", env.acme)
    job = (await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)).json()["job"]
    await env.drain()
    detail = (await client.get(f"/api/v1/jobs/{job['id']}", headers=h)).json()
    assert detail["status"] == "failed" and detail["error_code"] == "PROVIDER_TASK_FAILED"
    assert "locked" in detail["error_message"]


async def test_transient_errors_retry_then_fail(client, env, fake, owner_db):
    fake.available = False
    h = await env.h("alice", env.acme)
    job_id = (await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)).json()["job"]["id"]
    await env.drain()
    job = await owner_db.get(Job, job_id)
    await owner_db.refresh(job)
    assert job.status == "pending" and job.attempts == 1 and job.run_after > datetime.now(UTC)

    for _ in range(job.max_attempts):  # make retries due immediately
        await owner_db.refresh(job)
        job.run_after = datetime.now(UTC) - timedelta(seconds=1)
        await owner_db.commit()
        await env.drain()
    await owner_db.refresh(job)
    assert job.status == "failed" and job.error_code == "PROVIDER_UNAVAILABLE"
    assert job.attempts == job.max_attempts


async def test_job_resumes_recorded_provider_task(client, env, fake, owner_db):
    """A worker died after submitting the task: the next one waits, never resubmits."""
    h = await env.h("alice", env.acme)
    job_id = (await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)).json()["job"]["id"]
    job = await owner_db.get(Job, job_id)
    owner_db.add(JobEvent(job_id=job.id, tenant_id=job.tenant_id, kind="provider_task",
                          data={"step": "power",
                                "operation": {"key": "10001", "action": "start"}}))
    # simulate a crashed worker: running with an expired lease
    job.status, job.attempts = "running", 1
    job.locked_until = datetime.now(UTC) - timedelta(minutes=1)
    await owner_db.commit()

    await env.drain()
    assert fake.calls == []  # not submitted again
    await owner_db.refresh(job)
    assert job.status == "succeeded" and job.attempts == 2


# --- jobs API --------------------------------------------------------------------------


async def test_usage_is_reported_and_metrics_are_served(client, env, fake):
    from dataclasses import replace as dc_replace

    fake.instances["10002"] = dc_replace(fake.instances["10002"], cpu_usage=0.42,
                                         memory_used_mb=900, uptime_seconds=3600)
    await client.post(f"/api/v1/admin/clusters/{env.cluster}/sync", headers=await env.h("root"))
    await env.drain()
    h = await env.h("alice", env.acme)
    ct = (await client.get(f"/api/v1/instances/{env.ct}", headers=h)).json()
    assert (ct["cpu_usage"], ct["memory_used_mb"], ct["uptime_seconds"]) == (0.42, 900, 3600)

    calls = []
    original = fake.metrics

    async def counted(ref, timeframe):
        calls.append(timeframe)
        return await original(ref, timeframe)

    fake.metrics = counted  # type: ignore[method-assign]
    url = f"/api/v1/instances/{env.vm}/metrics"
    first = await client.get(url, params={"range": "day"}, headers=h)
    again = await client.get(url, params={"range": "day"}, headers=h)
    assert first.status_code == 200 and first.json() == again.json()
    assert calls == ["day"]  # second answer came from the cache
    point = first.json()["points"][0]
    assert set(point) == {"t", "cpu", "memory_used_mb", "memory_total_mb", "net_in_bps",
                          "net_out_bps", "disk_read_bps", "disk_write_bps"}
    assert (await client.get(url, params={"range": "year"}, headers=h)).status_code == 422
    # same authorization as the instance itself
    assert (await client.get(f"/api/v1/instances/{env.ct}/metrics",
                             headers=await env.h("carol", env.acme))).status_code == 403
    assert (await client.get(url, headers=await env.h("eve", env.globex))).status_code == 404

    fake.available = False
    down = await client.get(url, params={"range": "week"}, headers=h)
    assert down.status_code == 503 and down.json()["code"] == "PROVIDER_UNAVAILABLE"


async def test_jobs_filter_by_type(client, env):
    h = await env.h("alice", env.acme)
    await client.post(f"/api/v1/instances/{env.vm}/start", headers=h)
    power = await client.get("/api/v1/jobs", params={"type": "instance.power"}, headers=h)
    create = await client.get("/api/v1/jobs", params={"type": "instance.create"}, headers=h)
    assert [j["resource_name"] for j in power.json()["items"]] == ["cm-test-1"]
    assert create.json()["items"] == []
    bad = await client.get("/api/v1/jobs", params={"type": "cluster.sync"}, headers=h)
    assert bad.status_code == 422  # platform jobs are not a tenant filter


async def test_job_visibility(client, env):
    job = (await client.post(f"/api/v1/instances/{env.vm}/start",
                             headers=await env.h("carol", env.acme))).json()["job"]
    url = f"/api/v1/jobs/{job['id']}"
    for who, expected in (("carol", 200), ("alice", 200), ("dave", 404)):
        assert (await client.get(url, headers=await env.h(who, env.acme))).status_code == expected
    assert (await client.get(url, headers=await env.h("eve", env.globex))).status_code == 404
    listed = (await client.get("/api/v1/jobs", headers=await env.h("dave", env.acme))).json()
    assert listed["items"] == []


async def test_dashboard(client, env):
    await client.post(f"/api/v1/instances/{env.vm}/start", headers=await env.h("alice", env.acme))
    alice = (await client.get("/api/v1/dashboard/summary",
                              headers=await env.h("alice", env.acme))).json()
    assert alice["projects"] == 2 and alice["active_jobs"] == 1
    assert alice["instances"] == {"vm": {"stopped": 1}, "container": {"running": 1}}
    carol = (await client.get("/api/v1/dashboard/summary",
                              headers=await env.h("carol", env.acme))).json()
    assert carol["projects"] == 1 and carol["instances"] == {"vm": {"stopped": 1}}


async def test_cross_tenant_compute_matrix(client, env, owner_db):
    cases = [
        (env.acme, "GET", "/api/v1/instances"),
        (env.acme, "GET", f"/api/v1/instances/{env.vm}"),
        (env.acme, "POST", f"/api/v1/instances/{env.vm}/stop"),
        (env.acme, "GET", "/api/v1/jobs"),
        (env.acme, "GET", "/api/v1/dashboard/summary"),
        (env.globex, "GET", f"/api/v1/instances/{env.vm}"),
        (env.globex, "POST", f"/api/v1/instances/{env.vm}/start"),
    ]
    failures = []
    for tenant, method, path in cases:
        r = await client.request(method, path, headers=await env.h("eve", tenant))
        if r.status_code != 404:
            failures.append(f"{method} {path} as {tenant.slug}: {r.status_code}")
    assert failures == []
    assert (await owner_db.execute(select(Job).where(Job.type == "instance.power"))).first() is None
    assert (await owner_db.get(Instance, env.vm)).power_state == PowerState.STOPPED.value
