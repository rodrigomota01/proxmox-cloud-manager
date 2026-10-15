"""Refresh the local copy of awf_ip_pool and the NICs of every guest.

- ipam_addresses mirrors the MySQL rows (by their id); rows that vanished are removed.
  Each address is tied to a server here through `pve_node_owner` = node name.
- instances.nics comes from each guest's provider config (MAC, bridge, VLAN, cloud-init
  IP): that is what tells "marked in use" from "really in use". The same read gives
  instances.disks (every virtual disk), completed with the space each image takes in
  its storage where the token may list it (the managed pool).
"""

import asyncio
import ipaddress
import logging
import uuid
from collections.abc import Sequence
from dataclasses import asdict
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.compute.models import Instance
from app.db.session import set_platform_scope
from app.infra.secrets import SecretsError
from app.inventory.fanout import for_each_cluster
from app.inventory.models import Node, ProviderCluster, ProviderCredential, StoragePool
from app.ipam.models import IpamAddress
from app.ipam.source import IpamSource, PoolRow
from app.providers.base import CloudProvider, GuestConfig, ProviderError, ProviderRef
from app.providers.registry import ProviderRegistry

logger = logging.getLogger(__name__)

NIC_CONCURRENCY = 4


def parse_address(text: str) -> tuple[str, int | None] | None:
    """'152.236.18.11/31' -> ('152.236.18.11', 31); '177.54.151.42' -> (.., None)."""
    try:
        if "/" in text:
            iface = ipaddress.ip_interface(text)
            return str(iface.ip), iface.network.prefixlen
        return str(ipaddress.ip_address(text)), None
    except ValueError:
        return None


async def sync_addresses(db: AsyncSession, rows: list[PoolRow]) -> dict[str, int]:
    now = datetime.now(UTC)
    clusters: dict[str, uuid.UUID] = {}
    for name, cluster_id in (await db.execute(select(Node.name, Node.cluster_id))).all():
        clusters.setdefault(name, cluster_id)
    existing = {a.external_id: a for a in (await db.execute(select(IpamAddress))).scalars()}
    seen, skipped = set(), 0
    for row in rows:
        parsed = parse_address(row.ip_addr)
        if parsed is None:
            skipped += 1
            continue
        seen.add(row.id)
        a = existing.get(row.id)
        if a is None:
            a = IpamAddress(external_id=row.id)
            db.add(a)
        a.address, a.prefix = parsed
        a.hypervisor, a.node_name = row.hypervisor, row.node
        a.cluster_id = clusters.get(row.node or "")
        a.assigned, a.mac, a.hostname = row.assigned, row.mac, row.hostname
        a.host_owner, a.ip_block, a.synced_at = row.host_owner, row.ip_block, now
    gone = set(existing) - seen
    if gone:
        await db.execute(delete(IpamAddress).where(IpamAddress.external_id.in_(gone)))
    return {"addresses": len(seen), "skipped": skipped, "removed": len(gone)}


async def sync_ipam(
    sessionmaker: async_sessionmaker[AsyncSession], source: IpamSource
) -> dict[str, int]:
    rows = await source.fetch()  # outside the transaction: MySQL may be slow
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        return await sync_addresses(db, rows)


async def poll_guest_config(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    *,
    concurrency: int = 4,
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

    async def poll(cluster_id: uuid.UUID) -> None:
        await _poll_cluster(sessionmaker, registry, cluster_id)

    await for_each_cluster(
        ids, poll, what="guest config poll", concurrency=concurrency,
        cluster_timeout=cluster_timeout,
    )


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
        # no row lock while talking to the server (slow on a struggling node): the inventory
        # sync and the jobs keep working; the rows are locked below, only to write
        guests = (
            await db.execute(
                select(Instance)
                .where(
                    Instance.cluster_id == cluster_id, Instance.deleted_at.is_(None),
                    Instance.state.not_in(("provisioning", "deleting")),
                    Instance.provider_ref.has_key("vmid"),
                )
            )
        ).scalars().all()
        pools = (await db.execute(
            select(StoragePool).where(StoragePool.cluster_id == cluster_id, StoragePool.active)
        )).scalars().all()
        slots = asyncio.Semaphore(NIC_CONCURRENCY)
        try:
            async with registry.open(db, cluster) as provider:

                async def one(i: Instance) -> GuestConfig | None:
                    async with slots:
                        try:
                            return await provider.guest_config(ProviderRef(i.provider_ref))
                        except ProviderError:
                            return None  # keep the last known NICs and disks

                results = await asyncio.gather(*(one(i) for i in guests))
                used = await _volume_usage(provider, pools)
        except (ProviderError, SecretsError) as exc:
            logger.warning(
                "guest config poll skipped", extra={"cluster": cluster.name, "error": str(exc)}
            )
            return
        read = {g.id: c for g, c in zip(guests, results, strict=True) if c is not None}
        if not read:
            return
        # a job may have started on a guest meanwhile: lock, re-read and skip those
        current = (
            await db.execute(
                select(Instance)
                .where(
                    Instance.id.in_(read), Instance.deleted_at.is_(None),
                    Instance.state.not_in(("provisioning", "deleting")),
                )
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalars().all()
        for instance in current:
            config = read[instance.id]
            nics = [asdict(n) for n in config.nics]
            if nics != instance.nics:
                instance.nics = nics
            disks = [{**asdict(d), "used_bytes": used.get(d.volume)} for d in config.disks]
            if disks != instance.disks:
                instance.disks = disks


async def _volume_usage(provider: CloudProvider, pools: Sequence[StoragePool]) -> dict[str, int]:
    """Space taken by each disk image, from the storages that hold guest disks. A shared
    storage is the same on every node: listed once."""
    seen: set[str] = set()
    used: dict[str, int] = {}
    for pool in pools:
        if not {"images", "rootdir"} & set(pool.content):
            continue
        key = pool.name if pool.shared else f"{pool.node}/{pool.name}"
        if key in seen:
            continue
        seen.add(key)
        try:
            volumes = await provider.storage_volumes(pool.node, pool.name)
        except ProviderError:
            continue  # unreachable or not allowed: sizes still come from the config
        used.update({v.volume: v.used_bytes for v in volumes if v.used_bytes is not None})
    return used
