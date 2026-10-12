"""Disk usage and addresses inside running VMs, read through the QEMU guest agent.

The host cannot see inside a VM's disk image, so /cluster/resources reports nothing
useful for it. Every CM_GUEST_DISK_INTERVAL_SECONDS the worker asks each running VM's
agent for its filesystems and IPv4 addresses (GET .../agent/get-fsinfo and
network-get-interfaces, read-only). Containers are already covered by the inventory sync.

Outcome per VM (instances.guest_agent):
- ok           -> filesystems, totals, disk_usage (the fullest filesystem) and
                  guest_addresses refreshed
- unavailable  -> agent not installed/running; last known values are kept
- forbidden    -> the token may not read this guest's agent (see setup-node.sh)
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.compute.models import Instance
from app.db.session import set_platform_scope
from app.infra.secrets import SecretsError
from app.inventory.models import ProviderCluster, ProviderCredential
from app.providers.base import (
    CloudProvider,
    FilesystemUsage,
    GuestAddress,
    GuestAgentUnavailable,
    ProviderAuthError,
    ProviderError,
    ProviderRef,
)
from app.providers.registry import ProviderRegistry

logger = logging.getLogger(__name__)

AGENT_CONCURRENCY = 4  # per cluster: be gentle with pvedaemon


async def poll_guest_disks(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    *,
    cluster_timeout: float = 120.0,
) -> None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        ids = (
            await db.execute(
                select(ProviderCluster.id)
                .join(ProviderCredential, ProviderCredential.cluster_id == ProviderCluster.id)
                .where(ProviderCluster.status == "online")
            )
        ).scalars().all()
    for cluster_id in ids:  # sequential: this is background housekeeping, not urgent
        try:
            async with asyncio.timeout(cluster_timeout):
                await _poll_cluster(sessionmaker, registry, cluster_id)
        except TimeoutError:
            logger.warning("guest disk poll timed out", extra={"cluster_id": str(cluster_id)})
        except Exception:
            logger.exception("guest disk poll crashed", extra={"cluster_id": str(cluster_id)})


async def _poll_cluster(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    cluster_id: uuid.UUID,
) -> None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        cluster = await db.get(ProviderCluster, cluster_id)
        if cluster is None:
            return
        vms = (
            await db.execute(
                select(Instance).where(
                    Instance.cluster_id == cluster_id,
                    Instance.deleted_at.is_(None),
                    Instance.kind == "vm",
                    Instance.power_state == "running",
                )
            )
        ).scalars().all()
        if not vms:
            return
        try:
            async with registry.open(db, cluster) as provider:
                results = await read_all(provider, [ProviderRef(v.provider_ref) for v in vms])
        except (ProviderError, SecretsError) as exc:
            logger.warning(
                "guest disk poll skipped", extra={"cluster": cluster.name, "error": str(exc)}
            )
            return
        now = datetime.now(UTC)
        for vm, result in zip(vms, results, strict=True):
            apply(vm, result, now)


AgentRead = tuple[list[FilesystemUsage], list[GuestAddress] | None]


async def read_all(provider: CloudProvider, refs: list[ProviderRef]) -> list[AgentRead | str]:
    """Filesystems and addresses per guest, or the agent status when unreadable."""
    slots = asyncio.Semaphore(AGENT_CONCURRENCY)

    async def one(ref: ProviderRef) -> AgentRead | str:
        async with slots:
            try:
                filesystems = await provider.guest_filesystems(ref)
            except GuestAgentUnavailable:
                return "unavailable"
            except ProviderAuthError:
                return "forbidden"
            except ProviderError:
                return "unavailable"
            try:
                addresses: list[GuestAddress] | None = await provider.guest_addresses(ref)
            except ProviderError:
                addresses = None  # disk was read; keep the last known addresses
            return filesystems, addresses

    return await asyncio.gather(*(one(r) for r in refs))


def apply(vm: Instance, read: AgentRead | str, now: datetime) -> None:
    vm.disk_checked_at = now
    if isinstance(read, str):
        vm.guest_agent = read
        return
    result, addresses = read
    vm.guest_agent = "ok"
    if addresses is not None:
        vm.guest_addresses = [{"mac": a.mac, "address": a.address} for a in addresses]
    vm.filesystems = [
        {"mountpoint": f.mountpoint, "type": f.type, "used_bytes": f.used_bytes,
         "total_bytes": f.total_bytes}
        for f in result
    ]
    vm.disk_used_bytes = sum(f.used_bytes for f in result)
    vm.disk_total_bytes = sum(f.total_bytes for f in result) or None
    vm.disk_usage = max((f.used_bytes / f.total_bytes for f in result), default=None)
