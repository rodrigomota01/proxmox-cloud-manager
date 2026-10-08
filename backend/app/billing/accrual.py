"""Accrues cost into usage_records (worker, after each inventory sync).

Each run charges the interval since the last one (`billing_cursor`) with the state the
reconciler just observed: running guests pay compute + disk, stopped ones only disk
(and the per-instance fee). The interval is split on UTC hour boundaries, one row per
instance per hour, so a report can cut any period without re-pricing anything. Prices
are the ones in force at the end of the interval; costs already accrued never change.

One accrual at a time (advisory lock), and cursor + rows commit together: a crash
leaves the interval to the next run, never charges it twice.
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.billing.models import BillingCursor, UsageRecord
from app.billing.pricing import cost_for, monthly_cost, rates_by_tenant
from app.compute.models import Instance
from app.db.session import set_platform_scope

logger = logging.getLogger("cloud_manager.billing")

LOCK_KEY = 0x0B111  # "bill": one accrual at a time across workers
# instances that exist for the customer; provisioning/error never got to run for them
BILLABLE_STATES = ("active", "deleting")


def hour_slices(start: datetime, end: datetime) -> list[tuple[datetime, int]]:
    """[start, end) cut on UTC hour boundaries: (hour start, seconds in that hour)."""
    out: list[tuple[datetime, int]] = []
    cursor = start
    while cursor < end:
        hour = cursor.replace(minute=0, second=0, microsecond=0)
        upto = min(hour + timedelta(hours=1), end)
        seconds = round((upto - cursor).total_seconds())
        if seconds > 0:
            out.append((hour, seconds))
        cursor = upto
    return out


def billable():
    return (
        Instance.managed,
        Instance.tenant_id.is_not(None),
        Instance.deleted_at.is_(None),
        Instance.state.in_(BILLABLE_STATES),
    )


async def accrue_once(db: AsyncSession, now: datetime, max_gap: timedelta) -> int:
    """Accrues up to `now` inside the caller's transaction (platform scope). Returns the
    number of rows written; 0 when another worker holds the lock or nothing elapsed."""
    if not await db.scalar(select(func.pg_try_advisory_xact_lock(LOCK_KEY))):
        return 0
    cursor = await db.get(BillingCursor, 1, with_for_update=True)
    if cursor is None:  # first run: start counting now
        db.add(BillingCursor(id=1, accrued_until=now))
        return 0
    start = cursor.accrued_until
    if now <= start:
        return 0
    if now - start > max_gap:
        logger.warning(
            "billing gap not charged",
            extra={"from": start.isoformat(), "to": (now - max_gap).isoformat()},
        )
        start = now - max_gap
    cursor.accrued_until = now

    instances = (await db.execute(select(Instance).where(*billable()))).scalars().all()
    if not instances:
        return 0
    rates = await rates_by_tenant(db, {i.tenant_id for i in instances if i.tenant_id}, now)
    slices = hour_slices(start, now)
    rows = []
    for i in instances:
        assert i.tenant_id is not None  # billable() filters it
        r = rates[i.tenant_id]
        running = i.power_state == "running"
        month = monthly_cost(
            r, vcpus=i.vcpus, memory_mb=i.memory_mb, disk_gb=i.root_disk_gb, running=running
        )
        for hour, seconds in slices:
            c = cost_for(seconds, month)
            rows.append({
                "tenant_id": i.tenant_id, "project_id": i.project_id, "instance_id": i.id,
                "price_table_id": r.table_id, "period_start": hour, "instance_name": i.name,
                "vcpus": i.vcpus, "memory_mb": i.memory_mb, "disk_gb": i.root_disk_gb,
                "seconds": seconds, "running_seconds": seconds if running else 0,
                "cost_vcpu": c.vcpu, "cost_memory": c.memory, "cost_disk": c.disk,
                "cost_instance": c.instance,
            })
    stmt = insert(UsageRecord)
    ex, t = stmt.excluded, UsageRecord.__table__.c
    added = ("seconds", "running_seconds", "cost_vcpu", "cost_memory", "cost_disk",
             "cost_instance")
    latest = ("project_id", "price_table_id", "instance_name", "vcpus", "memory_mb", "disk_gb")
    await db.execute(
        stmt.on_conflict_do_update(
            index_elements=["instance_id", "period_start"],
            set_={
                **{c: t[c] + ex[c] for c in added},
                **{c: ex[c] for c in latest},
                "updated_at": func.now(),
            },
        ),
        rows,
    )
    return len(rows)


async def accrue(
    sessionmaker: async_sessionmaker[AsyncSession], max_gap_seconds: float
) -> int:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        now = await db.scalar(select(func.now()))
        return await accrue_once(db, now, timedelta(seconds=max_gap_seconds))
