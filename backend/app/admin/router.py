"""/api/v1/admin/* — platform administration (docs/architecture/05-api.md)."""

import uuid
from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.admin.schemas import (
    AdminInstanceOut,
    AdoptRequest,
    ClusterCreate,
    ClusterOut,
    ClusterUpdate,
    Confirm,
    ConnectionTest,
    CredentialsOut,
    CredentialsPut,
    NodeBase,
    NodeMetricPointOut,
    NodeMetricsOut,
    NodeOut,
    StorageOut,
    SyncRunOut,
)
from app.admin.service import AdminService
from app.api.deps import (
    AppSettings,
    CurrentPrincipal,
    DbSession,
    Principal,
    RedisClient,
    require_platform,
)
from app.audit import service as audit
from app.compute.models import Instance
from app.compute.schemas import Accepted, JobOut, QuotaLineOut
from app.core.errors import NotFound, ProviderUnavailableError
from app.inventory.models import (
    Node,
    ProviderCluster,
    ProviderCredential,
    StoragePool,
    SyncRun,
)
from app.jobs.models import Job, JobEvent
from app.jobs.presenter import job_out, jobs_out
from app.providers.base import ProviderError
from app.providers.registry import ProviderRegistry
from app.tenancy import quota
from app.tenancy.models import Tenant, TenantQuota
from app.tenancy.router import tenant_out
from app.tenancy.schemas import TenantOut

router = APIRouter(prefix="/admin", tags=["admin"])

ClusterManager = Annotated[Principal, require_platform("cluster:manage")]
ClusterSyncer = Annotated[Principal, require_platform("cluster:sync")]
NodeViewer = Annotated[Principal, require_platform("node:view")]
TenantAdmin = Annotated[Principal, require_platform("tenant:create")]
QuotaAdmin = Annotated[Principal, require_platform("quota:manage")]


def get_registry(request: Request) -> ProviderRegistry:
    return request.app.state.providers


Registry = Annotated[ProviderRegistry, Depends(get_registry)]


def _admin_service(
    db: DbSession, principal: CurrentPrincipal, settings: AppSettings, registry: Registry
) -> AdminService:
    # authorization is done by the route's require_platform guard
    return AdminService(db, principal.user_id, settings, registry)


Admin = Annotated[AdminService, Depends(_admin_service)]


async def cluster_out(db: DbSession, c: ProviderCluster) -> ClusterOut:
    cred = await db.get(ProviderCredential, c.id)
    return ClusterOut(
        id=c.id, name=c.name, provider=c.provider, api_url=c.api_url,
        has_custom_ca=bool(c.ca_pem), insecure_skip_verify=c.insecure_skip_verify,
        status=c.status, version=c.version, settings=c.settings,
        has_credentials=cred is not None, token_id=cred.token_id if cred else None,
        credentials_rotated_at=cred.rotated_at if cred else None,
        last_synced_at=c.last_synced_at, last_error=c.last_error, created_at=c.created_at,
    )


def run_out(r: SyncRun) -> SyncRunOut:
    return SyncRunOut(
        id=r.id, cluster_id=r.cluster_id, trigger=r.trigger, status=r.status,
        started_at=r.started_at, finished_at=r.finished_at, stats=r.stats, error=r.error,
    )


def admin_instance_out(i: Instance) -> AdminInstanceOut:
    return AdminInstanceOut(
        id=i.id, cluster_id=i.cluster_id, tenant_id=i.tenant_id, project_id=i.project_id,
        kind=i.kind, name=i.name, provider_name=i.provider_name, state=i.state,
        power_state=i.power_state, vcpus=i.vcpus, memory_mb=i.memory_mb,
        root_disk_gb=i.root_disk_gb, vmid=int(i.provider_ref["vmid"]),
        node=str(i.provider_ref["node"]), tags=i.tags, managed=i.managed,
        last_seen_at=i.last_seen_at,
    )


# --- clusters --------------------------------------------------------------------------


@router.get("/clusters")
async def list_clusters(_: ClusterManager, db: DbSession) -> list[ClusterOut]:
    clusters = (await db.execute(select(ProviderCluster).order_by(ProviderCluster.name))).scalars()
    return [await cluster_out(db, c) for c in clusters]


@router.post("/clusters", status_code=status.HTTP_201_CREATED)
async def create_cluster(
    body: ClusterCreate, response: Response, _: ClusterManager, svc: Admin, db: DbSession,
) -> ClusterOut:
    cluster = await svc.create_cluster(body)
    await db.refresh(cluster)
    response.headers["Location"] = f"/api/v1/admin/clusters/{cluster.id}"
    return await cluster_out(db, cluster)


@router.get("/clusters/{cluster_id}")
async def get_cluster(
    cluster_id: uuid.UUID, _: ClusterManager, svc: Admin, db: DbSession,
) -> ClusterOut:
    cluster = await svc.get_cluster(cluster_id)
    return await cluster_out(db, cluster)


@router.patch("/clusters/{cluster_id}")
async def update_cluster(
    cluster_id: uuid.UUID, body: ClusterUpdate, _: ClusterManager, svc: Admin, db: DbSession,
) -> ClusterOut:
    cluster = await svc.update_cluster(cluster_id, body)
    await db.refresh(cluster)
    return await cluster_out(db, cluster)


@router.delete("/clusters/{cluster_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cluster(
    cluster_id: uuid.UUID, body: Confirm, _: ClusterManager, svc: Admin, db: DbSession,
) -> None:
    await svc.delete_cluster(cluster_id, body.confirm)


@router.put("/clusters/{cluster_id}/credentials")
async def put_credentials(
    cluster_id: uuid.UUID, body: CredentialsPut, _: ClusterManager, svc: Admin, db: DbSession,
) -> CredentialsOut:
    """Write-only: the response never contains the secret."""
    cred = await svc.put_credentials(cluster_id, body)
    return CredentialsOut(token_id=cred.token_id, rotated_at=cred.rotated_at)


@router.post("/clusters/{cluster_id}/test")
async def test_cluster(
    cluster_id: uuid.UUID, _: ClusterManager, svc: Admin, db: DbSession,
) -> ConnectionTest:
    return await svc.test_connection(cluster_id)


@router.post("/clusters/{cluster_id}/sync", status_code=status.HTTP_202_ACCEPTED)
async def sync_cluster(
    cluster_id: uuid.UUID, response: Response, _: ClusterSyncer, svc: Admin, db: DbSession,
) -> Accepted:
    job = await svc.sync(cluster_id)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/admin/jobs/{job.id}"
    return Accepted(job=await job_out(db, job))


@router.get("/clusters/{cluster_id}/sync-runs")
async def list_sync_runs(
    cluster_id: uuid.UUID, _: ClusterManager, db: DbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[SyncRunOut]:
    runs = await db.execute(
        select(SyncRun)
        .where(SyncRun.cluster_id == cluster_id)
        .order_by(SyncRun.started_at.desc())
        .limit(limit)
    )
    return [run_out(r) for r in runs.scalars()]


# --- inventory -------------------------------------------------------------------------


async def nodes_out(db: DbSession, nodes: list[Node]) -> list[NodeOut]:
    """Nodes plus what their live guests (managed or discovered) were allocated."""
    if not nodes:
        return []
    rows = await db.execute(
        select(
            Instance.node_id,
            func.count(),
            func.count().filter(Instance.power_state == "running"),
            func.coalesce(func.sum(Instance.vcpus), 0),
            func.coalesce(func.sum(Instance.memory_mb), 0),
        )
        .where(Instance.node_id.in_([n.id for n in nodes]), Instance.deleted_at.is_(None))
        .group_by(Instance.node_id)
    )
    alloc = {node_id: rest for node_id, *rest in rows}
    clusters = dict((await db.execute(select(ProviderCluster.id, ProviderCluster.name))).all())
    out = []
    for n in nodes:
        total, running, vcpus, memory = alloc.get(n.id, (0, 0, 0, 0))
        out.append(NodeOut(
            **NodeBase.model_validate(n, from_attributes=True).model_dump(),
            cluster_name=clusters.get(n.cluster_id, ""),
            instances_total=total, instances_running=running,
            vcpus_allocated=vcpus, memory_allocated_mb=memory,
        ))
    return out


@router.get("/nodes")
async def list_nodes(_: NodeViewer, db: DbSession) -> list[NodeOut]:
    nodes = list((await db.execute(select(Node).order_by(Node.name))).scalars())
    return await nodes_out(db, nodes)


@router.get("/nodes/{node_id}")
async def get_node(node_id: uuid.UUID, _: NodeViewer, db: DbSession) -> NodeOut:
    node = await db.get(Node, node_id)
    if node is None:
        raise NotFound()
    return (await nodes_out(db, [node]))[0]


@router.get("/nodes/{node_id}/metrics")
async def node_metrics(
    node_id: uuid.UUID, _: NodeViewer, db: DbSession, redis: RedisClient,
    registry: Registry,
    range_: Annotated[Literal["hour", "day", "week"], Query(alias="range")] = "hour",
) -> NodeMetricsOut:
    node = await db.get(Node, node_id)
    if node is None:
        raise NotFound()
    key = f"node-metrics:{node.id}:{range_}"
    if cached := await redis.get(key):
        return NodeMetricsOut.model_validate_json(cached)
    cluster = await db.get_one(ProviderCluster, node.cluster_id)
    try:
        async with registry.open(db, cluster) as provider:
            points = await provider.node_metrics(node.name, range_)
    except ProviderError as exc:
        raise ProviderUnavailableError("Metrics are temporarily unavailable") from exc
    out = NodeMetricsOut(range=range_, points=[
        NodeMetricPointOut(t=p.time, **{k: v for k, v in asdict(p).items() if k != "time"})
        for p in points
    ])
    await redis.set(key, out.model_dump_json(), ex=30 if range_ == "hour" else 300)
    return out


@router.get("/storage")
async def list_storage(_: ClusterManager, db: DbSession) -> list[StorageOut]:
    pools = (await db.execute(select(StoragePool).order_by(StoragePool.name))).scalars()
    return [StorageOut.model_validate(p, from_attributes=True) for p in pools]


@router.get("/instances")
async def list_instances(
    _: NodeViewer, db: DbSession, managed: bool | None = None,
    cluster_id: uuid.UUID | None = None,
) -> list[AdminInstanceOut]:
    stmt = select(Instance).where(Instance.deleted_at.is_(None)).order_by(Instance.name)
    if managed is not None:
        stmt = stmt.where(Instance.managed == managed)
    if cluster_id is not None:
        stmt = stmt.where(Instance.cluster_id == cluster_id)
    return [admin_instance_out(i) for i in (await db.execute(stmt)).scalars()]


@router.post("/instances/{instance_id}/adopt")
async def adopt_instance(
    instance_id: uuid.UUID, body: AdoptRequest, _: ClusterManager, svc: Admin, db: DbSession,
) -> AdminInstanceOut:
    instance = await svc.adopt(instance_id, body)
    return admin_instance_out(instance)


# --- tenants ---------------------------------------------------------------------------


@router.get("/tenants")
async def list_all_tenants(_: TenantAdmin, db: DbSession) -> list[TenantOut]:
    """Every tenant (platform scope); /tenants lists only the caller's memberships."""
    tenants = (await db.execute(select(Tenant).order_by(Tenant.slug))).scalars()
    return [tenant_out(t) for t in tenants]


class QuotaUpdate(BaseModel):
    """Absent field: unchanged. null: back to the platform default."""

    model_config = ConfigDict(extra="forbid")

    instances: Annotated[int | None, Field(ge=0, le=10_000)] = None
    vcpus: Annotated[int | None, Field(ge=0, le=100_000)] = None
    memory_mb: Annotated[int | None, Field(ge=0, le=100_000_000)] = None
    storage_gb: Annotated[int | None, Field(ge=0, le=10_000_000)] = None


@router.get("/tenants/{tenant_id}/quotas")
async def get_tenant_quotas(
    tenant_id: uuid.UUID, _: QuotaAdmin, db: DbSession, settings: AppSettings
) -> list[QuotaLineOut]:
    if await db.get(Tenant, tenant_id) is None:
        raise NotFound()
    return [
        QuotaLineOut(resource=q.resource, limit=q.limit, used=q.used, available=q.available)
        for q in await quota.report(db, tenant_id, settings)
    ]


@router.put("/tenants/{tenant_id}/quotas")
async def put_tenant_quotas(
    tenant_id: uuid.UUID, body: QuotaUpdate, principal: QuotaAdmin, db: DbSession,
    settings: AppSettings,
) -> list[QuotaLineOut]:
    if await db.get(Tenant, tenant_id) is None:
        raise NotFound()
    changes = body.model_dump(exclude_unset=True)
    for resource, value in changes.items():
        row = await db.scalar(
            select(TenantQuota).where(
                TenantQuota.tenant_id == tenant_id, TenantQuota.resource == resource
            )
        )
        if value is None:
            if row is not None:
                await db.delete(row)
        elif row is None:
            db.add(TenantQuota(tenant_id=tenant_id, resource=resource, limit_value=value))
        else:
            row.limit_value = value
    await db.flush()
    await audit.record(
        db, "QUOTA_UPDATE", actor_user_id=principal.user_id, tenant_id=tenant_id,
        resource_type="tenant", resource_id=tenant_id, details=changes,
    )
    return [
        QuotaLineOut(resource=q.resource, limit=q.limit, used=q.used, available=q.available)
        for q in await quota.report(db, tenant_id, settings)
    ]


# --- jobs ------------------------------------------------------------------------------


class AdminJobEvent(BaseModel):
    kind: str
    message: str
    occurred_at: datetime
    data: dict[str, Any]


class AdminJobDetail(JobOut):
    tenant_id: uuid.UUID | None
    requested_by: uuid.UUID | None
    events: list[AdminJobEvent]


@router.get("/jobs")
async def list_jobs(
    _: ClusterManager, db: DbSession,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[JobOut]:
    stmt = select(Job).order_by(Job.id.desc()).limit(limit)
    if status_filter:
        stmt = stmt.where(Job.status == status_filter)
    return await jobs_out(db, list((await db.execute(stmt)).scalars()))


@router.get("/jobs/{job_id}")
async def get_job(job_id: uuid.UUID, _: ClusterManager, db: DbSession) -> AdminJobDetail:
    job = await db.get(Job, job_id)
    if job is None:
        raise NotFound()
    events = await db.execute(
        select(JobEvent).where(JobEvent.job_id == job.id).order_by(JobEvent.id)
    )
    return AdminJobDetail(
        **(await job_out(db, job)).model_dump(), tenant_id=job.tenant_id,
        requested_by=job.requested_by,
        events=[
            AdminJobEvent(kind=e.kind, message=e.message, occurred_at=e.occurred_at, data=e.data)
            for e in events.scalars()
        ],
    )
