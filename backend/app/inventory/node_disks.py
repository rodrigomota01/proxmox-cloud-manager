"""Physical disks of every node, with SMART health and SSD wear.

GET /nodes/{node}/disks/list (Sys.Audit, read-only) runs smartctl on the node, so it is
polled with the guest disks (CM_GUEST_DISK_INTERVAL_SECONDS), not on every sync. A node
that cannot be read keeps its last known list.
"""

import asyncio
import logging
from dataclasses import asdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import set_platform_scope
from app.infra.secrets import SecretsError
from app.inventory.models import Node, ProviderCluster, ProviderCredential
from app.providers.base import ProviderError
from app.providers.registry import ProviderRegistry

logger = logging.getLogger(__name__)


async def poll_node_disks(
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
    for cluster_id in ids:
        try:
            async with asyncio.timeout(cluster_timeout), sessionmaker() as db, db.begin():
                await set_platform_scope(db)
                cluster = await db.get(ProviderCluster, cluster_id)
                if cluster is None:
                    continue
                nodes = (await db.execute(
                    select(Node).where(Node.cluster_id == cluster_id, Node.status == "online")
                )).scalars().all()
                async with registry.open(db, cluster) as provider:
                    for node in nodes:
                        try:
                            disks = await provider.node_disks(node.name)
                        except ProviderError as exc:
                            logger.warning("node disks unreadable",
                                           extra={"node": node.name, "error": str(exc)})
                            continue
                        node.disks = [asdict(d) for d in disks]
                        node.disks_checked_at = datetime.now(UTC)
        except (ProviderError, SecretsError) as exc:
            logger.warning("node disk poll skipped",
                           extra={"cluster_id": str(cluster_id), "error": str(exc)})
        except TimeoutError:
            logger.warning("node disk poll timed out", extra={"cluster_id": str(cluster_id)})
        except Exception:
            logger.exception("node disk poll crashed", extra={"cluster_id": str(cluster_id)})
