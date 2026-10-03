"""Worker entrypoint: two concurrent loops.

- jobs: drains the Postgres queue (FOR UPDATE SKIP LOCKED) and then sleeps until a
  NOTIFY on the jobs channel (or a timeout, which also picks up retries whose run_after
  has passed and jobs whose lease expired).
- reconciler: every CM_RECONCILE_INTERVAL_SECONDS, per cluster with credentials.

Several workers may run: SKIP LOCKED spreads jobs, and a transaction-level advisory
lock per cluster keeps one reconciler per cluster.
"""

import asyncio
import logging
import os
import signal
import socket
import uuid

import asyncpg
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.db.session import create_engine, create_sessionmaker, set_platform_scope
from app.infra.secrets import SecretsError, build_secrets_backend
from app.inventory.models import ProviderCluster, ProviderCredential
from app.inventory.reconciler import reconcile
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.queue import CHANNEL, run_one
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
        # a rejected token is not retried every tick: repeated auth failures against the
        # hypervisor are noise at best and can trip fail2ban. New credentials (or a manual
        # test/sync) reset the status.
        ids = (
            await db.execute(
                select(ProviderCluster.id)
                .join(ProviderCredential, ProviderCredential.cluster_id == ProviderCluster.id)
                .where(ProviderCluster.status != "auth_error")
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


JOB_POLL_SECONDS = 5.0


async def job_loop(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    stop: asyncio.Event,
) -> None:
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    wake = asyncio.Event()
    listener = await asyncpg.connect(str(settings.database_url))
    await listener.add_listener(CHANNEL, lambda *_: wake.set())
    try:
        while not stop.is_set():
            wake.clear()
            try:
                while not stop.is_set() and await run_one(sessionmaker, registry, worker_id):
                    pass
            except Exception:  # keep the loop alive; the next wake-up retries
                logger.exception("job loop error")
            waiters = [asyncio.create_task(wake.wait()), asyncio.create_task(stop.wait())]
            await asyncio.wait(waiters, timeout=JOB_POLL_SECONDS,
                               return_when=asyncio.FIRST_COMPLETED)
            for task in waiters:
                task.cancel()
    finally:
        await listener.close()


async def reconcile_loop(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    stop: asyncio.Event,
) -> None:
    while not stop.is_set():
        try:
            await reconcile_all(sessionmaker, registry)
        except Exception:  # keep the loop alive; the next tick retries
            logger.exception("reconcile loop error")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.reconcile_interval_seconds)
        except TimeoutError:
            continue


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
    try:
        await asyncio.gather(
            job_loop(settings, sessionmaker, registry, stop),
            reconcile_loop(settings, sessionmaker, registry, stop),
        )
    finally:
        await engine.dispose()
        logger.info("worker stopped")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()

