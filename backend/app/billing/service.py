"""Cost reports: what was accrued in a month and what the live instances cost now.

- accrued: sum of usage_records in the month (months follow CM_BILLING_TIMEZONE);
- run rate: live billable instances priced at today's rates, as a monthly figure;
- forecast (current month only): accrued + run rate over the hours left in the month.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import BigInteger, ColumnElement, Date, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.billing.accrual import billable
from app.billing.models import UsageRecord
from app.billing.pricing import HOURS, ZERO, Cost, Rates, monthly_cost, rates_by_tenant
from app.compute.models import Instance
from app.core.errors import ValidationError
from app.tenancy.models import Project, Tenant


@dataclass(frozen=True)
class Month:
    label: str  # YYYY-MM
    start: datetime  # aware, in the billing timezone
    end: datetime
    current: bool

    def hours_left(self, now: datetime) -> Decimal:
        if not self.current:
            return ZERO
        return Decimal(max((self.end - now).total_seconds(), 0)) / 3600


def month_of(label: str | None, tz_name: str, now: datetime) -> Month:
    tz = ZoneInfo(tz_name)
    local_now = now.astimezone(tz)
    if label is None:
        year, month = local_now.year, local_now.month
    else:
        try:
            year, month = (int(p) for p in label.split("-"))
            date(year, month, 1)
        except ValueError as exc:
            raise ValidationError(
                errors=[{"field": "month", "message": "use YYYY-MM"}]
            ) from exc
    start = datetime(year, month, 1, tzinfo=tz)
    end = datetime(year + month // 12, month % 12 + 1, 1, tzinfo=tz)
    if start > local_now:
        raise ValidationError(errors=[{"field": "month", "message": "month in the future"}])
    return Month(f"{year:04d}-{month:02d}", start, end, start <= local_now < end)


def _cost_columns():
    return (
        func.coalesce(func.sum(UsageRecord.cost_vcpu), 0),
        func.coalesce(func.sum(UsageRecord.cost_memory), 0),
        func.coalesce(func.sum(UsageRecord.cost_disk), 0),
        func.coalesce(func.sum(UsageRecord.cost_instance), 0),
    )


@dataclass
class Line:
    """One row of a breakdown: accrued in the month + monthly run rate now."""

    accrued: Cost = field(default_factory=Cost)
    run_rate: Cost = field(default_factory=Cost)


@dataclass
class InstanceLine(Line):
    instance: Instance = None  # type: ignore[assignment] - set once loaded
    hours: Decimal = ZERO
    running_hours: Decimal = ZERO


def _usage_columns():
    """vCPU-seconds and MiB-seconds while running, GiB-seconds of disk while it exists,
    seconds existing and running."""
    def total(unit, seconds):  # bigint: MiB x seconds overflows an integer
        return func.coalesce(func.sum(cast(unit, BigInteger) * seconds), 0)

    return (
        total(UsageRecord.vcpus, UsageRecord.running_seconds),
        total(UsageRecord.memory_mb, UsageRecord.running_seconds),
        total(UsageRecord.disk_gb, UsageRecord.seconds),
        func.coalesce(func.sum(UsageRecord.seconds), 0),
        func.coalesce(func.sum(UsageRecord.running_seconds), 0),
    )


@dataclass
class Hours:
    vcpu: Decimal = ZERO
    memory_gib: Decimal = ZERO
    disk_gib: Decimal = ZERO

    def __iadd__(self, other: "Hours") -> "Hours":
        self.vcpu += other.vcpu
        self.memory_gib += other.memory_gib
        self.disk_gib += other.disk_gib
        return self


@dataclass
class UsageLine:
    hours: Hours = field(default_factory=Hours)
    seconds: int = 0
    running_seconds: int = 0
    instance: Instance = None  # type: ignore[assignment] - set once loaded


@dataclass
class ProjectUsage:
    hours: Hours = field(default_factory=Hours)
    instances: int = 0


@dataclass
class Allocated:
    instances: int = 0
    running: int = 0
    vcpus: int = 0
    memory_mb: int = 0
    disk_gb: int = 0

    def add(self, i: Instance) -> None:
        self.instances += 1
        self.running += i.power_state == "running"
        self.vcpus += i.vcpus
        self.memory_mb += i.memory_mb
        self.disk_gb += i.root_disk_gb


@dataclass
class UsageReport:
    month: Month
    total: Hours
    allocated: Allocated
    projects: dict[uuid.UUID | None, ProjectUsage]
    project_names: dict[uuid.UUID, str]
    instances: list[UsageLine]
    days: list[tuple[date, Decimal, Decimal]]


@dataclass
class TenantReport:
    month: Month
    rates: Rates
    total: Line
    forecast: Decimal | None
    projects: dict[uuid.UUID | None, Line]
    project_names: dict[uuid.UUID, str]
    instances: list[InstanceLine]
    days: list[tuple[date, Decimal]]


class BillingReports:
    def __init__(self, db: AsyncSession, tz_name: str) -> None:
        self.db, self.tz = db, tz_name

    def _in_month(self, m: Month) -> tuple[ColumnElement[bool], ...]:
        return (UsageRecord.period_start >= m.start, UsageRecord.period_start < m.end)

    async def _days(self, *where: ColumnElement[bool]) -> list[tuple[date, Decimal]]:
        """Cost per local day. The zone is rendered inline: as a bind parameter, the
        SELECT and GROUP BY copies would be different parameters to Postgres."""
        day = cast(
            func.timezone(literal(self.tz, literal_execute=True), UsageRecord.period_start), Date
        )
        total = (UsageRecord.cost_vcpu + UsageRecord.cost_memory + UsageRecord.cost_disk
                 + UsageRecord.cost_instance)
        rows = await self.db.execute(
            select(day, func.sum(total)).where(*where).group_by(day).order_by(day)
        )
        return [(d, c) for d, c in rows]

    async def tenant(
        self, tenant_id: uuid.UUID, projects: set[uuid.UUID] | None, m: Month, now: datetime
    ) -> TenantReport:
        """`projects` None = the whole tenant; otherwise only those projects."""
        scope = [UsageRecord.tenant_id == tenant_id, *self._in_month(m)]
        live = [Instance.tenant_id == tenant_id, *billable()]
        if projects is not None:
            scope.append(UsageRecord.project_id.in_(projects))
            live.append(Instance.project_id.in_(projects))

        rates = (await rates_by_tenant(self.db, {tenant_id}))[tenant_id]
        by_instance: dict[uuid.UUID, InstanceLine] = {}
        rows = await self.db.execute(
            select(
                UsageRecord.instance_id, *_cost_columns(),
                func.sum(UsageRecord.seconds), func.sum(UsageRecord.running_seconds),
            ).where(*scope).group_by(UsageRecord.instance_id)
        )
        for iid, cv, cm, cd, ci, secs, run in rows:
            by_instance[iid] = InstanceLine(
                accrued=Cost(cv, cm, cd, ci),
                hours=Decimal(secs) / 3600, running_hours=Decimal(run) / 3600,
            )
        if m.current:
            for i in (await self.db.execute(select(Instance).where(*live))).scalars():
                line = by_instance.setdefault(i.id, InstanceLine())
                line.run_rate = monthly_cost(
                    rates, vcpus=i.vcpus, memory_mb=i.memory_mb, disk_gb=i.root_disk_gb,
                    running=i.power_state == "running",
                )
        if by_instance:
            found = await self.db.execute(
                select(Instance).where(Instance.id.in_(by_instance))
            )
            for i in found.scalars():
                by_instance[i.id].instance = i

        total, projects_out = Line(), defaultdict(Line)
        for line in by_instance.values():
            total.accrued += line.accrued
            total.run_rate += line.run_rate
            p = projects_out[line.instance.project_id]
            p.accrued += line.accrued
            p.run_rate += line.run_rate
        names = dict((await self.db.execute(
            select(Project.id, Project.name).where(Project.tenant_id == tenant_id)
        )).all())

        instances = sorted(
            by_instance.values(),
            key=lambda line: (-line.accrued.total, -line.run_rate.total, line.instance.name),
        )
        return TenantReport(
            month=m, rates=rates, total=total,
            forecast=forecast(total, m, now),
            projects=dict(projects_out), project_names=names, instances=instances,
            days=await self._days(*scope),
        )

    async def usage(
        self, tenant_id: uuid.UUID, projects: set[uuid.UUID] | None, m: Month
    ) -> "UsageReport":
        """Resource consumption in the month (no prices) and what is allocated now."""
        scope = [UsageRecord.tenant_id == tenant_id, *self._in_month(m)]
        live = [Instance.tenant_id == tenant_id, *billable()]
        if projects is not None:
            scope.append(UsageRecord.project_id.in_(projects))
            live.append(Instance.project_id.in_(projects))

        by_instance: dict[uuid.UUID, UsageLine] = {}
        rows = await self.db.execute(
            select(UsageRecord.instance_id, *_usage_columns()).where(*scope)
            .group_by(UsageRecord.instance_id)
        )
        for iid, cpu, mem, disk, secs, run in rows:
            by_instance[iid] = UsageLine(
                hours=Hours(Decimal(cpu) / 3600, Decimal(mem) / 1024 / 3600,
                            Decimal(disk) / 3600),
                seconds=secs, running_seconds=run,
            )
        allocated = Allocated()
        for i in (await self.db.execute(select(Instance).where(*live))).scalars():
            by_instance.setdefault(i.id, UsageLine())
            allocated.add(i)
        if by_instance:
            found = await self.db.execute(select(Instance).where(Instance.id.in_(by_instance)))
            for i in found.scalars():
                by_instance[i.id].instance = i

        total, per_project = Hours(), defaultdict(ProjectUsage)
        for line in by_instance.values():
            total += line.hours
            p = per_project[line.instance.project_id]
            p.hours += line.hours
            p.instances += 1
        names = dict((await self.db.execute(
            select(Project.id, Project.name).where(Project.tenant_id == tenant_id)
        )).all())

        day = cast(
            func.timezone(literal(self.tz, literal_execute=True), UsageRecord.period_start), Date
        )
        cpu, mem = _usage_columns()[:2]
        days = [
            (d, Decimal(c) / 3600, Decimal(g) / 1024 / 3600)
            for d, c, g in await self.db.execute(
                select(day, cpu, mem).where(*scope).group_by(day).order_by(day)
            )
        ]
        return UsageReport(
            month=m, total=total, allocated=allocated, projects=dict(per_project),
            project_names=names,
            instances=sorted(by_instance.values(), key=lambda line: (
                -line.hours.vcpu, -line.hours.disk_gib, line.instance.name,
            )),
            days=days,
        )

    async def platform(self, m: Month, now: datetime) -> "PlatformReport":
        lines: dict[uuid.UUID, Line] = defaultdict(Line)
        rows = await self.db.execute(
            select(UsageRecord.tenant_id, *_cost_columns())
            .where(*self._in_month(m)).group_by(UsageRecord.tenant_id)
        )
        for tid, cv, cm, cd, ci in rows:
            lines[tid].accrued = Cost(cv, cm, cd, ci)

        tenants = (await self.db.execute(select(Tenant).order_by(Tenant.name))).scalars().all()
        rates = await rates_by_tenant(self.db, {t.id for t in tenants})
        if m.current:
            for i in (await self.db.execute(select(Instance).where(*billable()))).scalars():
                if i.tenant_id in rates:
                    lines[i.tenant_id].run_rate += monthly_cost(
                        rates[i.tenant_id], vcpus=i.vcpus, memory_mb=i.memory_mb,
                        disk_gb=i.root_disk_gb, running=i.power_state == "running",
                    )
        total = Line()
        for line in lines.values():
            total.accrued += line.accrued
            total.run_rate += line.run_rate
        return PlatformReport(
            month=m, total=total, forecast=forecast(total, m, now),
            tenants=[
                (t, rates[t.id], line, forecast(line, m, now))
                for t in tenants
                for line in (lines.get(t.id, Line()),)
            ],
            days=await self._days(*self._in_month(m)),
        )


@dataclass
class PlatformReport:
    month: Month
    total: Line
    forecast: Decimal | None
    tenants: list[tuple[Tenant, Rates, Line, Decimal | None]]
    days: list[tuple[date, Decimal]]


def forecast(line: Line, m: Month, now: datetime) -> Decimal | None:
    if not m.current:
        return None
    return line.accrued.total + line.run_rate.total / HOURS * m.hours_left(now)


def hourly(monthly: Decimal) -> Decimal:
    return monthly / HOURS

