"""/api/v1/admin/* — platform administration (docs/architecture/05-api.md)."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy import select

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
    require_platform,
)
from app.compute.models import Instance
from app.inventory.models import (
    Node,
    ProviderCluster,
    ProviderCredential,
    StoragePool,
    SyncRun,
)
from app.providers.registry import ProviderRegistry

router = APIRouter(prefix="/admin", tags=["admin"])

ClusterManager = Annotated[Principal, require_platform("cluster:manage")]
ClusterSyncer = Annotated[Principal, require_platform("cluster:sync")]
NodeViewer = Annotated[Principal, require_platform("node:view")]


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


@router.post("/clusters/{cluster_id}/sync")
async def sync_cluster(
    cluster_id: uuid.UUID, _: ClusterSyncer, svc: Admin, db: DbSession,
) -> SyncRunOut:
    """Runs inline for now; becomes 202 + job when the job queue lands."""
    run = await svc.sync(cluster_id)
    await db.refresh(run)
    return run_out(run)


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


@router.get("/nodes")
async def list_nodes(_: NodeViewer, db: DbSession) -> list[NodeOut]:
    nodes = (await db.execute(select(Node).order_by(Node.name))).scalars()
    return [NodeOut.model_validate(n, from_attributes=True) for n in nodes]


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
