"""Which prices apply to a tenant, and what a sizing costs under them.

Money is Decimal end to end (numeric(18,6) in the database); floats never touch it.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.billing.models import HOURS_PER_MONTH, PriceItem, PriceTable
from app.tenancy.models import Tenant

ZERO = Decimal(0)
HOURS = Decimal(HOURS_PER_MONTH)


@dataclass(frozen=True)
class Rates:
    """Monthly price per unit of each resource; missing resource = free."""

    table_id: uuid.UUID | None = None
    table_name: str | None = None
    monthly: dict[str, Decimal] = field(default_factory=dict)

    def price(self, resource: str) -> Decimal:
        return self.monthly.get(resource, ZERO)


@dataclass(frozen=True)
class Cost:
    vcpu: Decimal = ZERO
    memory: Decimal = ZERO
    disk: Decimal = ZERO
    instance: Decimal = ZERO

    @property
    def total(self) -> Decimal:
        return self.vcpu + self.memory + self.disk + self.instance

    def __add__(self, other: "Cost") -> "Cost":
        return Cost(self.vcpu + other.vcpu, self.memory + other.memory,
                    self.disk + other.disk, self.instance + other.instance)

    def scaled(self, factor: Decimal) -> "Cost":
        return Cost(self.vcpu * factor, self.memory * factor,
                    self.disk * factor, self.instance * factor)


def monthly_cost(
    rates: Rates, *, vcpus: int, memory_mb: int, disk_gb: int, running: bool
) -> Cost:
    """A full month (730 h) in this state. Compute is charged only while running;
    allocated disk and the per-instance fee for as long as the instance exists."""
    return Cost(
        vcpu=rates.price("vcpu") * vcpus if running else ZERO,
        memory=rates.price("memory_gb") * Decimal(memory_mb) / 1024 if running else ZERO,
        disk=rates.price("disk_gb") * disk_gb,
        instance=rates.price("instance"),
    )


def cost_for(seconds: int, monthly: Cost) -> Cost:
    return monthly.scaled(Decimal(seconds) / (HOURS * 3600))


async def table_rates(
    db: AsyncSession, table_ids: set[uuid.UUID], at: datetime | None = None
) -> dict[uuid.UUID, dict[str, Decimal]]:
    """Per table, the latest price of each resource effective at `at` (default: now)."""
    if not table_ids:
        return {}
    at_ = at if at is not None else func.now()
    latest = (
        select(PriceItem.price_table_id, PriceItem.resource,
               func.max(PriceItem.effective_from).label("since"))
        .where(PriceItem.price_table_id.in_(table_ids), PriceItem.effective_from <= at_)
        .group_by(PriceItem.price_table_id, PriceItem.resource)
        .subquery()
    )
    rows = await db.execute(
        select(PriceItem.price_table_id, PriceItem.resource, PriceItem.monthly_price).join(
            latest,
            (PriceItem.price_table_id == latest.c.price_table_id)
            & (PriceItem.resource == latest.c.resource)
            & (PriceItem.effective_from == latest.c.since),
        )
    )
    out: dict[uuid.UUID, dict[str, Decimal]] = {t: {} for t in table_ids}
    for table_id, resource, price in rows:
        out[table_id][resource] = price
    return out


async def rates_by_tenant(
    db: AsyncSession, tenant_ids: set[uuid.UUID], at: datetime | None = None
) -> dict[uuid.UUID, Rates]:
    """Rates for each tenant: its own table, else the default one, else nothing (free)."""
    default = (await db.execute(select(PriceTable).where(PriceTable.is_default))).scalar()
    own = dict((await db.execute(
        select(Tenant.id, Tenant.price_table_id).where(Tenant.id.in_(tenant_ids))
    )).all()) if tenant_ids else {}
    chosen = {
        t: own.get(t) or (default.id if default else None) for t in tenant_ids
    }
    ids = {t for t in chosen.values() if t is not None}
    names = dict((await db.execute(
        select(PriceTable.id, PriceTable.name).where(PriceTable.id.in_(ids))
    )).all()) if ids else {}
    prices = await table_rates(db, ids, at)
    return {
        t: Rates(table_id, names.get(table_id), prices.get(table_id, {}))
        if table_id else Rates()
        for t, table_id in chosen.items()
    }


async def tenant_rates(db: AsyncSession, tenant_id: uuid.UUID) -> Rates:
    return (await rates_by_tenant(db, {tenant_id}))[tenant_id]

