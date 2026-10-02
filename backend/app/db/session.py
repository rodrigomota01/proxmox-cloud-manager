"""Engine, per-request session and RLS scope (ADR-0004).

RLS settings are applied with set_config(..., is_local => true), the same as SET LOCAL:
they last until the end of the current transaction, so pooled connections never carry
another request's scope. Consequence: do not commit in the middle of a tenant-scoped
request — the scope is gone after the commit.
"""

import uuid
from collections.abc import AsyncIterator, Iterable

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings


def create_engine(settings: Settings, *, migration: bool = False) -> AsyncEngine:
    url = settings.sqlalchemy_migration_url if migration else settings.sqlalchemy_url
    return create_async_engine(url, pool_size=settings.db_pool_size, pool_pre_ping=True)


def create_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """One transaction per request: commit on success, rollback on any exception.

    Use with Depends(..., scope="function") so the commit happens before the response
    is sent (a failed commit must not reach the client as 2xx).
    """
    maker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with maker() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


async def _set(session: AsyncSession, name: str, value: str) -> None:
    await session.execute(
        text("SELECT set_config(:name, :value, true)"), {"name": name, "value": value}
    )


async def set_user_scope(session: AsyncSession, user_id: uuid.UUID) -> None:
    await _set(session, "app.user_id", str(user_id))


async def set_tenant_scope(session: AsyncSession, tenant_ids: Iterable[uuid.UUID]) -> None:
    await _set(session, "app.tenant_ids", ",".join(str(t) for t in tenant_ids))


async def set_platform_scope(session: AsyncSession) -> None:
    await _set(session, "app.platform_scope", "on")
