"""/billing/* (tenant, X-Tenant-Id) and /admin/billing, /admin/price-tables (platform)."""

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AppSettings, CurrentTenant, DbSession, Principal, require_platform
from app.audit import service as audit
from app.billing.models import HOURS_PER_MONTH, RESOURCES, PriceItem, PriceTable
from app.billing.pricing import HOURS, Cost, Rates, table_rates, tenant_rates
from app.billing.schemas import (
    CostOut,
    CostSummaryOut,
    DayCostOut,
    InstanceCostOut,
    PlatformCostOut,
    PriceChangeOut,
    PricesOut,
    PriceTableCreate,
    PriceTableOut,
    PriceTableUpdate,
    ProjectCostOut,
    TenantCostOut,
    TenantPriceTable,
)
from app.billing.service import BillingReports, month_of
from app.core.config import Settings
from app.core.errors import Conflict, NotFound
from app.iam.authz import Scope, authorize, effective_permissions, projects_with_permission
from app.tenancy.models import Tenant

router = APIRouter(tags=["billing"])
admin_router = APIRouter(prefix="/admin", tags=["admin"])

BillingViewer = Annotated[Principal, require_platform("billing:view")]
BillingAdmin = Annotated[Principal, require_platform("billing:manage")]
MonthParam = Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}$", description="YYYY-MM")]
CENT_FRACTION = Decimal("0.000001")


def q(value: Decimal) -> Decimal:
    return Decimal(value).quantize(CENT_FRACTION)


def cost_out(c: Cost) -> CostOut:
    return CostOut(vcpu=q(c.vcpu), memory=q(c.memory), disk=q(c.disk),
                   instance=q(c.instance), total=q(c.total))


def prices_out(rates: Rates, settings: Settings) -> PricesOut:
    return PricesOut(
        currency=settings.billing_currency, hours_per_month=HOURS_PER_MONTH,
        price_table=rates.table_name,
        prices={r: q(rates.price(r)) for r in RESOURCES},
    )


async def _now(db: AsyncSession):
    return await db.scalar(select(func.now()))


# --- tenant ------------------------------------------------------------------------------


@router.get("/billing/prices")
async def tenant_prices(ctx: CurrentTenant, db: DbSession, settings: AppSettings) -> PricesOut:
    """Today's prices for the tenant: any member (the creation form shows an estimate)."""
    return prices_out(await tenant_rates(db, ctx.tenant_id), settings)


async def _billing_projects(db: AsyncSession, ctx) -> set[uuid.UUID] | None:
    """billing:view at tenant (or platform) level: everything (None). Otherwise only the
    projects where a project-level binding grants it; none at all -> denied."""
    user = ctx.principal.user_id
    if "billing:view" in await effective_permissions(db, user, Scope(ctx.tenant_id)):
        return None
    projects = await projects_with_permission(db, user, ctx.tenant_id, "billing:view")
    if not projects:
        await authorize(db, user, "billing:view", Scope(ctx.tenant_id))  # raises + audits
    return projects


@router.get("/billing/summary")
async def tenant_summary(
    ctx: CurrentTenant, db: DbSession, settings: AppSettings, month: MonthParam = None
) -> CostSummaryOut:
    projects = await _billing_projects(db, ctx)
    now = await _now(db)
    m = month_of(month, settings.billing_timezone, now)
    r = await BillingReports(db, settings.billing_timezone).tenant(ctx.tenant_id, projects, m, now)
    return CostSummaryOut(
        currency=settings.billing_currency, month=m.label, current=m.current,
        timezone=settings.billing_timezone, prices=prices_out(r.rates, settings),
        accrued=cost_out(r.total.accrued), run_rate=cost_out(r.total.run_rate),
        run_rate_hourly=q(r.total.run_rate.total / HOURS),
        forecast=q(r.forecast) if r.forecast is not None else None,
        projects=sorted(
            (ProjectCostOut(
                project_id=pid, name=r.project_names.get(pid) if pid else None,
                accrued=q(line.accrued.total), run_rate_monthly=q(line.run_rate.total),
            ) for pid, line in r.projects.items()),
            key=lambda p: (-p.accrued, -p.run_rate_monthly, p.name or ""),
        ),
        instances=[
            InstanceCostOut(
                instance_id=i.id, name=i.name, project_id=i.project_id, kind=i.kind,
                power_state=i.power_state, vcpus=i.vcpus, memory_mb=i.memory_mb,
                disk_gb=i.root_disk_gb, deleted=i.deleted_at is not None,
                hours=q(line.hours), running_hours=q(line.running_hours),
                accrued=cost_out(line.accrued), run_rate_monthly=q(line.run_rate.total),
            )
            for line in r.instances
            for i in (line.instance,)
        ],
        days=[DayCostOut(date=d, cost=q(c)) for d, c in r.days],
    )


# --- platform ----------------------------------------------------------------------------


@admin_router.get("/billing/summary")
async def platform_summary(
    _: BillingViewer, db: DbSession, settings: AppSettings, month: MonthParam = None
) -> PlatformCostOut:
    """Cost per tenant (client) in the month; the detail of one tenant is its own
    /billing/summary (platform admins may enter any tenant)."""
    now = await _now(db)
    m = month_of(month, settings.billing_timezone, now)
    r = await BillingReports(db, settings.billing_timezone).platform(m, now)
    return PlatformCostOut(
        currency=settings.billing_currency, month=m.label, current=m.current,
        timezone=settings.billing_timezone, accrued=cost_out(r.total.accrued),
        run_rate_monthly=q(r.total.run_rate.total),
        run_rate_hourly=q(r.total.run_rate.total / HOURS),
        forecast=q(r.forecast) if r.forecast is not None else None,
        tenants=sorted(
            (TenantCostOut(
                tenant_id=t.id, name=t.name, slug=t.slug, status=t.status,
                price_table_id=rates.table_id, price_table=rates.table_name,
                custom_price_table=t.price_table_id is not None,
                accrued=q(line.accrued.total), run_rate_monthly=q(line.run_rate.total),
                forecast=q(fc) if fc is not None else None,
            ) for t, rates, line, fc in r.tenants),
            key=lambda t: (-t.accrued, -t.run_rate_monthly, t.name),
        ),
        days=[DayCostOut(date=d, cost=q(c)) for d, c in r.days],
    )


async def _table_out(db: AsyncSession, t: PriceTable) -> PriceTableOut:
    prices = (await table_rates(db, {t.id})).get(t.id, {})
    tenants = (await db.execute(
        select(Tenant.id).where(Tenant.price_table_id == t.id).order_by(Tenant.name)
    )).scalars().all()
    history = (await db.execute(
        select(PriceItem).where(PriceItem.price_table_id == t.id)
        .order_by(PriceItem.effective_from.desc(), PriceItem.resource).limit(100)
    )).scalars().all()
    return PriceTableOut(
        id=t.id, name=t.name, description=t.description, is_default=t.is_default,
        prices={r: q(prices.get(r, Decimal(0))) for r in RESOURCES}, tenants=list(tenants),
        history=[PriceChangeOut(resource=h.resource, monthly_price=q(h.monthly_price),
                                effective_from=h.effective_from) for h in history],
    )


async def _get_table(db: AsyncSession, table_id: uuid.UUID) -> PriceTable:
    table = await db.get(PriceTable, table_id)
    if table is None:
        raise NotFound()
    return table


async def _make_default(db: AsyncSession, table: PriceTable) -> None:
    current = (await db.execute(
        select(PriceTable).where(PriceTable.is_default, PriceTable.id != table.id)
    )).scalars().all()
    for other in current:
        other.is_default = False
    await db.flush()  # the partial unique index allows one default at a time
    table.is_default = True


async def _set_prices(
    db: AsyncSession, table: PriceTable, prices: dict[str, Decimal]
) -> dict[str, str]:
    """Inserts a new item for each changed price (effective now). Returns the changes."""
    current = (await table_rates(db, {table.id})).get(table.id, {})
    changed = {r: p for r, p in prices.items() if current.get(r) != p}
    for resource, price in changed.items():
        db.add(PriceItem(price_table_id=table.id, resource=resource, monthly_price=price))
    return {r: str(p) for r, p in changed.items()}


NAME_TAKEN = "A price table with this name already exists"


@admin_router.get("/price-tables")
async def list_price_tables(_: BillingAdmin, db: DbSession) -> list[PriceTableOut]:
    tables = (await db.execute(
        select(PriceTable).order_by(PriceTable.is_default.desc(), PriceTable.name)
    )).scalars().all()
    return [await _table_out(db, t) for t in tables]


@admin_router.post("/price-tables", status_code=status.HTTP_201_CREATED)
async def create_price_table(
    body: PriceTableCreate, response: Response, principal: BillingAdmin, db: DbSession
) -> PriceTableOut:
    table = PriceTable(name=body.name, description=body.description)
    try:
        async with db.begin_nested():
            db.add(table)
    except IntegrityError as exc:
        raise Conflict(NAME_TAKEN) from exc
    if body.is_default:
        await _make_default(db, table)
    await _set_prices(db, table, body.prices.model_dump())
    await db.flush()
    await audit.record(
        db, "PRICE_TABLE_CREATE", actor_user_id=principal.user_id,
        resource_type="price_table", resource_id=table.id,
        details={"name": table.name, "prices": body.prices.model_dump(mode="json"),
                 "is_default": body.is_default},
    )
    response.headers["Location"] = f"/api/v1/admin/price-tables/{table.id}"
    return await _table_out(db, table)


@admin_router.patch("/price-tables/{table_id}")
async def update_price_table(
    table_id: uuid.UUID, body: PriceTableUpdate, principal: BillingAdmin, db: DbSession
) -> PriceTableOut:
    table = await _get_table(db, table_id)
    details: dict[str, object] = {}
    if body.name is not None and body.name != table.name:
        details["name"] = body.name
        table.name = body.name
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError as exc:
            raise Conflict(NAME_TAKEN) from exc
    if body.description is not None:
        table.description = body.description
    if body.is_default is False and table.is_default:
        raise Conflict("Choose another table as default instead")
    if body.is_default and not table.is_default:
        await _make_default(db, table)
        details["is_default"] = True
    if body.prices is not None:
        if changed := await _set_prices(db, table, body.prices.model_dump()):
            details["prices"] = changed
    await db.flush()
    if details:
        await audit.record(
            db, "PRICE_TABLE_UPDATE", actor_user_id=principal.user_id,
            resource_type="price_table", resource_id=table.id, details=details,
        )
    return await _table_out(db, table)


@admin_router.delete("/price-tables/{table_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_price_table(table_id: uuid.UUID, principal: BillingAdmin, db: DbSession) -> None:
    table = await _get_table(db, table_id)
    if table.is_default:
        raise Conflict("The default price table cannot be deleted")
    in_use = await db.scalar(
        select(func.count()).select_from(Tenant).where(Tenant.price_table_id == table.id)
    )
    if in_use:
        raise Conflict(f"Price table is assigned to {in_use} tenant(s)")
    await audit.record(
        db, "PRICE_TABLE_DELETE", actor_user_id=principal.user_id,
        resource_type="price_table", resource_id=table.id, details={"name": table.name},
    )
    await db.delete(table)


@admin_router.put("/tenants/{tenant_id}/price-table")
async def set_tenant_price_table(
    tenant_id: uuid.UUID, body: TenantPriceTable, principal: BillingAdmin, db: DbSession
) -> TenantPriceTable:
    """From now on; what the tenant already accrued keeps the prices of the time."""
    tenant = await db.get(Tenant, tenant_id)
    if tenant is None:
        raise NotFound()
    if body.price_table_id is not None:
        await _get_table(db, body.price_table_id)
    tenant.price_table_id = body.price_table_id
    await audit.record(
        db, "TENANT_PRICE_TABLE_SET", actor_user_id=principal.user_id, tenant_id=tenant.id,
        resource_type="tenant", resource_id=tenant.id,
        details={"price_table_id": str(body.price_table_id) if body.price_table_id else None},
    )
    return body
