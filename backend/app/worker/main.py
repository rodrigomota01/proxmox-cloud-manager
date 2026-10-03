"""Worker entrypoint: two concurrent loops.

- jobs: CM_JOB_CONCURRENCY runners drain the Postgres queue (FOR UPDATE SKIP LOCKED)
  and sleep until a NOTIFY on the jobs channel (or a poll timeout, which also picks up
  retries whose run_after has passed and jobs whose lease expired).
- reconciler: every CM_RECONCILE_INTERVAL_SECONDS, every cluster with credentials, in
  parallel (CM_RECONCILE_CONCURRENCY), each bounded by CM_RECONCILE_TIMEOUT_SECONDS.

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

from app.alerts import notify
from app.alerts.evaluator import run_alerts
from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.db.session import create_engine, create_sessionmaker, set_platform_scope
from app.infra.secrets import SecretsError, build_secrets_backend
from app.inventory.guest_disk import poll_guest_disks
from app.inventory.models import ProviderCluster, ProviderCredential
from app.inventory.reconciler import reconcile
from app.ipam.service import source_for
from app.ipam.sync import poll_guest_nics, sync_ipam
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.queue import CHANNEL, run_one
from app.providers.base import ProviderError
from app.providers.registry import ProviderRegistry

logger = logging.getLogger("cloud_manager.worker")


def _lock_key(cluster_id: uuid.UUID) -> int:
    return int.from_bytes(cluster_id.bytes[:8], "big", signed=True)


async def reconcile_all(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    *,
    concurrency: int = 4,
    cluster_timeout: float = 60.0,
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

    slots = asyncio.Semaphore(concurrency)

    async def one(cluster_id: uuid.UUID) -> None:
        async with slots:
            try:
                async with asyncio.timeout(cluster_timeout):
                    await _reconcile_cluster(sessionmaker, registry, cluster_id)
            except TimeoutError:
                # the sync transaction was rolled back; record why in a fresh one
                await _set_status(
                    sessionmaker, cluster_id, "offline",
                    f"inventory sync timed out after {cluster_timeout:.0f}s",
                )
            except Exception:  # one broken cluster must not stop the others
                logger.exception("inventory sync crashed", extra={"cluster_id": str(cluster_id)})

    await asyncio.gather(*(one(cid) for cid in ids))


async def _reconcile_cluster(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    cluster_id: uuid.UUID,
) -> None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        got = await db.scalar(select(func.pg_try_advisory_xact_lock(_lock_key(cluster_id))))
        if not got:
            return  # another worker is on it
        cluster = await db.get(ProviderCluster, cluster_id)
        if cluster is None:
            return
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


async def _set_status(
    sessionmaker: async_sessionmaker[AsyncSession],
    cluster_id: uuid.UUID,
    status: str,
    error: str,
) -> None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        cluster = await db.get(ProviderCluster, cluster_id)
        if cluster is not None:
            cluster.status, cluster.last_error = status, error
    logger.warning("inventory sync failed", extra={"cluster_id": str(cluster_id), "error": error})


async def refresh_ipam(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
) -> None:
    """NICs of every guest (for IP matching), then the IPAM copy when configured. A
    MySQL outage only delays the copy; it never stops the reconcile loop."""
    await poll_guest_nics(sessionmaker, registry)
    source = source_for(settings)
    if source is None:
        return
    try:
        stats = await sync_ipam(sessionmaker, source)
        logger.info("ipam synced", extra={"stats": stats})
    except Exception as exc:
        logger.warning("ipam sync failed", extra={"error": str(exc)})


JOB_POLL_SECONDS = 5.0


async def run_job_pool(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    *,
    worker_id: str,
    concurrency: int,
    wake: asyncio.Event,
    stop: asyncio.Event,
    poll_seconds: float = JOB_POLL_SECONDS,
) -> None:
    """`concurrency` runners claiming jobs independently (SKIP LOCKED keeps them apart).

    An idle runner sleeps until a NOTIFY (wake), a stop, or the poll timeout — the timeout
    also picks up retries whose run_after passed and jobs whose lease expired.
    """

    async def runner(n: int) -> None:
        while not stop.is_set():
            wake.clear()
            try:
                got = await run_one(sessionmaker, registry, f"{worker_id}#{n}")
            except Exception:  # keep the runner alive; the next round retries
                logger.exception("job runner error")
                got = False
            if got:
                continue
            waiters = [asyncio.create_task(wake.wait()), asyncio.create_task(stop.wait())]
            await asyncio.wait(waiters, timeout=poll_seconds, return_when=asyncio.FIRST_COMPLETED)
            for task in waiters:
                task.cancel()

    await asyncio.gather(*(runner(n) for n in range(concurrency)))


async def job_loop(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    stop: asyncio.Event,
) -> None:
    wake = asyncio.Event()
    listener = await asyncpg.connect(str(settings.database_url))
    await listener.add_listener(CHANNEL, lambda *_: wake.set())
    try:
        await run_job_pool(
            sessionmaker, registry,
            worker_id=f"{socket.gethostname()}:{os.getpid()}",
            concurrency=settings.job_concurrency, wake=wake, stop=stop,
        )
    finally:
        await listener.close()


async def reconcile_loop(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    stop: asyncio.Event,
) -> None:
    loop = asyncio.get_running_loop()
    next_disk_poll = next_ipam = 0.0
    while not stop.is_set():
        try:
            await reconcile_all(
                sessionmaker, registry,
                concurrency=settings.reconcile_concurrency,
                cluster_timeout=settings.reconcile_timeout_seconds,
            )
            if loop.time() >= next_disk_poll:
                next_disk_poll = loop.time() + settings.guest_disk_interval_seconds
                await poll_guest_disks(sessionmaker, registry)
            if loop.time() >= next_ipam:
                next_ipam = loop.time() + settings.ipam_sync_interval_seconds
                await refresh_ipam(settings, sessionmaker, registry)
            changes = await run_alerts(sessionmaker)
            if changes:
                logger.info("alerts changed", extra={"changes": len(changes)})
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
    notify.configure(notify.Notifier.build(settings, registry.secrets))

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

