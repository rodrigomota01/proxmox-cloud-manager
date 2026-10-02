"""Liveness and readiness endpoints.

/healthz  -> process is alive (no dependencies checked)
/readyz   -> PostgreSQL and Redis reachable within a timeout
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, Response, status
from redis.asyncio import Redis

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)
router = APIRouter(tags=["health"])

Check = Callable[[Settings], Awaitable[None]]


async def check_postgres(settings: Settings) -> None:
    conn = await asyncpg.connect(
        str(settings.database_url), timeout=settings.readiness_timeout_seconds
    )
    try:
        await conn.fetchval("SELECT 1")
    finally:
        await conn.close()


async def check_redis(settings: Settings) -> None:
    client = Redis.from_url(
        str(settings.redis_url), socket_timeout=settings.readiness_timeout_seconds
    )
    try:
        await client.ping()
    finally:
        await client.aclose()


def get_checks() -> dict[str, Check]:
    return {"postgres": check_postgres, "redis": check_redis}


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(
    response: Response,
    settings: Annotated[Settings, Depends(get_settings)],
    checks: Annotated[dict[str, Check], Depends(get_checks)],
) -> dict[str, object]:
    async def run(name: str, check: Check) -> tuple[str, str]:
        try:
            await asyncio.wait_for(check(settings), timeout=settings.readiness_timeout_seconds)
            return name, "ok"
        except Exception as exc:  # readiness must never raise
            logger.warning(
                "readiness check failed",
                extra={"check": name, "error": type(exc).__name__},
            )
            return name, "unavailable"

    results = dict(await asyncio.gather(*(run(n, c) for n, c in checks.items())))
    ready = all(v == "ok" for v in results.values())
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ready" if ready else "not_ready", "checks": results}
