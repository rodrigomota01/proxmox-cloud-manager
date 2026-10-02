"""Inventory reconciler (ADR-0003, docs/architecture/04-integracao-proxmox.md).

Proxmox emits no lifecycle events, so the worker polls one /cluster/resources per
cluster and converges the database:

- new guest outside the platform        -> instance with managed=false (discovered)
- guest seen                            -> observation refreshed (power, node, sizing)
- guest missing for MISSING_THRESHOLD   -> state=deleted_externally (+ audit if managed)
  consecutive successful syncs
- node offline                          -> its instances get power_state=unknown
- provider error                        -> cluster status updated; nothing is marked
                                           missing (absence of data is not absence)

Runs in platform scope (the caller sets it).
"""

import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.compute.models import Instance
from app.inventory.models import Node, ProviderCluster, StoragePool, SyncRun
from app.providers.base import (
    CloudProvider,
    InstanceObservation,
    PowerState,
    ProviderAuthError,
    ProviderError,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

MISSING_THRESHOLD = 2


@dataclass
class SyncStats:
    nodes: int = 0
    instances_seen: int = 0
    discovered: int = 0
    updated: int = 0
    missing: int = 0
    deleted_externally: int = 0
    storage: int = 0


def _status_for(exc: ProviderError) -> str:
    if isinstance(exc, ProviderAuthError):
        return "auth_error"
    if isinstance(exc, ProviderUnavailable):
        return "offline"
    return "error"


async def reconcile(
    db: AsyncSession, cluster: ProviderCluster, provider: CloudProvider, *, trigger: str
) -> SyncRun:
    run = SyncRun(cluster_id=cluster.id, trigger=trigger)
    db.add(run)
    await db.flush()
    now = datetime.now(UTC)
    try:
        inv = await provider.inventory()
    except ProviderError as exc:
        cluster.status, cluster.last_error = _status_for(exc), str(exc)
        run.status, run.error, run.finished_at = "failed", str(exc), now
        logger.warning(
            "inventory sync failed", extra={"cluster": cluster.name, "error": str(exc)}
        )
        return run

    stats = SyncStats(nodes=len(inv.nodes), instances_seen=len(inv.instances))

    # nodes
    existing_nodes = {
        n.name: n
        for n in (await db.execute(select(Node).where(Node.cluster_id == cluster.id))).scalars()
    }
    for obs in inv.nodes:
        node = existing_nodes.get(obs.name)
        if node is None:
            node = Node(cluster_id=cluster.id, name=obs.name)
            db.add(node)
            existing_nodes[obs.name] = node
        node.status = "online" if obs.online else "offline"
        node.cpu_count, node.memory_bytes = obs.cpu_count, obs.memory_bytes
        node.cpu_usage, node.memory_used_bytes = obs.cpu_usage, obs.memory_used_bytes
        node.uptime_seconds, node.last_seen_at = obs.uptime_seconds, now
    seen_nodes = {n.name for n in inv.nodes}
    for name, node in existing_nodes.items():
        if name not in seen_nodes:
            node.status = "unknown"
    await db.flush()
    offline = {name for name, n in existing_nodes.items() if n.status != "online"}

    # instances
    live = {
        i.provider_ref["vmid"]: i
        for i in (
            await db.execute(
                select(Instance).where(
                    Instance.cluster_id == cluster.id, Instance.deleted_at.is_(None)
                )
            )
        ).scalars()
    }
    for obs in inv.instances:
        vmid = obs.ref.data["vmid"]
        instance = live.pop(vmid, None)
        if instance is None:
            instance = Instance(
                cluster_id=cluster.id, kind=obs.kind.value, name=obs.name, managed=False
            )
            db.add(instance)
            stats.discovered += 1
        else:
            stats.updated += 1
        node = existing_nodes.get(obs.node)
        _observe(instance, obs, node.id if node else None, offline, now)

    for instance in live.values():  # not in this snapshot
        instance.missing_count += 1
        stats.missing += 1
        if instance.missing_count >= MISSING_THRESHOLD:
            instance.state, instance.deleted_at = "deleted_externally", now
            instance.power_state = PowerState.UNKNOWN.value
            stats.deleted_externally += 1
            if instance.managed:
                await audit.record(
                    db, "INSTANCE_DELETED_EXTERNALLY", tenant_id=instance.tenant_id,
                    resource_type="instance", resource_id=instance.id,
                    details={"cluster": cluster.name, "vmid": instance.provider_ref["vmid"]},
                )

    # storage
    existing_storage = {
        (s.node, s.name): s
        for s in (
            await db.execute(select(StoragePool).where(StoragePool.cluster_id == cluster.id))
        ).scalars()
    }
    for obs in inv.storage:
        pool = existing_storage.get((obs.node, obs.name))
        if pool is None:
            pool = StoragePool(cluster_id=cluster.id, node=obs.node, name=obs.name)
            db.add(pool)
        pool.type, pool.content, pool.shared = obs.type, list(obs.content), obs.shared
        pool.active, pool.total_bytes = obs.active, obs.total_bytes
        pool.used_bytes = obs.used_bytes
        pool.last_seen_at = now
    stats.storage = len(inv.storage)

    cluster.status, cluster.last_error, cluster.last_synced_at = "online", None, now
    run.status, run.stats, run.finished_at = "succeeded", asdict(stats), datetime.now(UTC)
    await db.flush()
    return run


def _observe(
    instance: Instance,
    obs: InstanceObservation,
    node_id: uuid.UUID | None,
    offline_nodes: set[str],
    now: datetime,
) -> None:
    instance.provider_ref = obs.ref.data
    instance.provider_name = obs.name
    if not instance.managed:
        instance.name = obs.name  # adopted instances keep their platform name
    instance.node_id = node_id
    instance.power_state = (
        PowerState.UNKNOWN.value if obs.node in offline_nodes else obs.power_state.value
    )
    instance.vcpus, instance.memory_mb, instance.root_disk_gb = (
        obs.vcpus, obs.memory_mb, obs.disk_gb,
    )
    instance.tags = list(obs.tags)
    instance.missing_count = 0
    instance.last_seen_at = now
