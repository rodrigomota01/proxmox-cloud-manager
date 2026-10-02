"""/api/v1/auth/* and /api/v1/me."""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, Request, Response, status
from sqlalchemy import select

from app.api.deps import (
    AppSettings,
    CurrentPrincipal,
    DbSession,
    RedisClient,
    client_ip,
    get_mailer,
)
from app.auth.schemas import (
    ForgotPasswordRequest,
    LoginRequest,
    LoginResponse,
    MeResponse,
    ResetPasswordRequest,
    TenantSummary,
    TokenResponse,
    UserOut,
)
from app.auth.service import AuthService, IssuedTokens
from app.core.config import Settings
from app.core.errors import Forbidden, NotFound, Unauthenticated
from app.core.security import signing_key
from app.iam.models import Role, RoleBinding, User
from app.infra.mailer import Mailer
from app.tenancy.models import Tenant, TenantMembership

REFRESH_COOKIE = "cm_rt"
COOKIE_PATH = "/api/v1/auth"
CSRF_HEADER_VALUE = "cloud-manager"

router = APIRouter(tags=["auth"])


def _service(db: DbSession, redis: RedisClient, settings: AppSettings) -> AuthService:
    return AuthService(db, redis, settings)


Service = Annotated[AuthService, Depends(_service)]
RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]


def require_csrf_guard(request: Request, settings: AppSettings) -> None:
    """Cookie-authenticated endpoints: custom header + Origin allowlist (SameSite=Strict
    is the first layer)."""
    if request.headers.get("x-requested-with") != CSRF_HEADER_VALUE:
        raise Forbidden("Missing X-Requested-With header")
    origin = request.headers.get("origin")
    if origin is not None and origin not in settings.allowed_origins:
        raise Forbidden("Origin not allowed")


CsrfGuard = Depends(require_csrf_guard)


def _set_refresh_cookie(response: Response, settings: Settings, tokens: IssuedTokens) -> None:
    max_age = int((tokens.refresh_expires_at - datetime.now(UTC)).total_seconds())
    response.set_cookie(
        REFRESH_COOKIE, tokens.refresh_token, max_age=max(max_age, 0), path=COOKIE_PATH,
        httponly=True, secure=settings.cookie_secure, samesite="strict",
    )


def _clear_refresh_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        REFRESH_COOKIE, path=COOKIE_PATH, httponly=True, secure=settings.cookie_secure,
        samesite="strict",
    )


@router.post("/auth/login")
async def login(
    body: LoginRequest, request: Request, response: Response, svc: Service,
    settings: AppSettings,
) -> LoginResponse:
    tokens = await svc.login(
        body.email, body.password,
        ip=client_ip(request), user_agent=request.headers.get("user-agent"),
    )
    _set_refresh_cookie(response, settings, tokens)
    response.headers["Cache-Control"] = "no-store"
    return LoginResponse(
        access_token=tokens.access_token,
        expires_in=settings.access_token_ttl_seconds,
        user=UserOut(
            id=tokens.user.id, email=tokens.user.email, display_name=tokens.user.display_name
        ),
    )


@router.post("/auth/refresh", dependencies=[CsrfGuard])
async def refresh(
    request: Request, response: Response, svc: Service, settings: AppSettings,
    cm_rt: RefreshCookie = None,
) -> TokenResponse:
    if not cm_rt:
        raise Unauthenticated()
    tokens = await svc.refresh(cm_rt, ip=client_ip(request))
    _set_refresh_cookie(response, settings, tokens)
    response.headers["Cache-Control"] = "no-store"
    return TokenResponse(
        access_token=tokens.access_token, expires_in=settings.access_token_ttl_seconds
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[CsrfGuard])
async def logout(
    request: Request, response: Response, svc: Service, settings: AppSettings,
    cm_rt: RefreshCookie = None,
) -> None:
    if cm_rt:
        await svc.logout(cm_rt, ip=client_ip(request))
    _clear_refresh_cookie(response, settings)


@router.post("/auth/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(
    request: Request, response: Response, principal: CurrentPrincipal, svc: Service,
    settings: AppSettings,
) -> None:
    await svc.logout_all(principal.user_id, ip=client_ip(request))
    _clear_refresh_cookie(response, settings)


@router.post("/auth/password/forgot", status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(
    body: ForgotPasswordRequest, request: Request, background: BackgroundTasks, svc: Service,
    mailer: Annotated[Mailer, Depends(get_mailer)],
) -> None:
    mail = await svc.request_password_reset(body.email, ip=client_ip(request))
    if mail is not None:
        background.add_task(mailer.send, mail)


@router.post("/auth/password/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(body: ResetPasswordRequest, request: Request, svc: Service) -> None:
    await svc.reset_password(body.token, body.new_password, ip=client_ip(request))


@router.get("/auth/.well-known/jwks.json")
async def jwks(settings: AppSettings) -> dict[str, list[dict[str, str]]]:
    return {"keys": [signing_key(settings).jwk()]}


@router.get("/me", tags=["me"])
async def me(principal: CurrentPrincipal, db: DbSession) -> MeResponse:
    user = await db.get(User, principal.user_id)
    if user is None or not user.is_active:
        raise NotFound()
    # RLS: app.user_id is set, so only this user's memberships/bindings are visible
    tenants = (
        await db.execute(
            select(Tenant)
            .join(TenantMembership, TenantMembership.tenant_id == Tenant.id)
            .where(TenantMembership.user_id == user.id)
            .order_by(Tenant.name)
        )
    ).scalars().all()
    platform_roles = (
        await db.execute(
            select(Role.name)
            .join(RoleBinding, RoleBinding.role_id == Role.id)
            .where(RoleBinding.user_id == user.id, RoleBinding.scope_type == "platform")
            .order_by(Role.name)
        )
    ).scalars().all()
    return MeResponse(
        id=user.id, email=user.email, display_name=user.display_name,
        tenants=[
            TenantSummary(id=t.id, slug=t.slug, name=t.name, status=t.status) for t in tenants
        ],
        platform_roles=list(platform_roles),
    )
