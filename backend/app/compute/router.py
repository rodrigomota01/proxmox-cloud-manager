"""/api/v1/instances, /jobs and /dashboard/summary (tenant scope via X-Tenant-Id)."""

import uuid
from dataclasses import asdict
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AppSettings, CurrentTenant, DbSession, RedisClient
from app.compute.models import Instance, operable
from app.compute.schemas import (
    Accepted,
    DashboardSummary,
    DiskUsageOut,
    FilesystemOut,
    InstanceAccepted,
    InstanceCreate,
    InstanceDelete,
    InstanceOut,
    JobDetail,
    JobEventOut,
    JobOut,
    MetricPointOut,
    MetricsOut,
    QuotaLineOut,
    TopInstanceOut,
    TopInstancesOut,
    UsageOut,
)
from app.compute.service import ComputeService
from app.compute.usage import TopEntry
from app.core.errors import ProviderUnavailableError
from app.core.pagination import PageParams, page_params
from app.inventory.models import ProviderCluster
from app.jobs.presenter import job_out, jobs_out
from app.providers.base import ProviderError, ProviderRef
from app.regions.models import Region, Zone
from app.tenancy import quota
from app.tenancy.schemas import Page

router = APIRouter()

Pagination = Annotated[PageParams, Depends(page_params)]
IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)]
# history moves slowly past the last hour: cache longer there
METRICS_TTL = {"hour": 30, "day": 300, "week": 300}


Places = dict[uuid.UUID, tuple[uuid.UUID | None, str | None, str | None, dict]]


async def places(db: AsyncSession) -> Places:
    """cluster id -> (zone id, zone name, region name, settings); servers stay hidden."""
    rows = await db.execute(
        select(ProviderCluster.id, Zone.id, Zone.name, Region.name, ProviderCluster.settings)
        .outerjoin(Zone, Zone.id == ProviderCluster.zone_id)
        .outerjoin(Region, Region.id == Zone.region_id)
    )
    return {cid: (zid, zname, rname, cfg) for cid, zid, zname, rname, cfg in rows}


def disk_out(i: Instance) -> DiskUsageOut:
    return DiskUsageOut(
        usage=i.disk_usage, used_bytes=i.disk_used_bytes, total_bytes=i.disk_total_bytes,
        filesystems=[FilesystemOut(**f) for f in i.filesystems or []],
        agent=i.guest_agent, checked_at=i.disk_checked_at,
    )


def instance_out(i: Instance, where: Places) -> InstanceOut:
    zone_id, zone_name, region_name, settings = where.get(i.cluster_id, (None, None, None, {}))
    if i.project_id is None:  # DB constraint: managed instances always have a project
        raise RuntimeError(f"managed instance {i.id} without project")
    return InstanceOut(
        id=i.id, project_id=i.project_id, kind=i.kind, name=i.name, state=i.state,
        power_state=i.power_state, vcpus=i.vcpus, memory_mb=i.memory_mb,
        root_disk_gb=i.root_disk_gb, tags=i.tags, image_id=i.image_id,
        zone_id=zone_id, zone_name=zone_name, region_name=region_name,
        read_only=not operable(i, settings),
        cpu_usage=i.cpu_usage, memory_used_mb=i.memory_used_mb,
        uptime_seconds=i.uptime_seconds,
        net_in_bps=i.net_in_bps, net_out_bps=i.net_out_bps, disk=disk_out(i),
        ipv4=i.network.get("address"), gateway=i.network.get("gateway"),
        created_at=i.created_at, last_seen_at=i.last_seen_at,
    )


@router.get("/instances", tags=["instances"])
async def list_instances(
    ctx: CurrentTenant, db: DbSession, page: Pagination,
    project_id: uuid.UUID | None = None,
    kind: Literal["vm", "container"] | None = None,
    power_state: Literal["running", "stopped", "paused", "unknown"] | None = None,
) -> Page[InstanceOut]:
    items, cursor = await ComputeService(db, ctx).list_instances(
        page, project_id=project_id, kind=kind, power_state=power_state
    )
    where = await places(db)
    return Page(items=[instance_out(i, where) for i in items], next_cursor=cursor)


@router.get("/instances/{instance_id}", tags=["instances"])
async def get_instance(instance_id: uuid.UUID, ctx: CurrentTenant, db: DbSession) -> InstanceOut:
    return instance_out(await ComputeService(db, ctx).get(instance_id), await places(db))


@router.get("/instances/{instance_id}/metrics", tags=["instances"])
async def instance_metrics(
    instance_id: uuid.UUID, request: Request, ctx: CurrentTenant, db: DbSession,
    redis: RedisClient, range_: Annotated[
        Literal["hour", "day", "week"], Query(alias="range")
    ] = "hour",
) -> MetricsOut:
    instance = await ComputeService(db, ctx).get(instance_id)  # authorizes {kind}:view
    key = f"metrics:{instance.id}:{range_}"
    if cached := await redis.get(key):
        return MetricsOut.model_validate_json(cached)
    out = MetricsOut(range=range_, points=[])
    if "vmid" in instance.provider_ref:
        cluster = await db.get_one(ProviderCluster, instance.cluster_id)
        try:
            async with request.app.state.providers.open(db, cluster) as provider:
                points = await provider.metrics(ProviderRef(instance.provider_ref), range_)
        except ProviderError as exc:
            raise ProviderUnavailableError("Metrics are temporarily unavailable") from exc
        out.points = [
            MetricPointOut(t=p.time, **{k: v for k, v in asdict(p).items() if k != "time"})
            for p in points
        ]
    await redis.set(key, out.model_dump_json(), ex=METRICS_TTL[range_])
    return out


@router.post("/instances", status_code=status.HTTP_202_ACCEPTED, tags=["instances"])
async def create_instance(
    body: InstanceCreate, response: Response, ctx: CurrentTenant, db: DbSession,
    settings: AppSettings, idempotency_key: IdempotencyKey = None,
) -> InstanceAccepted:
    instance, job = await ComputeService(db, ctx, settings).create(body, idempotency_key)
    await db.refresh(instance)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/jobs/{job.id}"
    return InstanceAccepted(
        instance=instance_out(instance, await places(db)), job=await job_out(db, job)
    )


@router.delete(
    "/instances/{instance_id}", status_code=status.HTTP_202_ACCEPTED, tags=["instances"]
)
async def delete_instance(
    instance_id: uuid.UUID, body: InstanceDelete, response: Response, ctx: CurrentTenant,
    db: DbSession, idempotency_key: IdempotencyKey = None,
) -> Accepted:
    job = await ComputeService(db, ctx).delete(instance_id, body.confirm, idempotency_key)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/jobs/{job.id}"
    return Accepted(job=await job_out(db, job))


@router.get("/quotas", tags=["quotas"])
async def tenant_quotas(
    ctx: CurrentTenant, db: DbSession, settings: AppSettings
) -> list[QuotaLineOut]:
    lines = await quota.report(db, ctx.tenant_id, settings)
    return [
        QuotaLineOut(resource=q.resource, limit=q.limit, used=q.used, available=q.available)
        for q in lines
    ]


@router.post(
    "/instances/{instance_id}/{action}",
    status_code=status.HTTP_202_ACCEPTED,
    tags=["instances"],
)
async def power_action(
    instance_id: uuid.UUID,
    action: Literal["start", "stop", "shutdown", "restart"],
    response: Response,
    ctx: CurrentTenant,
    db: DbSession,
    idempotency_key: IdempotencyKey = None,
) -> Accepted:
    job = await ComputeService(db, ctx).power(instance_id, action, idempotency_key)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/jobs/{job.id}"
    return Accepted(job=await job_out(db, job))


@router.get("/jobs", tags=["jobs"])
async def list_jobs(
    ctx: CurrentTenant, db: DbSession, page: Pagination,
    status: Literal["pending", "running", "succeeded", "failed", "cancelled"] | None = None,
    resource_id: uuid.UUID | None = None,
    job_type: Annotated[
        Literal["instance.power", "instance.create", "instance.delete"] | None,
        Query(alias="type"),
    ] = None,
) -> Page[JobOut]:
    items, cursor = await ComputeService(db, ctx).list_jobs(
        page, status=status, resource_id=resource_id, job_type=job_type
    )
    return Page(items=await jobs_out(db, items), next_cursor=cursor)


@router.get("/jobs/{job_id}", tags=["jobs"])
async def get_job(job_id: uuid.UUID, ctx: CurrentTenant, db: DbSession) -> JobDetail:
    job, events = await ComputeService(db, ctx).get_job(job_id)
    return JobDetail(
        **(await job_out(db, job)).model_dump(),
        # event data (provider task ids, node names) stays admin-only
        events=[JobEventOut(kind=e.kind, message=e.message, occurred_at=e.occurred_at)
                for e in events],
    )


def top_instance_out(e: TopEntry) -> TopInstanceOut:
    i = e.instance
    return TopInstanceOut(
        id=i.id, name=i.name, kind=i.kind, project_id=i.project_id, value=e.value,
        vcpus=i.vcpus, memory_mb=i.memory_mb, memory_used_mb=i.memory_used_mb,
        cpu_usage=i.cpu_usage, disk_usage=i.disk_usage,
        net_in_bps=i.net_in_bps, net_out_bps=i.net_out_bps,
    )


@router.get("/dashboard/usage", tags=["dashboard"])
async def dashboard_usage(ctx: CurrentTenant, db: DbSession) -> UsageOut:
    u = await ComputeService(db, ctx).usage()
    return UsageOut(
        **u.totals(),
        top=TopInstancesOut(**{k: [top_instance_out(e) for e in v] for k, v in u.top.items()}),
    )


@router.get("/dashboard/summary", tags=["dashboard"])
async def dashboard(ctx: CurrentTenant, db: DbSession) -> DashboardSummary:
    projects, instances, active, recent = await ComputeService(db, ctx).summary()
    return DashboardSummary(
        projects=projects, instances=instances, active_jobs=active,
        recent_jobs=await jobs_out(db, recent),
    )
