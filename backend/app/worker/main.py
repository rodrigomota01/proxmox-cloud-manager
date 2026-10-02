"""Worker entrypoint.

Today: the inventory reconciler (every CM_RECONCILE_INTERVAL_SECONDS, per cluster with
credentials). Next: the Postgres-backed job queue (SELECT ... FOR UPDATE SKIP LOCKED).
Several workers may run: a transaction-level advisory lock per cluster makes sure only
one of them reconciles a given cluster at a time.
"""

import asyncio
import logging
import signal
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.db.session import create_engine, create_sessionmaker, set_platform_scope
from app.infra.secrets import SecretsError, build_secrets_backend
from app.inventory.models import ProviderCluster, ProviderCredential
from app.inventory.reconciler import reconcile
from app.providers.base import ProviderError
from app.providers.registry import ProviderRegistry

logger = logging.getLogger("cloud_manager.worker")


def _lock_key(cluster_id: uuid.UUID) -> int:
    return int.from_bytes(cluster_id.bytes[:8], "big", signed=True)


async def reconcile_all(
    sessionmaker: async_sessionmaker[AsyncSession], registry: ProviderRegistry
) -> None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        ids = (
            await db.execute(
                select(ProviderCluster.id).join(
                    ProviderCredential, ProviderCredential.cluster_id == ProviderCluster.id
                )
            )
        ).scalars().all()
    for cluster_id in ids:
        async with sessionmaker() as db, db.begin():
            await set_platform_scope(db)
            got = await db.scalar(
                select(func.pg_try_advisory_xact_lock(_lock_key(cluster_id)))
            )
            if not got:
                continue  # another worker is on it
            cluster = await db.get(ProviderCluster, cluster_id)
            if cluster is None:
                continue
            try:
                async with registry.open(db, cluster) as provider:
                    run = await reconcile(db, cluster, provider, trigger="scheduled")
                logger.info(
                    "inventory synced",
                    extra={"cluster": cluster.name, "status": run.status, "stats": run.stats},
                )
            except (ProviderError, SecretsError) as exc:
                cluster.status, cluster.last_error = "error", str(exc)
                logger.warning(
                    "inventory sync skipped", extra={"cluster": cluster.name, "error": str(exc)}
                )


async def run(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    configure_logging(f"{settings.service_name}-worker", settings.log_level)
    engine = create_engine(settings)
    sessionmaker = create_sessionmaker(engine)
    registry = ProviderRegistry(settings, build_secrets_backend(settings))

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    logger.info("worker started", extra={"env": settings.env})
    while not stop.is_set():
        try:
            await reconcile_all(sessionmaker, registry)
        except Exception:  # keep the loop alive; the next tick retries
            logger.exception("reconcile loop error")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.reconcile_interval_seconds)
        except TimeoutError:
            continue
    await engine.dispose()
    logger.info("worker stopped")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()

