"""Worker entrypoint (Phase 0 stub).

Phase 1 adds: Postgres-backed job queue (SELECT ... FOR UPDATE SKIP LOCKED +
LISTEN/NOTIFY), job handlers and the Proxmox inventory reconciler.
"""

import asyncio
import logging
import signal

from app.core.config import get_settings
from app.core.logging import configure_logging

logger = logging.getLogger("cloud_manager.worker")


async def run() -> None:
    settings = get_settings()
    configure_logging(f"{settings.service_name}-worker", settings.log_level)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    logger.info("worker started", extra={"env": settings.env})
    while not stop.is_set():
        logger.info("worker heartbeat")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.worker_heartbeat_seconds)
        except TimeoutError:
            continue
    logger.info("worker stopped")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
