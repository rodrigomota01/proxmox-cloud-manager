"""Profile (/me) and user administration (/admin/users)."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import or_, select

from app.api.deps import (
    AppSettings,
    CurrentPrincipal,
    DbSession,
    Principal,
    RedisClient,
    client_ip,
    get_mailer,
    require_platform,
)
from app.audit import service as audit
from app.auth.models import Session
from app.auth.schemas import Email, NewPassword
from app.auth.service import AuthService
from app.core.errors import NotFound
from app.core.pagination import PageParams, page_params, paginate
from app.iam.models import User
from app.infra.mailer import Mailer
from app.tenancy.models import Tenant, TenantMembership
from app.tenancy.schemas import Page
from app.users.service import UserAdminService, platform_roles

router = APIRouter()

DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
UserAdmin = Annotated[Principal, require_platform("user:manage")]
MailerDep = Annotated[Mailer, Depends(get_mailer)]
Pagination = Annotated[PageParams, Depends(page_params)]


def _auth(db: DbSession, redis: RedisClient, settings: AppSettings) -> AuthService:
    return AuthService(db, redis, settings)


Auth = Annotated[AuthService, Depends(_auth)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- profile ---------------------------------------------------------------------------


class ProfileUpdate(Input):
    display_name: DisplayName


class PasswordChange(Input):
    current_password: Annotated[str, Field(min_length=1, max_length=256)]
    new_password: NewPassword


class SessionOut(BaseModel):
    id: uuid.UUID
    ip: str | None
    user_agent: str | None
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    current: bool


@router.patch("/me", tags=["me"])
async def update_profile(
    body: ProfileUpdate, principal: CurrentPrincipal, db: DbSession
) -> dict[str, str]:
    user = await db.get_one(User, principal.user_id)
    old, user.display_name = user.display_name, body.display_name
    await audit.record(
        db, "PROFILE_UPDATE", actor_user_id=user.id, resource_type="user", resource_id=user.id,
        details={"display_name": {"from": old, "to": body.display_name}},
    )
    return {"display_name": user.display_name}


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT, tags=["me"])
async def change_password(
    body: PasswordChange, request: Request, principal: CurrentPrincipal, auth: Auth
) -> None:
    await auth.change_password(
        principal.user_id, body.current_password, body.new_password,
        keep_session=principal.session_id, ip=client_ip(request),
    )


@router.get("/me/sessions", tags=["me"])
async def my_sessions(principal: CurrentPrincipal, db: DbSession) -> list[SessionOut]:
    rows = await db.execute(
        select(Session)
        .where(Session.user_id == principal.user_id, Session.revoked_at.is_(None))
        .order_by(Session.last_seen_at.desc())
    )
    return [
        SessionOut(
            id=s.id, ip=str(s.ip) if s.ip else None, user_agent=s.user_agent,
            created_at=s.created_at, last_seen_at=s.last_seen_at, expires_at=s.expires_at,
            current=s.id == principal.session_id,
        )
        for s in rows.scalars()
    ]


@router.delete("/me/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["me"])
async def revoke_my_session(
    session_id: uuid.UUID, principal: CurrentPrincipal, db: DbSession, auth: Auth
) -> None:
    sess = await db.get(Session, session_id, with_for_update=True)
    if sess is None or sess.user_id != principal.user_id or sess.revoked_at is not None:
        raise NotFound()
    await auth.revoke_session(sess, "revoked_by_user")
    await audit.record(
        db, "SESSION_REVOKE", actor_user_id=principal.user_id, resource_type="session",
        resource_id=session_id,
    )


# --- admin -----------------------------------------------------------------------------


class AdminUserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    is_active: bool
    invited: bool  # no password set yet
    locked: bool
    last_login_at: datetime | None
    created_at: datetime


class Membership(BaseModel):
    tenant_id: uuid.UUID
    tenant_slug: str
    tenant_name: str


class AdminUserDetail(AdminUserOut):
    platform_roles: list[str]
    memberships: list[Membership]
    active_sessions: int


class UserCreate(Input):
    email: Email
    display_name: DisplayName


class UserUpdate(Input):
    display_name: DisplayName | None = None
    email: Email | None = None
    is_active: bool | None = None


class PlatformRoles(Input):
    roles: Annotated[list[str], Field(max_length=5)]


def user_out(u: User) -> AdminUserOut:
    return AdminUserOut(
        id=u.id, email=u.email, display_name=u.display_name, is_active=u.is_active,
        invited=u.password_hash is None,
        locked=u.locked_until is not None and u.locked_until > datetime.now(UTC),
        last_login_at=u.last_login_at, created_at=u.created_at,
    )


async def user_detail(db: DbSession, u: User) -> AdminUserDetail:
    memberships = await db.execute(
        select(Tenant)
        .join(TenantMembership, TenantMembership.tenant_id == Tenant.id)
        .where(TenantMembership.user_id == u.id)
        .order_by(Tenant.name)
    )
    sessions = await db.execute(
        select(Session.id).where(Session.user_id == u.id, Session.revoked_at.is_(None))
    )
    return AdminUserDetail(
        **user_out(u).model_dump(),
        platform_roles=await platform_roles(db, u.id),
        memberships=[
            Membership(tenant_id=t.id, tenant_slug=t.slug, tenant_name=t.name)
            for t in memberships.scalars()
        ],
        active_sessions=len(sessions.all()),
    )


def _svc(principal: CurrentPrincipal, db: DbSession, auth: Auth) -> UserAdminService:
    # authorization is done by the route's require_platform guard
    return UserAdminService(db, principal.user_id, auth)


Svc = Annotated[UserAdminService, Depends(_svc)]


@router.get("/admin/users", tags=["admin"])
async def list_users(
    _: UserAdmin, db: DbSession, page: Pagination, q: str | None = None
) -> Page[AdminUserOut]:
    stmt = select(User)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(User.email.like(like), User.display_name.ilike(like)))
    items, cursor = await paginate(db, stmt, User.id, page)
    return Page(items=[user_out(u) for u in items], next_cursor=cursor)


@router.post("/admin/users", status_code=status.HTTP_201_CREATED, tags=["admin"])
async def create_user(
    body: UserCreate, background: BackgroundTasks, _: UserAdmin, svc: Svc, db: DbSession,
    mailer: MailerDep,
) -> AdminUserDetail:
    user, mail = await svc.create(body.email, body.display_name)
    background.add_task(mailer.send, mail)
    await db.refresh(user)
    return await user_detail(db, user)


@router.get("/admin/users/{user_id}", tags=["admin"])
async def get_user(user_id: uuid.UUID, _: UserAdmin, svc: Svc, db: DbSession) -> AdminUserDetail:
    return await user_detail(db, await svc.get(user_id))


@router.patch("/admin/users/{user_id}", tags=["admin"])
async def update_user(
    user_id: uuid.UUID, body: UserUpdate, _: UserAdmin, svc: Svc, db: DbSession
) -> AdminUserDetail:
    user = await svc.update(
        user_id, display_name=body.display_name, email=body.email, is_active=body.is_active
    )
    await db.refresh(user)
    return await user_detail(db, user)


@router.post("/admin/users/{user_id}/unlock", tags=["admin"])
async def unlock_user(
    user_id: uuid.UUID, _: UserAdmin, svc: Svc, db: DbSession
) -> AdminUserDetail:
    return await user_detail(db, await svc.unlock(user_id))


@router.post(
    "/admin/users/{user_id}/password-reset",
    status_code=status.HTTP_202_ACCEPTED, tags=["admin"],
)
async def send_password_reset(
    user_id: uuid.UUID, background: BackgroundTasks, _: UserAdmin, svc: Svc, mailer: MailerDep
) -> None:
    background.add_task(mailer.send, await svc.send_password_reset(user_id))


@router.post("/admin/users/{user_id}/sessions/revoke", tags=["admin"])
async def revoke_user_sessions(
    user_id: uuid.UUID, _: UserAdmin, svc: Svc
) -> dict[str, int]:
    return {"sessions_revoked": await svc.revoke_sessions(user_id)}


@router.put("/admin/users/{user_id}/platform-roles", tags=["admin"])
async def set_platform_roles(
    user_id: uuid.UUID, body: PlatformRoles, _: UserAdmin, svc: Svc
) -> dict[str, list[str]]:
    return {"platform_roles": await svc.set_platform_roles(user_id, body.roles)}
