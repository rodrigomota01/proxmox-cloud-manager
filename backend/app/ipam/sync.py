"""Refresh the local copy of awf_ip_pool and the NICs of every guest.

- ipam_addresses mirrors the MySQL rows (by their id); rows that vanished are removed.
  Each address is tied to a server here through `pve_node_owner` = node name.
- instances.nics comes from each guest's provider config (MAC, bridge, VLAN, cloud-init
  IP): that is what tells "marked in use" from "really in use".
"""

import asyncio
import ipaddress
import logging
import uuid
from dataclasses import asdict
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.compute.models import Instance
from app.db.session import set_platform_scope
from app.infra.secrets import SecretsError
from app.inventory.models import Node, ProviderCluster, ProviderCredential
from app.ipam.models import IpamAddress
from app.ipam.source import IpamSource, PoolRow
from app.providers.base import ProviderError, ProviderRef
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


async def poll_guest_nics(
    sessionmaker: async_sessionmaker[AsyncSession], registry: ProviderRegistry
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
    for cluster_id in ids:
        try:
            async with asyncio.timeout(120):
                await _poll_cluster(sessionmaker, registry, cluster_id)
        except Exception:  # one server must not stop the others
            logger.exception("nic poll failed", extra={"cluster_id": str(cluster_id)})


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
        guests = (
            await db.execute(
                select(Instance)
                .where(
                    Instance.cluster_id == cluster_id, Instance.deleted_at.is_(None),
                    Instance.state.not_in(("provisioning", "deleting")),
                    Instance.provider_ref.has_key("vmid"),
                )
                .with_for_update()
            )
        ).scalars().all()
        slots = asyncio.Semaphore(NIC_CONCURRENCY)
        try:
            async with registry.open(db, cluster) as provider:

                async def one(i: Instance) -> list[dict] | None:
                    async with slots:
                        try:
                            nics = await provider.guest_nics(ProviderRef(i.provider_ref))
                        except ProviderError:
                            return None  # keep the last known NICs
                        return [asdict(n) for n in nics]

                results = await asyncio.gather(*(one(i) for i in guests))
        except (ProviderError, SecretsError) as exc:
            logger.warning("nic poll skipped", extra={"cluster": cluster.name, "error": str(exc)})
            return
        for instance, nics in zip(guests, results, strict=True):
            if nics is not None and nics != instance.nics:
                instance.nics = nics
