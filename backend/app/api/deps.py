"""Shared FastAPI dependencies: settings, Redis, DB session and the authenticated Principal."""

import uuid
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import revoked_sid_key
from app.core.config import Settings
from app.core.errors import Unauthenticated
from app.core.security import decode_access_token
from app.db.session import get_session, set_user_scope
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
