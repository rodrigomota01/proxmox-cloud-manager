"""/api/v1/instances, /jobs and /dashboard/summary (tenant scope via X-Tenant-Id)."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Query, Response, status

from app.api.deps import AppSettings, CurrentTenant, DbSession
from app.compute.models import Instance
from app.compute.schemas import (
    Accepted,
    DashboardSummary,
    InstanceAccepted,
    InstanceCreate,
    InstanceDelete,
    InstanceOut,
    JobDetail,
    JobEventOut,
    JobOut,
    QuotaLineOut,
)
from app.compute.service import ComputeService
from app.core.pagination import PageParams, page_params
from app.jobs.presenter import job_out, jobs_out
from app.tenancy import quota
from app.tenancy.schemas import Page

router = APIRouter()

Pagination = Annotated[PageParams, Depends(page_params)]
IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)]


def instance_out(i: Instance) -> InstanceOut:
    if i.project_id is None:  # DB constraint: managed instances always have a project
        raise RuntimeError(f"managed instance {i.id} without project")
    return InstanceOut(
        id=i.id, project_id=i.project_id, kind=i.kind, name=i.name, state=i.state,
        power_state=i.power_state, vcpus=i.vcpus, memory_mb=i.memory_mb,
        root_disk_gb=i.root_disk_gb, tags=i.tags, image_id=i.image_id,
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
    return Page(items=[instance_out(i) for i in items], next_cursor=cursor)


@router.get("/instances/{instance_id}", tags=["instances"])
async def get_instance(instance_id: uuid.UUID, ctx: CurrentTenant, db: DbSession) -> InstanceOut:
    return instance_out(await ComputeService(db, ctx).get(instance_id))


@router.post("/instances", status_code=status.HTTP_202_ACCEPTED, tags=["instances"])
async def create_instance(
    body: InstanceCreate, response: Response, ctx: CurrentTenant, db: DbSession,
    settings: AppSettings, idempotency_key: IdempotencyKey = None,
) -> InstanceAccepted:
    instance, job = await ComputeService(db, ctx, settings).create(body, idempotency_key)
    await db.refresh(instance)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/jobs/{job.id}"
    return InstanceAccepted(instance=instance_out(instance), job=await job_out(db, job))


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


@router.get("/dashboard/summary", tags=["dashboard"])
async def dashboard(ctx: CurrentTenant, db: DbSession) -> DashboardSummary:
    projects, instances, active, recent = await ComputeService(db, ctx).summary()
    return DashboardSummary(
        projects=projects, instances=instances, active_jobs=active,
        recent_jobs=await jobs_out(db, recent),
    )
