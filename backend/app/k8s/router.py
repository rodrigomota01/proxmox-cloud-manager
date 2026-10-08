"""Kubernetes clusters, read-only view.

/admin/kubernetes/* — every cluster (platform admins): registration, kubeconfig, and the
link to a tenant. /kubernetes/* — the clusters linked to the current tenant, for its
members (k8s:view), read through the k8s_tenant_* views: no kubeconfig, ever.
"""

import base64
import binascii
import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated

import yaml
from fastapi import APIRouter, Request, Response, status
from sqlalchemy import column, select, table
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentTenant, DbSession, Principal, require_platform
from app.audit import service as audit
from app.core.errors import Conflict, NotFound, ValidationError
from app.core.ids import uuid7
from app.iam.authz import Scope, authorize, effective_permissions, projects_with_permission
from app.infra.secrets import Sealed, SecretsBackend, SecretsError, unseal
from app.k8s.models import K8sCluster, K8sSnapshot
from app.k8s.schemas import (
    K8sClusterCreate,
    K8sClusterDetail,
    K8sClusterOut,
    K8sClusterTenantPut,
    K8sKubeconfigPut,
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


def cluster_out(
    c: K8sCluster, snap: K8sSnapshot | None, today: date, tenant_name: str | None = None
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
        snapshot=summary_out(snap),
    )


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
    today = _today()
    clusters = [
        cluster_out(c, snaps.get(c.id), today, names.get(c.tenant_id))
        for c in (await db.execute(select(K8sCluster))).scalars()
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
    out = cluster_out(cluster, snap, _today(), await _tenant_name(db, cluster.tenant_id))
    return detail_out(out, snap)


@router.put("/clusters/{cluster_id}/tenant")
async def link_tenant(
    cluster_id: uuid.UUID, body: K8sClusterTenantPut, principal: K8sAdmin, db: DbSession
) -> K8sClusterOut:
    """Links the cluster to a client (or unlinks it with null): its members then see
    health, load and workloads, never the kubeconfig."""
    cluster = await _load(db, cluster_id)
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
    if cluster.source != "manual":
        raise Conflict("This cluster comes from kubernetes_clusters and cannot be removed here")
    await audit.record(
        db, "K8S_CLUSTER_DELETE", actor_user_id=principal.user_id,
        resource_type="k8s_cluster", resource_id=cluster.id, details={"name": cluster.name},
    )
    await db.delete(cluster)


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
    if cluster.kubeconfig_ciphertext is None or cluster.dek_wrapped is None:
        raise Conflict(cluster.kubeconfig_error or "This cluster has no kubeconfig")
    text = unseal(
        _secrets(request),
        Sealed(cluster.kubeconfig_ciphertext, cluster.dek_wrapped, cluster.kek_ref or ""),
        aad=cluster.id.bytes,
    )
    await audit.record(
        db, "K8S_KUBECONFIG_DOWNLOAD", actor_user_id=principal.user_id,
        resource_type="k8s_cluster", resource_id=cluster.id, details={"name": cluster.name},
    )
    filename = re.sub(r"[^A-Za-z0-9._-]", "_", cluster.name) + ".kubeconfig"
    return Response(
        content=text, media_type="application/yaml",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


# --- tenant ------------------------------------------------------------------------------

# Read-only views (migration 0014): the linked clusters of the tenants in app.tenant_ids,
# without any credential column. The tables themselves stay platform-only.
_CLUSTER_COLS = ("id", "name", "source", "api_server", "server_url", "certs_expire_on",
                 "cert_expires_at", "synced_at", "tenant_id")
_SNAPSHOT_COLS = ("cluster_id", "health", "reasons", "error", "version", "summary", "data",
                  "collected_at", "ok_at")
tenant_clusters = table("k8s_tenant_clusters", *(column(c) for c in _CLUSTER_COLS))
tenant_snapshots = table("k8s_tenant_snapshots", *(column(c) for c in _SNAPSHOT_COLS))


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
    today = _today()
    clusters = [cluster_out(_transient(r), snaps.get(r.id), today) for r in rows]
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
    return detail_out(cluster_out(_transient(row), snap, _today()), snap)
