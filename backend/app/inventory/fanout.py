"""Runs a per-server task on every server in parallel, each with its own deadline: a slow
or hung server delays only itself (housekeeping polls: SMART, guest agent, storage)."""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable, Sequence

logger = logging.getLogger(__name__)


async def for_each_cluster(
    ids: Sequence[uuid.UUID],
    task: Callable[[uuid.UUID], Awaitable[None]],
    *,
    what: str,
    concurrency: int = 4,
    cluster_timeout: float = 120.0,
) -> None:
    slots = asyncio.Semaphore(concurrency)

    async def one(cluster_id: uuid.UUID) -> None:
        async with slots:
            try:
                async with asyncio.timeout(cluster_timeout):
                    await task(cluster_id)
            except TimeoutError:
                logger.warning(f"{what} timed out", extra={"cluster_id": str(cluster_id)})
            except Exception:  # one server must not stop the others
                logger.exception(f"{what} crashed", extra={"cluster_id": str(cluster_id)})

    await asyncio.gather(*(one(c) for c in ids))
