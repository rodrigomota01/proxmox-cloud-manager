"""Tenant quotas (roadmap: minimal quota ships with creation in Phase 2a).

Usage is computed from live managed instances, *including* ones still provisioning:
the instance row is created in the same transaction as the request, so it is the
reservation (no separate reservation table needed). Requests of the same tenant are
serialized with a transaction-level advisory lock, so two concurrent creations cannot
both pass the check.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.compute.models import Instance
from app.core.config import Settings
from app.core.errors import AppError
from app.tenancy.models import TenantQuota

RESOURCES = ("instances", "vcpus", "memory_mb", "storage_gb")


class QuotaExceeded(AppError):
    status, code, title = 409, "QUOTA_EXCEEDED", "Quota exceeded"


@dataclass(frozen=True)
class QuotaLine:
    resource: str
    limit: int
    used: int

    @property
    def available(self) -> int:
        return max(self.limit - self.used, 0)


def defaults(settings: Settings) -> dict[str, int]:
    return {
        "instances": settings.default_quota_instances,
        "vcpus": settings.default_quota_vcpus,
        "memory_mb": settings.default_quota_memory_mb,
        "storage_gb": settings.default_quota_storage_gb,
    }


async def limits(db: AsyncSession, tenant_id: uuid.UUID, settings: Settings) -> dict[str, int]:
    values = defaults(settings)
    rows = await db.execute(select(TenantQuota).where(TenantQuota.tenant_id == tenant_id))
    for q in rows.scalars():
        values[q.resource] = q.limit_value
    return values


async def usage(db: AsyncSession, tenant_id: uuid.UUID) -> dict[str, int]:
    row = (
        await db.execute(
            select(
                func.count(),
                func.coalesce(func.sum(Instance.vcpus), 0),
                func.coalesce(func.sum(Instance.memory_mb), 0),
                func.coalesce(func.sum(Instance.root_disk_gb), 0),
            ).where(
                Instance.tenant_id == tenant_id,
                Instance.managed,
                Instance.deleted_at.is_(None),
            )
        )
    ).one()
    return dict(zip(RESOURCES, map(int, row), strict=True))


async def report(db: AsyncSession, tenant_id: uuid.UUID, settings: Settings) -> list[QuotaLine]:
    lim, used = await limits(db, tenant_id, settings), await usage(db, tenant_id)
    return [QuotaLine(r, lim[r], used[r]) for r in RESOURCES]


async def reserve(
    db: AsyncSession, tenant_id: uuid.UUID, settings: Settings, request: dict[str, int]
) -> None:
    """Locks the tenant's quota for this transaction and raises if `request` does not
    fit. The caller then inserts the instance row in the same transaction."""
    key = int.from_bytes(tenant_id.bytes[:8], "big", signed=True)
    await db.execute(select(func.pg_advisory_xact_lock(key)))
    lim, used = await limits(db, tenant_id, settings), await usage(db, tenant_id)
    over = [
        {"field": r, "message": f"requested {request[r]}, available {max(lim[r] - used[r], 0)}"}
        for r in RESOURCES
        if request.get(r, 0) and used[r] + request[r] > lim[r]
    ]
    if over:
        names = ", ".join(e["field"] for e in over)
        raise QuotaExceeded(f"Tenant quota exceeded for {names}", errors=over)
