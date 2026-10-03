"""Current resource usage over a set of instances: totals and the top consumers.

The same aggregation serves the tenant dashboard (RLS + the actor's project visibility)
and the platform overview (every guest, optionally one tenant). Values are the live
observations the reconciler stores; nothing here calls the provider.
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import ColumnElement, Float, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.compute.models import Instance

TOP_N = 5


@dataclass
class TopEntry:
    instance: Instance
    value: float  # cpu/memory/disk: 0..1; network: bytes/s (in + out)


@dataclass
class Usage:
    instances_running: int = 0
    vcpus: int = 0
    cpu_used_vcpus: float = 0.0  # sum of cpu_usage x vcpus: "how many vCPUs are busy"
    memory_mb: int = 0
    memory_used_mb: int = 0
    disk_total_bytes: int = 0
    disk_used_bytes: int = 0
    disk_known: int = 0  # running guests whose disk usage is known (agent/container)
    net_in_bps: float = 0.0
    net_out_bps: float = 0.0
    top: dict[str, list[TopEntry]] = field(default_factory=dict)

    def totals(self) -> dict[str, int | float]:
        """Everything but `top`, which callers shape for their own audience."""
        return {k: v for k, v in vars(self).items() if k != "top"}


async def usage(db: AsyncSession, *conditions: ColumnElement[bool]) -> Usage:
    running = (*conditions, Instance.deleted_at.is_(None), Instance.power_state == "running")
    row = (
        await db.execute(
            select(
                func.count(),
                func.coalesce(func.sum(Instance.vcpus), 0),
                func.coalesce(func.sum(Instance.cpu_usage * Instance.vcpus), 0.0),
                func.coalesce(func.sum(Instance.memory_mb), 0),
                func.coalesce(func.sum(Instance.memory_used_mb), 0),
                func.coalesce(func.sum(Instance.disk_total_bytes), 0),
                func.coalesce(func.sum(Instance.disk_used_bytes), 0),
                func.count(Instance.disk_usage),
                func.coalesce(func.sum(Instance.net_in_bps), 0.0),
                func.coalesce(func.sum(Instance.net_out_bps), 0.0),
            ).where(*running)
        )
    ).one()
    out = Usage(*row)

    memory_ratio = cast(Instance.memory_used_mb, Float) / func.nullif(Instance.memory_mb, 0)
    rankings = {
        "cpu": Instance.cpu_usage,
        "memory": memory_ratio,
        "disk": Instance.disk_usage,
        "network": Instance.net_in_bps + Instance.net_out_bps,
    }
    for key, expr in rankings.items():
        rows = await db.execute(
            select(Instance, expr)
            .where(*running, expr.is_not(None), expr > 0)
            .order_by(expr.desc(), Instance.name)
            .limit(TOP_N)
        )
        out.top[key] = [TopEntry(instance, float(value)) for instance, value in rows.all()]
    return out


def tenant_ids(top: dict[str, list[TopEntry]]) -> set[uuid.UUID]:
    return {
        e.instance.tenant_id for entries in top.values() for e in entries if e.instance.tenant_id
    }
