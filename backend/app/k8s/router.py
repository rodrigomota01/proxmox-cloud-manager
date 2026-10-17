"""Kubernetes clusters.

/admin/kubernetes/* — every cluster (platform admins): registration, kubeconfig, the
link to a tenant, and creating/destroying clusters on the platform's VMs (ADR-0018).
/kubernetes/* — the clusters linked to the current tenant, for its members (k8s:view),
read through the k8s_tenant_* views (no credential column). Members with k8s:create /
k8s:delete / k8s:admin also create and delete clusters on the platform's VMs and
download the kubeconfig of those (audited); never of a legacy or manual cluster.
"""

import asyncio
import base64
import binascii
import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated

import yaml
from fastapi import APIRouter, Header, Query, Request, Response, status
from sqlalchemy import column, select, table
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    AppSettings,
    CurrentTenant,
    DbSession,
    Principal,
    TenantContext,
    require_platform,
)
from app.audit import service as audit
from app.compute.schemas import Accepted
from app.core.errors import Conflict, NotFound, ProviderUnavailableError, ValidationError
from app.core.ids import uuid7
from app.iam.authz import Scope, authorize, effective_permissions, projects_with_permission
from app.images.models import Image
from app.images.router import zones_by_image
from app.infra.secrets import Sealed, SecretsBackend, SecretsError, unseal
from app.jobs.presenter import job_out
from app.k8s import logs
from app.k8s.client import ForbiddenPath, K8sApiError
from app.k8s.models import K8sCluster, K8sNodePool, K8sSnapshot
from app.k8s.provision import K8sProvisioner
from app.k8s.schemas import (
    K8sAdminProvision,
    K8sClusterCreate,
    K8sClusterDelete,
    K8sClusterDetail,
    K8sClusterOut,
    K8sClusterTenantPut,
    K8sImageOut,
    K8sKubeconfigPut,
    K8sLogsOut,
    K8sManagedOut,
    K8sPoolOut,
    K8sProvision,
    K8sSummaryOut,
    K8sTableNodeOut,
)
from app.k8s.service import expires_on
from app.k8s.service import status as expiry_status
from app.k8s.sync import apply_kubeconfig
from app.tenancy.models import Tenant

router = APIRouter(prefix="/admin/kubernetes", tags=["admin"])
tenant_router = APIRouter(prefix="/kubernetes", tags=["kubernetes"])

K8sAdmin = Annotated[Principal, require_platform("cluster:manage")]


# a cluster that was never read has an empty summary
EMPTY_SUMMARY = {
    **dict.fromkeys(("nodes", "nodes_ready", "namespaces", "pods", "pods_running",
                     "pods_problem", "workloads", "workloads_unready", "services",
                     "ingresses", "httproutes"), 0),
    **dict.fromkeys(("cpu_capacity", "cpu_allocatable", "cpu_requests", "mem_capacity",
                     "mem_allocatable", "mem_requests"), 0.0),
    "metrics": False, "gateway_api": False, "cpu_usage": None, "mem_usage": None,
}


def summary_out(s: K8sSnapshot | None) -> K8sSummaryOut | None:
    if s is None:
        return None
    return K8sSummaryOut(
        health=s.health, reasons=s.reasons, error=s.error, version=s.version,
        collected_at=s.collected_at, ok_at=s.ok_at, **{**EMPTY_SUMMARY, **s.summary},
    )


def managed_out(c: K8sCluster, pools: list[K8sNodePool]) -> K8sManagedOut | None:
    if c.source != "managed" or c.state is None or c.project_id is None:
        return None
    order = {"control-plane": 0, "worker": 1}
    return K8sManagedOut(
        state=c.state, state_message=c.state_message, project_id=c.project_id,  # type: ignore[arg-type]
        kubernetes_version=c.kubernetes_version or "",
        api_endpoint=c.spec.get("api_endpoint"), lb_ip=(c.spec.get("lb") or {}).get("ip"),
        components=c.spec.get("components", {}),
        pools=[K8sPoolOut(id=p.id, name=p.name, role=p.role, count=p.count, vcpus=p.vcpus,  # type: ignore[arg-type]
                          memory_mb=p.memory_mb, disk_gb=p.disk_gb)
               for p in sorted(pools, key=lambda p: (order[p.role], p.name))],
        created_at=c.created_at,
    )


def cluster_out(
    c: K8sCluster, snap: K8sSnapshot | None, today: date, tenant_name: str | None = None,
    pools: list[K8sNodePool] | None = None,
) -> K8sClusterOut:
    exp = expires_on(c)
    days = (exp - today).days if exp else None
    cert_day = c.cert_expires_at.date() if c.cert_expires_at else None
    return K8sClusterOut(
        id=c.id, name=c.name, source=c.source, api_server=c.api_server,
        server_url=c.server_url, certs_expire_on=c.certs_expire_on,
        cert_expires_at=c.cert_expires_at, expires_on=exp, days_left=days,
        status=expiry_status(days),
        dates_differ=bool(c.certs_expire_on and cert_day and c.certs_expire_on != cert_day),
        nodes=[K8sTableNodeOut(**n) for n in c.nodes],
        has_kubeconfig=c.kubeconfig_ciphertext is not None,
        kubeconfig_error=c.kubeconfig_error, source_modified_at=c.source_modified_at,
        synced_at=c.synced_at, tenant_id=c.tenant_id, tenant_name=tenant_name,
        snapshot=summary_out(snap), managed=managed_out(c, pools or []),
    )


async def _pools(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[K8sNodePool]]:
    out: dict[uuid.UUID, list[K8sNodePool]] = {}
    if ids:
        for p in (await db.execute(
            select(K8sNodePool).where(K8sNodePool.k8s_cluster_id.in_(ids))
        )).scalars():
            out.setdefault(p.k8s_cluster_id, []).append(p)
    return out


def _today() -> date:
    return datetime.now(UTC).date()


async def _load(db: AsyncSession, cluster_id: uuid.UUID) -> K8sCluster:
    cluster = await db.get(K8sCluster, cluster_id)
    if cluster is None:
        raise NotFound()
    return cluster


def _secrets(request: Request) -> SecretsBackend:
    secrets = request.app.state.providers.secrets
    if secrets is None:
        raise SecretsError("CM_KEK is not set: kubeconfigs cannot be stored")
    return secrets


def _as_base64(kubeconfig: str) -> str:
    """Accepts the YAML itself or its base64 (the legacy table's format)."""
    text = kubeconfig.strip()
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError:
        doc = None
    if isinstance(doc, dict):
        return base64.b64encode(text.encode()).decode()
    try:
        base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise ValidationError(
            errors=[{"field": "kubeconfig", "message": "paste the YAML or its base64"}]
        ) from None
    return text


def _set_kubeconfig(cluster: K8sCluster, kubeconfig: str, secrets: SecretsBackend) -> None:
    apply_kubeconfig(cluster, _as_base64(kubeconfig), secrets)
    if cluster.kubeconfig_error:
        raise ValidationError(errors=[{"field": "kubeconfig", "message": cluster.kubeconfig_error}])


@router.get("/clusters")
async def list_clusters(_: K8sAdmin, db: DbSession) -> list[K8sClusterOut]:
    """Soonest certificate expiry first; clusters without a known date last."""
    snaps = {s.cluster_id: s for s in (await db.execute(select(K8sSnapshot))).scalars()}
    names = {tid: name for tid, name in await db.execute(select(Tenant.id, Tenant.name))}
    rows = list((await db.execute(select(K8sCluster))).scalars())
    pools = await _pools(db, [c.id for c in rows])
    today = _today()
    clusters = [
        cluster_out(c, snaps.get(c.id), today, names.get(c.tenant_id), pools.get(c.id))
        for c in rows
    ]
    return sorted(clusters, key=lambda c: (c.days_left is None, c.days_left or 0, c.name))


async def _tenant_name(db: AsyncSession, tenant_id: uuid.UUID | None) -> str | None:
    return await db.scalar(select(Tenant.name).where(Tenant.id == tenant_id)) if tenant_id else None


def detail_out(out: K8sClusterOut, snap: K8sSnapshot | None) -> K8sClusterDetail:
    data = snap.data if snap else {}
    return K8sClusterDetail(
        **out.model_dump(),
        k8s_nodes=data.get("nodes", []),
        # snapshots taken before a field existed lack it until the next collection
        namespaces=[{"httproutes": 0, **n} for n in data.get("namespaces", [])],
        workloads=data.get("workloads", []), pods=data.get("pods", []),
        pods_truncated=data.get("pods_truncated", False),
        services=data.get("services", []), ingresses=data.get("ingresses", []),
        httproutes=data.get("httproutes", []),
    )


@router.get("/clusters/{cluster_id}")
async def get_cluster(cluster_id: uuid.UUID, _: K8sAdmin, db: DbSession) -> K8sClusterDetail:
    cluster = await _load(db, cluster_id)
    snap = await db.get(K8sSnapshot, cluster_id)
    pools = (await _pools(db, [cluster.id])).get(cluster.id)
    out = cluster_out(cluster, snap, _today(), await _tenant_name(db, cluster.tenant_id), pools)
    return detail_out(out, snap)


@router.put("/clusters/{cluster_id}/tenant")
async def link_tenant(
    cluster_id: uuid.UUID, body: K8sClusterTenantPut, principal: K8sAdmin, db: DbSession
) -> K8sClusterOut:
    """Links the cluster to a client (or unlinks it with null): its members then see
    health, load and workloads, never the kubeconfig."""
    cluster = await _load(db, cluster_id)
    if cluster.source == "managed":
        raise Conflict("A cluster the platform created belongs to the client that owns its VMs")
    name = None
    if body.tenant_id is not None:
        name = await _tenant_name(db, body.tenant_id)
        if name is None:
            raise ValidationError(errors=[{"field": "tenant_id", "message": "unknown tenant"}])
    previous, cluster.tenant_id = cluster.tenant_id, body.tenant_id
    await audit.record(
        db, "K8S_CLUSTER_TENANT", actor_user_id=principal.user_id,
        tenant_id=body.tenant_id or previous, resource_type="k8s_cluster",
        resource_id=cluster.id,
        details={"name": cluster.name, "from": str(previous) if previous else None,
                 "to": str(body.tenant_id) if body.tenant_id else None},
    )
    return cluster_out(cluster, await db.get(K8sSnapshot, cluster.id), _today(), name)


@router.post("/clusters", status_code=status.HTTP_201_CREATED)
async def create_cluster(
    body: K8sClusterCreate, request: Request, response: Response, principal: K8sAdmin,
    db: DbSession,
) -> K8sClusterOut:
    """A cluster outside the legacy table. Collected like the others from the next pass."""
    cluster = K8sCluster(id=uuid7(), name=body.name, source="manual",
                         synced_at=datetime.now(UTC))
    _set_kubeconfig(cluster, body.kubeconfig, _secrets(request))
    cluster.api_server = cluster.server_url
    try:
        async with db.begin_nested():
            db.add(cluster)
    except IntegrityError as exc:
        raise Conflict(f"A cluster named '{body.name}' already exists") from exc
    await audit.record(
        db, "K8S_CLUSTER_CREATE", actor_user_id=principal.user_id,
        resource_type="k8s_cluster", resource_id=cluster.id,
        details={"name": cluster.name, "server": cluster.server_url},
    )
    response.headers["Location"] = f"/api/v1/admin/kubernetes/clusters/{cluster.id}"
    return cluster_out(cluster, None, _today())


@router.put("/clusters/{cluster_id}/kubeconfig")
async def replace_kubeconfig(
    cluster_id: uuid.UUID, body: K8sKubeconfigPut, request: Request, principal: K8sAdmin,
    db: DbSession,
) -> K8sClusterOut:
    cluster = await _load(db, cluster_id)
    if cluster.source != "manual":
        raise Conflict("This cluster comes from kubernetes_clusters: update it there")
    _set_kubeconfig(cluster, body.kubeconfig, _secrets(request))
    cluster.api_server, cluster.synced_at = cluster.server_url, datetime.now(UTC)
    await audit.record(
        db, "K8S_KUBECONFIG_REPLACE", actor_user_id=principal.user_id,
        resource_type="k8s_cluster", resource_id=cluster.id, details={"name": cluster.name},
    )
    return cluster_out(cluster, await db.get(K8sSnapshot, cluster.id), _today())


@router.delete("/clusters/{cluster_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cluster(cluster_id: uuid.UUID, principal: K8sAdmin, db: DbSession) -> None:
    """Only clusters registered here; nothing is done to the cluster itself."""
    cluster = await _load(db, cluster_id)
    if cluster.source == "managed":
        raise Conflict("A cluster the platform created is removed with its VMs: use destroy")
    if cluster.source != "manual":
        raise Conflict("This cluster comes from kubernetes_clusters and cannot be removed here")
    await audit.record(
        db, "K8S_CLUSTER_DELETE", actor_user_id=principal.user_id,
        resource_type="k8s_cluster", resource_id=cluster.id, details={"name": cluster.name},
    )
    await db.delete(cluster)


def _kubeconfig(cluster: K8sCluster, request: Request) -> str:
    if cluster.kubeconfig_ciphertext is None or cluster.dek_wrapped is None:
        raise Conflict(cluster.kubeconfig_error or "This cluster has no kubeconfig")
    return unseal(
        _secrets(request),
        Sealed(cluster.kubeconfig_ciphertext, cluster.dek_wrapped, cluster.kek_ref or ""),
        aad=cluster.id.bytes,
    )


@router.get(
    "/clusters/{cluster_id}/kubeconfig",
    response_class=Response,
    responses={200: {"content": {"application/yaml": {"schema": {"type": "string"}}}}},
)
async def download_kubeconfig(
    cluster_id: uuid.UUID, request: Request, principal: K8sAdmin, db: DbSession
) -> Response:
    """The kubeconfig grants access to the cluster: every download is audited."""
    cluster = await _load(db, cluster_id)
    text = _kubeconfig(cluster, request)
    await audit.record(
        db, "K8S_KUBECONFIG_DOWNLOAD", actor_user_id=principal.user_id,
        resource_type="k8s_cluster", resource_id=cluster.id, details={"name": cluster.name},
    )
    return _kubeconfig_response(cluster.name, text)


@router.get("/clusters/{cluster_id}/logs")
async def pod_logs(
    cluster_id: uuid.UUID,
    request: Request,
    principal: K8sAdmin,
    db: DbSession,
    namespace: str,
    workload: Annotated[str | None, Query(description="Kind/name, e.g. Deployment/web")] = None,
    pod: Annotated[list[str] | None, Query(max_length=logs.MAX_PODS)] = None,
    container: str | None = None,
    tail_lines: Annotated[int, Query(ge=1, le=logs.MAX_TAIL)] = logs.DEFAULT_TAIL,
    since_seconds: Annotated[int | None, Query(ge=1, le=logs.MAX_SINCE)] = None,
    previous: bool = False,
) -> K8sLogsOut:
    """Logs of one or more pods, or of every pod of a workload, merged in time order.
    Read from the cluster at each call and never stored; each read is audited (logs may
    carry credentials)."""
    if bool(workload) == bool(pod):
        raise ValidationError(errors=[{"field": "workload", "message": "workload or pod"}])
    if workload and not re.fullmatch(r"[A-Za-z]+/[a-z0-9][-a-z0-9.]*", workload):
        raise ValidationError(errors=[{"field": "workload", "message": "Kind/name"}])
    cluster = await _load(db, cluster_id)
    text = _kubeconfig(cluster, request)
    query = logs.LogQuery(
        namespace=namespace, workload=workload, pods=tuple(pod or ()), container=container,
        tail_lines=tail_lines, since_seconds=since_seconds, previous=previous,
    )
    settings = request.app.state.settings
    try:
        async with asyncio.timeout(settings.k8s_poll_timeout_seconds):
            async with request.app.state.k8s_reader(text) as reader:
                out = await logs.read_logs(reader, query)
    except ForbiddenPath as exc:
        raise ValidationError(str(exc)) from None
    except TimeoutError:
        raise ProviderUnavailableError(
            f"the cluster did not answer in {settings.k8s_poll_timeout_seconds:.0f}s"
        ) from None
    except K8sApiError as exc:
        raise ProviderUnavailableError(str(exc)) from None
    await audit.record(
        db, "K8S_POD_LOGS", actor_user_id=principal.user_id, resource_type="k8s_cluster",
        resource_id=cluster.id, details={
            "name": cluster.name, "namespace": namespace, "workload": workload,
            "pods": [p["name"] for p in out["pods"]], "container": container,
            "previous": previous,
        },
    )
    return K8sLogsOut(**out)


# --- tenant ------------------------------------------------------------------------------

# Read-only views (migration 0014): the linked clusters of the tenants in app.tenant_ids,
# without any credential column. The tables themselves stay platform-only.
_CLUSTER_COLS = ("id", "name", "source", "api_server", "server_url", "certs_expire_on",
                 "cert_expires_at", "synced_at", "tenant_id", "state", "state_message",
                 "project_id", "kubernetes_version", "spec", "created_at")
_POOL_COLS = ("id", "k8s_cluster_id", "name", "role", "count", "vcpus", "memory_mb", "disk_gb",
              "created_at")
_SNAPSHOT_COLS = ("cluster_id", "health", "reasons", "error", "version", "summary", "data",
                  "collected_at", "ok_at")
tenant_clusters = table("k8s_tenant_clusters", *(column(c) for c in _CLUSTER_COLS))
tenant_snapshots = table("k8s_tenant_snapshots", *(column(c) for c in _SNAPSHOT_COLS))
tenant_pools = table("k8s_tenant_node_pools", *(column(c) for c in _POOL_COLS))


async def can_view_k8s(db: AsyncSession, ctx) -> bool:
    """k8s:view at the tenant, or from any project-level binding in it (a cluster serves
    the whole client, so a role in one of its projects is enough)."""
    user = ctx.principal.user_id
    if "k8s:view" in await effective_permissions(db, user, Scope(ctx.tenant_id)):
        return True
    return bool(await projects_with_permission(db, user, ctx.tenant_id, "k8s:view"))


async def _require_k8s_view(db: AsyncSession, ctx) -> None:
    if not await can_view_k8s(db, ctx):
        await authorize(db, ctx.principal.user_id, "k8s:view", Scope(ctx.tenant_id))  # raises


def _transient(row) -> K8sCluster:
    """The view row as an unsaved K8sCluster, so cluster_out applies: no kubeconfig, no
    legacy-table nodes (host ids are platform detail)."""
    return K8sCluster(**{c: getattr(row, c) for c in _CLUSTER_COLS}, nodes=[])


async def _tenant_pools(
    db: AsyncSession, ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[K8sNodePool]]:
    out: dict[uuid.UUID, list[K8sNodePool]] = {}
    if ids:
        rows = await db.execute(select(tenant_pools).where(tenant_pools.c.k8s_cluster_id.in_(ids)))
        for r in rows:
            out.setdefault(r.k8s_cluster_id, []).append(K8sNodePool(**r._mapping))
    return out


async def _tenant_snapshots(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, K8sSnapshot]:
    if not ids:
        return {}
    rows = await db.execute(select(tenant_snapshots).where(tenant_snapshots.c.cluster_id.in_(ids)))
    return {r.cluster_id: K8sSnapshot(**r._mapping) for r in rows}


async def linked_clusters(
    db: AsyncSession, tenant_id: uuid.UUID
) -> list[tuple[uuid.UUID, str, K8sSnapshot | None]]:
    """(id, name, last snapshot) of the clusters linked to the tenant, read through the
    views (the session must be scoped to the tenant)."""
    rows = (await db.execute(
        select(tenant_clusters.c.id, tenant_clusters.c.name)
        .where(tenant_clusters.c.tenant_id == tenant_id).order_by(tenant_clusters.c.name)
    )).all()
    snaps = await _tenant_snapshots(db, [r.id for r in rows])
    return [(r.id, r.name, snaps.get(r.id)) for r in rows]


@tenant_router.get("/clusters")
async def tenant_list_clusters(ctx: CurrentTenant, db: DbSession) -> list[K8sClusterOut]:
    await _require_k8s_view(db, ctx)
    rows = (await db.execute(
        select(tenant_clusters).where(tenant_clusters.c.tenant_id == ctx.tenant_id)
    )).all()
    snaps = await _tenant_snapshots(db, [r.id for r in rows])
    pools = await _tenant_pools(db, [r.id for r in rows])
    today = _today()
    clusters = [cluster_out(_transient(r), snaps.get(r.id), today, pools=pools.get(r.id))
                for r in rows]
    return sorted(clusters, key=lambda c: (c.days_left is None, c.days_left or 0, c.name))


@tenant_router.get("/clusters/{cluster_id}")
async def tenant_get_cluster(
    cluster_id: uuid.UUID, ctx: CurrentTenant, db: DbSession
) -> K8sClusterDetail:
    await _require_k8s_view(db, ctx)
    row = (await db.execute(
        select(tenant_clusters).where(
            tenant_clusters.c.id == cluster_id, tenant_clusters.c.tenant_id == ctx.tenant_id
        )
    )).first()
    if row is None:
        raise NotFound()
    snap = (await _tenant_snapshots(db, [row.id])).get(row.id)
    pools = (await _tenant_pools(db, [row.id])).get(row.id)
    return detail_out(cluster_out(_transient(row), snap, _today(), pools=pools), snap)


# --- clusters created by the platform (ADR-0018) ------------------------------------------

IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)]


def _kubeconfig_response(name: str, text: str) -> Response:
    filename = re.sub(r"[^A-Za-z0-9._-]", "_", name) + ".kubeconfig"
    return Response(
        content=text, media_type="application/yaml",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


async def _accepted(db: AsyncSession, job, response: Response) -> Accepted:
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/jobs/{job.id}"
    return Accepted(job=await job_out(db, job))


@tenant_router.get("/images")
async def tenant_k8s_images(ctx: CurrentTenant, db: DbSession) -> list[K8sImageOut]:
    """Kubernetes node images: choosing one is choosing the Kubernetes version."""
    await _require_k8s_view(db, ctx)
    images = list((await db.execute(
        select(Image).where(
            Image.active, Image.kubernetes_version.is_not(None),
            (Image.tenant_id.is_(None)) | (Image.tenant_id == ctx.tenant_id),
        ).order_by(Image.kubernetes_version.desc(), Image.name)
    )).scalars())
    zones = await zones_by_image(db, [i.id for i in images])
    return [
        K8sImageOut(id=i.id, name=i.name, kubernetes_version=i.kubernetes_version or "",
                    min_disk_gb=i.min_disk_gb, zone_ids=sorted(zones.get(i.id, set()), key=str))
        for i in images
    ]


@tenant_router.post("/clusters", status_code=status.HTTP_202_ACCEPTED)
async def tenant_create_cluster(
    body: K8sProvision, response: Response, ctx: CurrentTenant, db: DbSession,
    settings: AppSettings, idempotency_key: IdempotencyKey = None,
) -> Accepted:
    """Creates the node VMs and installs Kubernetes on them (minutes). Follow the job."""
    _, job = await K8sProvisioner(db, ctx, settings).create(body, idempotency_key)
    return await _accepted(db, job, response)


@tenant_router.delete("/clusters/{cluster_id}", status_code=status.HTTP_202_ACCEPTED)
async def tenant_delete_cluster(
    cluster_id: uuid.UUID, body: K8sClusterDelete, response: Response, ctx: CurrentTenant,
    db: DbSession, settings: AppSettings, idempotency_key: IdempotencyKey = None,
) -> Accepted:
    """Destroys the cluster's VMs and frees its addresses. Clusters created here only."""
    job = await K8sProvisioner(db, ctx, settings).delete(cluster_id, body.confirm, idempotency_key)
    return await _accepted(db, job, response)


@tenant_router.get(
    "/clusters/{cluster_id}/kubeconfig",
    response_class=Response,
    responses={200: {"content": {"application/yaml": {"schema": {"type": "string"}}}}},
)
async def tenant_download_kubeconfig(
    cluster_id: uuid.UUID, request: Request, ctx: CurrentTenant, db: DbSession,
    settings: AppSettings,
) -> Response:
    """Admin kubeconfig of a cluster the platform created for this client (k8s:admin).
    Every download is audited."""
    name, text = await K8sProvisioner(db, ctx, settings).kubeconfig(cluster_id, _secrets(request))
    return _kubeconfig_response(name, text)


@router.post("/clusters/provision", status_code=status.HTTP_202_ACCEPTED)
async def admin_provision_cluster(
    body: K8sAdminProvision, response: Response, principal: K8sAdmin, db: DbSession,
    settings: AppSettings, idempotency_key: IdempotencyKey = None,
) -> Accepted:
    """Creates a cluster on the platform's VMs for a client (its quota and project)."""
    if await _tenant_name(db, body.tenant_id) is None:
        raise ValidationError(errors=[{"field": "tenant_id", "message": "unknown tenant"}])
    ctx = TenantContext(principal, body.tenant_id, via_platform=True)
    provision = K8sProvision(**body.model_dump(exclude={"tenant_id"}))
    _, job = await K8sProvisioner(db, ctx, settings, admin=True).create(provision, idempotency_key)
    return await _accepted(db, job, response)


@router.post("/clusters/{cluster_id}/destroy", status_code=status.HTTP_202_ACCEPTED)
async def admin_destroy_cluster(
    cluster_id: uuid.UUID, body: K8sClusterDelete, response: Response, principal: K8sAdmin,
    db: DbSession, settings: AppSettings, idempotency_key: IdempotencyKey = None,
) -> Accepted:
    """Destroys a cluster the platform created, with its VMs."""
    cluster = await _load(db, cluster_id)
    if cluster.tenant_id is None:
        raise Conflict("This cluster was not created by the platform")
    ctx = TenantContext(principal, cluster.tenant_id, via_platform=True)
    job = await K8sProvisioner(db, ctx, settings, admin=True).delete(
        cluster_id, body.confirm, idempotency_key
    )
    return await _accepted(db, job, response)
