import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.k8s.schemas import Health

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Price = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=6)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- prices ------------------------------------------------------------------------------


class PriceSet(Input):
    """Monthly price (730 h) per unit: vCPU and GiB of RAM while running; GiB of
    allocated disk and the per-instance fee while the instance exists."""

    vcpu: Price
    memory_gb: Price
    disk_gb: Price
    instance: Price = Decimal(0)


class PricesOut(BaseModel):
    currency: str
    hours_per_month: int
    price_table: str | None
    prices: dict[str, Decimal]


class PriceTableCreate(Input):
    name: Name
    description: Annotated[str, Field(max_length=500)] = ""
    is_default: bool = False
    prices: PriceSet


class PriceTableUpdate(Input):
    """Absent field: unchanged. New prices apply from now on; what was already accrued
    keeps the old price. `is_default` can only be turned on (that moves the flag)."""

    name: Name | None = None
    description: Annotated[str | None, Field(max_length=500)] = None
    is_default: bool | None = None
    prices: PriceSet | None = None


class PriceChangeOut(BaseModel):
    resource: str
    monthly_price: Decimal
    effective_from: datetime


class PriceTableOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    is_default: bool
    prices: dict[str, Decimal]
    tenants: list[uuid.UUID]  # tenants assigned explicitly (not via the default)
    history: list[PriceChangeOut]  # newest first


class TenantPriceTable(Input):
    price_table_id: uuid.UUID | None  # null = the default table


# full = costs and usage; usage = consumed/allocated resources only, no prices; none = hidden
CostVisibility = Literal["full", "usage", "none"]


class TenantCostVisibility(Input):
    cost_visibility: CostVisibility


class BillingAccessOut(BaseModel):
    """What this user sees of the tenant's billing (platform billing viewers: always full)."""

    cost_visibility: CostVisibility


# --- reports -----------------------------------------------------------------------------


class CostOut(BaseModel):
    vcpu: Decimal
    memory: Decimal
    disk: Decimal
    instance: Decimal
    total: Decimal


class ProjectCostOut(BaseModel):
    project_id: uuid.UUID | None
    name: str | None
    accrued: Decimal
    run_rate_monthly: Decimal


class InstanceCostOut(BaseModel):
    instance_id: uuid.UUID
    name: str
    project_id: uuid.UUID | None
    kind: str
    power_state: str
    vcpus: int
    memory_mb: int
    disk_gb: int
    deleted: bool
    hours: Decimal
    running_hours: Decimal
    accrued: CostOut
    run_rate_monthly: Decimal


class DayCostOut(BaseModel):
    date: date
    cost: Decimal


class CostSummaryOut(BaseModel):
    currency: str
    month: str  # YYYY-MM in the billing timezone
    current: bool  # the month in progress: run rate and forecast apply
    timezone: str
    prices: PricesOut
    accrued: CostOut
    run_rate: CostOut  # monthly, live instances at today's prices
    run_rate_hourly: Decimal
    forecast: Decimal | None  # accrued + run rate until the end of the month
    projects: list[ProjectCostOut]
    instances: list[InstanceCostOut]
    days: list[DayCostOut]


class TenantCostOut(BaseModel):
    tenant_id: uuid.UUID
    name: str
    slug: str
    status: str
    price_table_id: uuid.UUID | None
    price_table: str | None
    custom_price_table: bool
    cost_visibility: CostVisibility
    accrued: Decimal
    run_rate_monthly: Decimal
    forecast: Decimal | None


class PlatformCostOut(BaseModel):
    currency: str
    month: str
    current: bool
    timezone: str
    accrued: CostOut
    run_rate_monthly: Decimal
    run_rate_hourly: Decimal
    forecast: Decimal | None
    tenants: list[TenantCostOut]
    days: list[DayCostOut]


# --- usage (no prices) -------------------------------------------------------------------


class ResourceHoursOut(BaseModel):
    """Consumption in the month: vCPU and RAM count while running; disk while it exists."""

    vcpu_hours: Decimal
    memory_gib_hours: Decimal
    disk_gib_hours: Decimal


class AllocatedOut(BaseModel):
    """What the live instances hold right now."""

    instances: int
    running: int
    vcpus: int
    memory_mb: int
    disk_gb: int


class ProjectUsageOut(ResourceHoursOut):
    project_id: uuid.UUID | None
    name: str | None
    instances: int


class InstanceUsageOut(ResourceHoursOut):
    instance_id: uuid.UUID
    name: str
    project_id: uuid.UUID | None
    kind: str
    power_state: str
    vcpus: int
    memory_mb: int
    disk_gb: int
    deleted: bool
    hours: Decimal
    running_hours: Decimal


class DayUsageOut(BaseModel):
    date: date
    vcpu_hours: Decimal
    memory_gib_hours: Decimal


class ClusterUsageOut(BaseModel):
    """Last collection of a Kubernetes cluster linked to the tenant (not month-bound).
    CPU in cores, memory in bytes; usage is None without metrics-server."""

    cluster_id: uuid.UUID
    name: str
    health: Health | None
    collected_at: datetime | None
    nodes: int
    nodes_ready: int
    namespaces: int
    pods: int
    cpu_capacity: float
    cpu_allocatable: float
    cpu_requests: float
    cpu_usage: float | None
    mem_capacity: float
    mem_allocatable: float
    mem_requests: float
    mem_usage: float | None


class UsageReportOut(BaseModel):
    month: str
    current: bool
    timezone: str
    consumed: ResourceHoursOut
    allocated: AllocatedOut
    projects: list[ProjectUsageOut]
    instances: list[InstanceUsageOut]
    days: list[DayUsageOut]
    clusters: list[ClusterUsageOut]  # empty without k8s:view
