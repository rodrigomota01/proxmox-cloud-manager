"""Proxmox version of each server, kept current (it changes on an upgrade). Read with the
housekeeping polls, not on every sync; written with a plain UPDATE, so it never races the
inventory sync that updates the same row."""

import logging
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import set_platform_scope
from app.infra.secrets import SecretsError
from app.inventory.fanout import for_each_cluster
from app.inventory.models import ProviderCluster, ProviderCredential
from app.providers.base import ProviderError
from app.providers.registry import ProviderRegistry

logger = logging.getLogger(__name__)


async def poll_versions(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    *,
    concurrency: int = 4,
    cluster_timeout: float = 30.0,
) -> None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        ids = (
            await db.execute(
                select(ProviderCluster.id)
                .join(ProviderCredential, ProviderCredential.cluster_id == ProviderCluster.id)
                .where(ProviderCluster.status != "auth_error")
            )
        ).scalars().all()

    async def poll(cluster_id: uuid.UUID) -> None:
        await _poll_cluster(sessionmaker, registry, cluster_id)

    await for_each_cluster(
        ids, poll, what="version poll", concurrency=concurrency,
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
        try:
            async with registry.open(db, cluster) as provider:
                health = await provider.health()
        except (ProviderError, SecretsError) as exc:
            logger.warning("version poll skipped",
                           extra={"cluster_id": str(cluster_id), "error": str(exc)})
            return
        if health.version and health.version != "unknown" and health.version != cluster.version:
            await db.execute(
                update(ProviderCluster)
                .where(ProviderCluster.id == cluster_id)
                .values(version=health.version)
            )
