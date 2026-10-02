"""Shared FastAPI dependencies: settings, Redis, DB session and the authenticated Principal."""

import uuid
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, Header, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.auth.service import revoked_sid_key
from app.core.config import Settings
from app.core.errors import NotFound, Unauthenticated
from app.core.security import decode_access_token
from app.db.session import get_session, set_tenant_scope, set_user_scope
from app.iam.authz import PLATFORM, effective_permissions, is_member
from app.infra.mailer import Mailer


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_redis(request: Request) -> Redis:
    return request.app.state.redis


def get_mailer(request: Request) -> Mailer:
    return request.app.state.mailer


def client_ip(request: Request) -> str | None:
    # uvicorn --proxy-headers already resolved X-Forwarded-For from the edge
    return request.client.host if request.client else None


AppSettings = Annotated[Settings, Depends(get_app_settings)]
RedisClient = Annotated[Redis, Depends(get_redis)]
# scope="function": commit/rollback before the response is sent
DbSession = Annotated[AsyncSession, Depends(get_session, scope="function")]


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    session_id: uuid.UUID
    amr: tuple[str, ...]


async def get_principal(
    request: Request, settings: AppSettings, redis: RedisClient, db: DbSession
) -> Principal:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthenticated(headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = decode_access_token(settings, token)
        principal = Principal(
            user_id=uuid.UUID(claims["sub"]),
            session_id=uuid.UUID(claims["sid"]),
            amr=tuple(claims.get("amr", ())),
        )
    except (jwt.PyJWTError, ValueError, KeyError) as exc:
        raise Unauthenticated(headers={"WWW-Authenticate": "Bearer"}) from exc
    if await redis.exists(revoked_sid_key(principal.session_id)):
        raise Unauthenticated(headers={"WWW-Authenticate": "Bearer"})
    await set_user_scope(db, principal.user_id)
    return principal


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]


@dataclass(frozen=True)
class TenantContext:
    principal: Principal
    tenant_id: uuid.UUID
    via_platform: bool  # access granted by a platform binding, not a membership


async def enter_tenant(
    db: AsyncSession, principal: Principal, tenant_id: uuid.UUID
) -> TenantContext:
    """Validates access to the tenant and sets the RLS scope to it (and only it).

    Members enter normally. Platform roles (bindings valid for every tenant) may enter
    without membership; that access is audited as PLATFORM_SCOPE_ACCESS. Anyone else
    gets 404, whether or not the tenant exists.
    """
    via_platform = False
    if not await is_member(db, principal.user_id, tenant_id):
        if not await effective_permissions(db, principal.user_id, PLATFORM):
            raise NotFound()
        via_platform = True
    await set_tenant_scope(db, [tenant_id])
    if via_platform:
        await audit.record(
            db, "PLATFORM_SCOPE_ACCESS", actor_user_id=principal.user_id, tenant_id=tenant_id
        )
    return TenantContext(principal, tenant_id, via_platform)


async def get_tenant_context(
    principal: CurrentPrincipal,
    db: DbSession,
    x_tenant_id: Annotated[uuid.UUID, Header(alias="X-Tenant-Id")],
) -> TenantContext:
    return await enter_tenant(db, principal, x_tenant_id)


CurrentTenant = Annotated[TenantContext, Depends(get_tenant_context)]
