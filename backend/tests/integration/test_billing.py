"""Prices -> accrual by the worker -> cost reports, and who sees which costs."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text

from app.billing.accrual import accrue_once
from app.billing.models import PriceItem, UsageRecord
from app.billing.service import month_of
from app.db.session import set_platform_scope
from app.k8s.models import K8sCluster, K8sSnapshot
from tests.integration.factories import add_member, make_user
from tests.integration.test_alerts import Env, env  # noqa: F401 - fixture

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

TZ = "America/Sao_Paulo"
# hourly: vCPU 0.10, GiB RAM 0.05, GiB disk 0.001, instance 0.01
PRICES = {"vcpu": "73", "memory_gb": "36.5", "disk_gb": "0.73", "instance": "7.3"}
GAP = timedelta(hours=6)


@pytest.fixture
async def benv(env: Env, owner_db) -> Env:  # noqa: F811 - the imported fixture
    """The alerts environment (acme with two adopted guests) plus prices."""
    env.paula = await make_user(owner_db, "paula@example.com")
    await add_member(owner_db, env.acme, env.paula, "PROJECT_ADMIN", env.web)
    r = await env.client.post(
        "/api/v1/admin/price-tables", headers=await env.h("root"),
        json={"name": "Padrão", "is_default": True, "prices": PRICES},
    )
    assert r.status_code == 201, r.text
    env.table = r.json()
    # prices in force since yesterday, so accruals can run over past hours
    await _backdate(owner_db)
    return env


async def _backdate(owner_db):
    await owner_db.execute(text(
        "UPDATE price_items SET effective_from = effective_from - interval '1 day'"
    ))
    await owner_db.commit()


async def _accrue(app, at):
    async with app.state.sessionmaker() as db, db.begin():  # cm_app, like the worker
        await set_platform_scope(db)
        return await accrue_once(db, at, GAP)


async def _base(owner_db):
    """Three hours ago, whole second, inside a single billing month (else skip)."""
    now = await owner_db.scalar(select(func.now()))
    base = (now - timedelta(hours=3)).replace(microsecond=0)
    if month_of(None, TZ, base).label != month_of(None, TZ, now).label:
        pytest.skip("too close to a month boundary")
    return base


def money(value) -> Decimal:
    return Decimal(value).quantize(Decimal("0.01"))


async def test_accrual_charges_running_compute_and_stopped_disk(client, benv, app, owner_db):
    base = await _base(owner_db)
    assert await _accrue(app, base) == 0  # first run only starts the clock
    written = await _accrue(app, base + timedelta(hours=2))
    assert written >= 4  # 2 instances x (2 or 3 hour rows)

    rows = (await owner_db.execute(select(UsageRecord))).scalars().all()
    by = {}
    for r in rows:
        by.setdefault(str(r.instance_id), []).append(r)
    ct = by[benv.ct]  # running: 0.33/h
    vm = by[benv.vm]  # stopped: disk 0.02 + fee 0.01 per hour
    assert sum(r.seconds for r in ct) == 7200 and sum(r.running_seconds for r in ct) == 7200
    assert sum(r.running_seconds for r in vm) == 0
    assert money(sum(r.cost_vcpu + r.cost_memory + r.cost_disk + r.cost_instance
                     for r in ct)) == Decimal("0.66")
    assert money(sum(r.cost_disk + r.cost_instance for r in vm)) == Decimal("0.06")
    assert sum(r.cost_vcpu for r in vm) == 0

    # the same interval is never charged twice
    assert await _accrue(app, base + timedelta(hours=2)) == 0

    alice = await benv.h("alice", benv.acme)
    r = await client.get("/api/v1/billing/summary", headers=alice)
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["currency"] == "BRL" and s["current"] and s["prices"]["price_table"] == "Padrão"
    assert money(s["accrued"]["total"]) == Decimal("0.72")
    assert money(s["accrued"]["vcpu"]) == Decimal("0.40")
    assert money(s["run_rate"]["total"]) == Decimal("262.80")  # 240.9 + 21.9 per month
    assert money(s["run_rate_hourly"]) == Decimal("0.36")
    assert Decimal(s["forecast"]) >= Decimal(s["accrued"]["total"])
    projects = {p["name"]: money(p["accrued"]) for p in s["projects"]}
    assert projects == {"db": Decimal("0.66"), "web": Decimal("0.06")}
    assert [i["name"] for i in s["instances"]] == ["cm-test-2", "cm-test-1"]
    assert money(sum(Decimal(d["cost"]) for d in s["days"])) == Decimal("0.72")


async def test_price_change_applies_from_then_on(client, benv, app, owner_db):
    base = await _base(owner_db)
    await _accrue(app, base)
    await _accrue(app, base + timedelta(hours=1))
    root = await benv.h("root")
    doubled = {k: str(Decimal(v) * 2) for k, v in PRICES.items()}
    r = await client.patch(f"/api/v1/admin/price-tables/{benv.table['id']}",
                           json={"prices": doubled}, headers=root)
    assert r.status_code == 200, r.text
    assert len(r.json()["history"]) == 8  # 4 original + 4 new items
    # the new prices take effect one hour after base
    await owner_db.execute(
        PriceItem.__table__.update()
        .where(PriceItem.effective_from > base)
        .values(effective_from=base + timedelta(minutes=59))
    )
    await owner_db.commit()
    await _accrue(app, base + timedelta(hours=2))

    alice = await benv.h("alice", benv.acme)
    s = (await client.get("/api/v1/billing/summary", headers=alice)).json()
    assert money(s["accrued"]["total"]) == Decimal("1.08")  # 0.36 + 0.72
    assert money(s["run_rate_hourly"]) == Decimal("0.72")


async def test_tenant_price_table_and_platform_view(client, benv, app, owner_db):
    root = await benv.h("root")
    r = await client.post("/api/v1/admin/price-tables", headers=root, json={
        "name": "Acme", "prices": {"vcpu": "0", "memory_gb": "0", "disk_gb": "7.3"},
    })
    assert r.status_code == 201, r.text
    acme_table = r.json()["id"]
    r = await client.put(f"/api/v1/admin/tenants/{benv.acme.id}/price-table",
                         json={"price_table_id": acme_table}, headers=root)
    assert r.status_code == 200
    await _backdate(owner_db)
    base = await _base(owner_db)
    await _accrue(app, base)
    await _accrue(app, base + timedelta(hours=1))

    # only disk, 0.01/GiB/h: 2 x 20 GiB
    alice = await benv.h("alice", benv.acme)
    s = (await client.get("/api/v1/billing/summary", headers=alice)).json()
    assert s["prices"]["price_table"] == "Acme"
    assert money(s["accrued"]["total"]) == Decimal("0.40")

    r = await client.get("/api/v1/admin/billing/summary", headers=root)
    assert r.status_code == 200, r.text
    p = r.json()
    tenants = {t["slug"]: t for t in p["tenants"]}
    assert tenants["acme"]["price_table"] == "Acme" and tenants["acme"]["custom_price_table"]
    assert tenants["globex"]["price_table"] == "Padrão"
    assert money(tenants["acme"]["accrued"]) == Decimal("0.40")
    assert Decimal(tenants["globex"]["accrued"]) == 0
    assert money(p["accrued"]["total"]) == Decimal("0.40")

    # a table in use cannot be deleted; the default cannot either
    assert (await client.delete(f"/api/v1/admin/price-tables/{acme_table}",
                                headers=root)).status_code == 409
    assert (await client.delete(f"/api/v1/admin/price-tables/{benv.table['id']}",
                                headers=root)).status_code == 409
    await client.put(f"/api/v1/admin/tenants/{benv.acme.id}/price-table",
                     json={"price_table_id": None}, headers=root)
    assert (await client.delete(f"/api/v1/admin/price-tables/{acme_table}",
                                headers=root)).status_code == 204


async def test_who_sees_which_costs(client, benv, app, owner_db):
    base = await _base(owner_db)
    await _accrue(app, base)
    await _accrue(app, base + timedelta(hours=1))

    # project admin of "web": only web's instance
    r = await client.get("/api/v1/billing/summary", headers=await benv.h("paula", benv.acme))
    assert r.status_code == 200, r.text
    s = r.json()
    assert [i["name"] for i in s["instances"]] == ["cm-test-1"]
    assert money(s["accrued"]["total"]) == Decimal("0.03")

    # every role sees the costs of its own projects (USER in web, READ_ONLY in db)
    for who, seen in (("carol", ["cm-test-1"]), ("dave", ["cm-test-2"])):
        r = await client.get("/api/v1/billing/summary", headers=await benv.h(who, benv.acme))
        assert r.status_code == 200, r.text
        assert [i["name"] for i in r.json()["instances"]] == seen
    r = await client.get("/api/v1/billing/prices", headers=await benv.h("carol", benv.acme))
    assert r.status_code == 200 and r.json()["prices"]["vcpu"].startswith("73")

    # other tenant: its own (empty) report; acme's is invisible
    eve = await benv.h("eve", benv.globex)
    s = (await client.get("/api/v1/billing/summary", headers=eve)).json()
    assert s["instances"] == [] and Decimal(s["accrued"]["total"]) == 0
    assert (await client.get("/api/v1/billing/summary",
                             headers=await benv.h("eve", benv.acme))).status_code == 404

    # RLS: a tenant-scoped session reads only its own usage rows
    async with app.state.sessionmaker() as db, db.begin():
        await db.execute(text("SELECT set_config('app.tenant_ids', :t, true)"),
                         {"t": str(benv.globex.id)})
        assert await db.scalar(select(func.count()).select_from(UsageRecord)) == 0

    # price tables are platform business
    alice = await benv.h("alice", benv.acme)
    assert (await client.get("/api/v1/admin/price-tables", headers=alice)).status_code == 403
    assert (await client.get("/api/v1/admin/billing/summary", headers=alice)).status_code == 403


async def test_long_worker_outage_is_not_charged(client, benv, app, owner_db):
    base = await _base(owner_db) - timedelta(hours=20)
    await _accrue(app, base)
    await _accrue(app, base + GAP + timedelta(hours=10))
    seconds = await owner_db.scalar(
        select(func.sum(UsageRecord.seconds)).where(UsageRecord.instance_id == benv.ct)
    )
    assert seconds == GAP.total_seconds()


async def test_month_validation_and_past_months(client, benv):
    alice = await benv.h("alice", benv.acme)
    r = await client.get("/api/v1/billing/summary", params={"month": "2020-01"}, headers=alice)
    assert r.status_code == 200
    s = r.json()
    assert not s["current"] and s["forecast"] is None and Decimal(s["run_rate"]["total"]) == 0
    r = await client.get("/api/v1/billing/summary", params={"month": "2999-01"}, headers=alice)
    assert r.status_code == 422
    r = await client.post("/api/v1/admin/price-tables", headers=await benv.h("root"),
                          json={"name": "Padrão", "prices": PRICES})
    assert r.status_code == 409


async def test_cost_visibility_per_client(client, benv, app, owner_db):
    base = await _base(owner_db)
    await _accrue(app, base)
    await _accrue(app, base + timedelta(hours=2))
    root, alice = await benv.h("root"), await benv.h("alice", benv.acme)
    cluster = K8sCluster(name="acme-prod", source="manual", tenant_id=benv.acme.id,
                         synced_at=datetime.now(UTC))
    owner_db.add(cluster)
    await owner_db.flush()
    owner_db.add(K8sSnapshot(
        cluster_id=cluster.id, health="healthy", collected_at=datetime.now(UTC),
        summary={"nodes": 3, "nodes_ready": 3, "pods": 40, "namespaces": 6,
                 "cpu_capacity": 12, "cpu_allocatable": 11.4, "cpu_requests": 5.5,
                 "cpu_usage": 2.25, "mem_capacity": 48 * 2**30, "mem_allocatable": 46 * 2**30,
                 "mem_requests": 20 * 2**30, "mem_usage": None},
    ))
    await owner_db.commit()

    async def access(headers):
        r = await client.get("/api/v1/billing/access", headers=headers)
        assert r.status_code == 200, r.text
        return r.json()["cost_visibility"]

    async def set_visibility(value, headers=root):
        return await client.put(f"/api/v1/admin/tenants/{benv.acme.id}/cost-visibility",
                                json={"cost_visibility": value}, headers=headers)

    # default: costs and usage
    assert await access(alice) == "full"
    assert (await client.get("/api/v1/billing/usage", headers=alice)).status_code == 200

    # only platform billing admins choose; the tenant admin cannot widen it back
    assert (await set_visibility("usage", alice)).status_code == 403
    r = await set_visibility("usage")
    assert r.status_code == 200 and r.json() == {"cost_visibility": "usage"}
    assert (await set_visibility("bogus")).status_code == 422

    # usage only: no costs, no prices, but consumed/allocated resources and the cluster
    assert await access(alice) == "usage"
    for path in ("/api/v1/billing/summary", "/api/v1/billing/prices"):
        assert (await client.get(path, headers=alice)).status_code == 403
    r = await client.get("/api/v1/billing/usage", headers=alice)
    assert r.status_code == 200, r.text
    u = r.json()
    assert "accrued" not in u and "prices" not in u
    assert [i["name"] for i in u["instances"]] == ["cm-test-2", "cm-test-1"]
    ct = u["instances"][0]  # running, 2 vCPU / 2 GiB / 20 GiB for 2 hours
    assert Decimal(ct["vcpu_hours"]) == 4 and Decimal(ct["memory_gib_hours"]) == 4
    assert Decimal(ct["disk_gib_hours"]) == 40 and Decimal(ct["running_hours"]) == 2
    vm = u["instances"][1]  # stopped: only its disk counts
    assert Decimal(vm["vcpu_hours"]) == 0 and Decimal(vm["disk_gib_hours"]) == 40
    assert Decimal(u["consumed"]["disk_gib_hours"]) == 80
    assert u["allocated"]["instances"] == 2 and u["allocated"]["running"] == 1
    assert {p["name"] for p in u["projects"]} == {"db", "web"}
    assert sum(Decimal(d["vcpu_hours"]) for d in u["days"]) == 4
    [c] = u["clusters"]
    assert c["name"] == "acme-prod" and c["nodes"] == 3 and c["cpu_usage"] == 2.25
    assert c["mem_usage"] is None and c["mem_capacity"] == 48 * 2**30

    # project roles: only their projects' VMs; the client's cluster with k8s:view
    r = await client.get("/api/v1/billing/usage", headers=await benv.h("paula", benv.acme))
    assert [i["name"] for i in r.json()["instances"]] == ["cm-test-1"]
    assert [c["name"] for c in r.json()["clusters"]] == ["acme-prod"]
    # another client sees neither
    r = await client.get("/api/v1/billing/usage", headers=await benv.h("eve", benv.globex))
    assert r.json()["instances"] == [] and r.json()["clusters"] == []

    # platform billing viewers are not bound by the setting
    as_root = await benv.h("root", benv.acme)
    assert await access(as_root) == "full"
    assert (await client.get("/api/v1/billing/summary", headers=as_root)).status_code == 200

    # hidden: nothing at all for the client's members
    assert (await set_visibility("none")).status_code == 200
    assert await access(alice) == "none"
    for path in ("/api/v1/billing/summary", "/api/v1/billing/usage", "/api/v1/billing/prices"):
        assert (await client.get(path, headers=alice)).status_code == 403
    p = (await client.get("/api/v1/admin/billing/summary", headers=root)).json()
    vis = {t["slug"]: t["cost_visibility"] for t in p["tenants"]}
    assert vis == {"acme": "none", "globex": "full"}
    actions = (await owner_db.execute(text(
        "SELECT details->>'to' FROM audit_logs WHERE action = 'TENANT_COST_VISIBILITY_SET'"
        " ORDER BY occurred_at"
    ))).scalars().all()
    assert actions == ["usage", "none"]
