"""Turns the live observations into alerts (runs in the worker after each inventory sync).

For every enabled rule and every resource it watches:

    value > threshold                     -> pending (started_at = now)
    still > threshold after duration      -> firing  (notify)
    firing and value < threshold x CLEAR  -> resolved (notify)
    pending and value <= threshold        -> dropped (never fired, nobody is told)
    resource gone / stopped / offline     -> same as "value back to normal"

CLEAR (hysteresis) keeps a value hovering around the threshold from flapping between
firing and resolved every 15 s. Runs in platform scope; returns the state changes the
caller must notify.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import Float, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.alerts.models import Alert, AlertRule
from app.compute.models import Instance
from app.db.session import set_platform_scope
from app.inventory.models import Node, StoragePool

CLEAR = 0.95


@dataclass(frozen=True)
class Observation:
    resource_id: uuid.UUID
    name: str
    value: float
    tenant_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None


Values = dict[tuple[str, str], list[Observation]]  # (target, metric) -> observations


async def collect(db: AsyncSession) -> Values:
    values: Values = {}

    def add(target: str, metric: str, obs: Observation) -> None:
        values.setdefault((target, metric), []).append(obs)

    running = (
        await db.execute(
            select(Instance).where(
                Instance.deleted_at.is_(None), Instance.power_state == "running"
            )
        )
    ).scalars().all()
    for i in running:
        owner = {"tenant_id": i.tenant_id if i.managed else None,
                 "project_id": i.project_id if i.managed else None}
        add("instance", "cpu", Observation(i.id, i.name, i.cpu_usage, **owner))
        if i.memory_mb:
            add("instance", "memory",
                Observation(i.id, i.name, i.memory_used_mb / i.memory_mb, **owner))
        if i.disk_usage is not None:
            add("instance", "disk", Observation(i.id, i.name, i.disk_usage, **owner))
        add("instance", "net_in", Observation(i.id, i.name, i.net_in_bps, **owner))
        add("instance", "net_out", Observation(i.id, i.name, i.net_out_bps, **owner))

    traffic = {
        node_id: (net_in, net_out)
        for node_id, net_in, net_out in (
            await db.execute(
                select(Instance.node_id, func.sum(Instance.net_in_bps),
                       func.sum(Instance.net_out_bps))
                .where(Instance.deleted_at.is_(None), Instance.node_id.is_not(None))
                .group_by(Instance.node_id)
            )
        ).all()
    }
    for n in (await db.execute(select(Node).where(Node.status == "online"))).scalars():
        add("node", "cpu", Observation(n.id, n.name, n.cpu_usage))
        if n.memory_bytes:
            add("node", "memory", Observation(n.id, n.name, n.memory_used_bytes / n.memory_bytes))
        net_in, net_out = traffic.get(n.id, (0.0, 0.0))
        add("node", "net_in", Observation(n.id, n.name, float(net_in or 0)))
        add("node", "net_out", Observation(n.id, n.name, float(net_out or 0)))

    ratio = cast(StoragePool.used_bytes, Float) / StoragePool.total_bytes
    pools = await db.execute(
        select(StoragePool, ratio).where(StoragePool.active, StoragePool.total_bytes > 0)
    )
    for p, value in pools.all():
        add("storage", "disk", Observation(p.id, f"{p.node}/{p.name}", float(value)))
    return values


@dataclass(frozen=True)
class Change:
    alert_id: uuid.UUID
    event: str  # firing|resolved


async def evaluate(db: AsyncSession, now: datetime | None = None) -> list[Change]:
    now = now or datetime.now(UTC)
    values = await collect(db)
    rules = (await db.execute(select(AlertRule).where(AlertRule.enabled))).scalars().all()
    open_alerts = {
        (a.rule_id, a.resource_id): a
        for a in (
            await db.execute(select(Alert).where(Alert.state.in_(("pending", "firing"))))
        ).scalars()
    }
    changes: list[Change] = []

    for rule in rules:
        for obs in values.get((rule.target, rule.metric), []):
            if rule.tenant_id is not None and obs.tenant_id != rule.tenant_id:
                continue  # a tenant's rule watches only that tenant's instances
            alert = open_alerts.get((rule.id, obs.resource_id))
            limit = rule.threshold * CLEAR if alert and alert.state == "firing" else rule.threshold
            if obs.value <= limit:
                continue  # left in open_alerts: cleared below
            open_alerts.pop((rule.id, obs.resource_id), None)
            if alert is None:
                alert = Alert(
                    rule_id=rule.id, rule_tenant_id=rule.tenant_id, tenant_id=obs.tenant_id,
                    project_id=obs.project_id, resource_type=rule.target,
                    resource_id=obs.resource_id, resource_name=obs.name, rule_name=rule.name,
                    metric=rule.metric, threshold=rule.threshold, severity=rule.severity,
                    value=obs.value, peak=obs.value, state="pending", started_at=now,
                    updated_at=now,
                )
                db.add(alert)
                await db.flush()
            alert.value, alert.peak, alert.updated_at = obs.value, max(alert.peak, obs.value), now
            alert.resource_name = obs.name
            due = (now - alert.started_at).total_seconds() >= rule.duration_seconds
            if alert.state == "pending" and due:
                alert.state, alert.fired_at = "firing", now
                changes.append(Change(alert.id, "firing"))

    # whatever is still open did not breach this round (or its rule/resource is gone)
    for alert in open_alerts.values():
        if alert.state == "pending":
            await db.delete(alert)
        else:
            alert.state, alert.resolved_at, alert.updated_at = "resolved", now, now
            changes.append(Change(alert.id, "resolved"))
    await db.flush()
    return changes


ALERTS_LOCK = 0x616C657274  # one evaluator at a time, whatever the number of workers


async def run_alerts(sessionmaker: async_sessionmaker[AsyncSession]) -> list[Change]:
    """Evaluate and queue the notifications in the same transaction: an alert that
    changed state is never committed without its notification jobs."""
    from app.alerts.notify import enqueue_notifications

    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        if not await db.scalar(select(func.pg_try_advisory_xact_lock(ALERTS_LOCK))):
            return []
        changes = await evaluate(db)
        for change in changes:
            alert = await db.get_one(Alert, change.alert_id)
            await enqueue_notifications(db, alert, change.event)
        return changes
