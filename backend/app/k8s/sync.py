"""Refresh k8s_clusters from the legacy kubernetes_clusters table (worker only).

Rows are grouped by `client` (the cluster). The kubeconfig and expiry date come from
the control-plane row (any row that has them, otherwise). The kubeconfig is sealed with
the platform KEK and re-sealed only when it changes. Clusters that vanished from the
source are removed from this local copy; the source itself is never written. Clusters
registered by hand (source='manual') are never touched here.
"""

import logging
from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.ids import uuid7
from app.db.session import set_platform_scope
from app.infra.secrets import SecretsBackend, seal
from app.k8s.kubeconfig import KubeconfigError, decode
from app.k8s.models import K8sCluster
from app.k8s.source import K8sRow, K8sSource

logger = logging.getLogger(__name__)

ROLE_ORDER = {"control-plane": 0, "load-balancer": 1, "worker": 2}


def _main_row(rows: list[K8sRow]) -> K8sRow:
    """The row holding the cluster-wide data: with a config, control-plane first."""
    return min(rows, key=lambda r: (r.config is None, ROLE_ORDER.get(r.role or "", 3), r.id))


def apply_kubeconfig(
    cluster: K8sCluster, b64: str | None, secrets: SecretsBackend | None
) -> None:
    cluster.server_url = cluster.cert_expires_at = cluster.kubeconfig_error = None
    if b64 is None:
        cluster.kubeconfig_ciphertext = cluster.dek_wrapped = cluster.kek_ref = None
        cluster.kubeconfig_sha256 = None
        return
    try:
        kc = decode(b64)
    except KubeconfigError as exc:
        cluster.kubeconfig_error = str(exc)
        cluster.kubeconfig_ciphertext = cluster.dek_wrapped = cluster.kek_ref = None
        cluster.kubeconfig_sha256 = None
        return
    cluster.server_url, cluster.cert_expires_at = kc.server, kc.cert_expires_at
    if secrets is None:
        cluster.kubeconfig_error = "CM_KEK is not set: the kubeconfig is not stored"
        cluster.kubeconfig_ciphertext = cluster.dek_wrapped = cluster.kek_ref = None
        cluster.kubeconfig_sha256 = None
        return
    if cluster.kubeconfig_sha256 == kc.sha256 and cluster.kek_ref == secrets.kek_ref:
        return  # unchanged: keep the sealed copy
    sealed = seal(secrets, kc.text, aad=cluster.id.bytes)
    cluster.kubeconfig_ciphertext, cluster.dek_wrapped = sealed.ciphertext, sealed.dek_wrapped
    cluster.kek_ref, cluster.kubeconfig_sha256 = sealed.kek_ref, kc.sha256


async def sync_clusters(
    db: AsyncSession, rows: list[K8sRow], secrets: SecretsBackend | None
) -> dict[str, int]:
    now = datetime.now(UTC)
    groups: dict[str, list[K8sRow]] = defaultdict(list)
    for row in rows:
        if row.client:
            groups[row.client].append(row)
    existing, manual = {}, set()
    for c in (await db.execute(select(K8sCluster))).scalars():
        if c.source == "table":
            existing[c.name] = c
        else:
            manual.add(c.name)
    for name, group in groups.items():
        if name in manual:  # registered by hand first: the admin's entry wins
            logger.warning("kubernetes cluster in the table shadowed by a manual one",
                           extra={"cluster": name})
            continue
        cluster = existing.get(name)
        if cluster is None:
            cluster = K8sCluster(id=uuid7(), name=name)
            db.add(cluster)
        main = _main_row(group)
        cluster.api_server = main.api_server or next(
            (r.api_server for r in group if r.api_server), None
        )
        cluster.certs_expire_on = main.certs_expire_on or min(
            (r.certs_expire_on for r in group if r.certs_expire_on), default=None
        )
        cluster.nodes = [
            {"id": r.id, "host": r.host, "role": r.role}
            for r in sorted(group, key=lambda r: (ROLE_ORDER.get(r.role or "", 3), r.id))
        ]
        cluster.source_modified_at = max(
            (r.modified_at for r in group if r.modified_at), default=None
        )
        apply_kubeconfig(cluster, main.config, secrets)
        cluster.synced_at = now
    gone = set(existing) - set(groups)
    if gone:
        await db.execute(
            delete(K8sCluster).where(K8sCluster.name.in_(gone), K8sCluster.source == "table")
        )
    return {"clusters": len(groups), "nodes": len(rows), "removed": len(gone)}


async def sync_k8s(
    sessionmaker: async_sessionmaker[AsyncSession],
    source: K8sSource,
    secrets: SecretsBackend | None,
) -> dict[str, int]:
    rows = await source.fetch()  # outside the transaction: MySQL may be slow
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        return await sync_clusters(db, rows, secrets)
