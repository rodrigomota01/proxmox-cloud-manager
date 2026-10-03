"""/api/v1/tenants, /tenants/{id}/members and /projects."""

import uuid
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Response, status
from pydantic import BaseModel

from app.api.deps import (
    AppSettings,
    CurrentPrincipal,
    CurrentTenant,
    DbSession,
    RedisClient,
    TenantContext,
    enter_tenant,
    get_mailer,
)
from app.auth.service import AuthService
from app.core.pagination import PageParams, page_params
from app.infra.mailer import Mail, Mailer
from app.tenancy.models import Project, Tenant
from app.tenancy.schemas import (
    Confirm,
    MemberAdd,
    MemberOut,
    Page,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
    TenantCreate,
    TenantOut,
    TenantUpdate,
)
from app.tenancy.service import MemberService, ProjectService, TenantService

router = APIRouter()


def _auth(db: DbSession, redis: RedisClient, settings: AppSettings) -> AuthService:
    return AuthService(db, redis, settings)


Auth = Annotated[AuthService, Depends(_auth)]
MailerDep = Annotated[Mailer, Depends(get_mailer)]
Pagination = Annotated[PageParams, Depends(page_params)]


async def path_tenant(
    tenant_id: uuid.UUID, principal: CurrentPrincipal, db: DbSession
) -> TenantContext:
    return await enter_tenant(db, principal, tenant_id)


PathTenant = Annotated[TenantContext, Depends(path_tenant)]


def _send_later(background: BackgroundTasks, mailer: Mailer, mail: Mail | None) -> None:
    if mail is not None:
        background.add_task(mailer.send, mail)


def tenant_out(t: Tenant) -> TenantOut:
    return TenantOut(id=t.id, slug=t.slug, name=t.name, status=t.status, created_at=t.created_at)


def project_out(p: Project) -> ProjectOut:
    return ProjectOut(
        id=p.id, tenant_id=p.tenant_id, slug=p.slug, name=p.name,
        description=p.description, created_at=p.created_at,
    )


# --- tenants ---------------------------------------------------------------------------


@router.get("/tenants", tags=["tenants"])
async def list_tenants(principal: CurrentPrincipal, db: DbSession, auth: Auth) -> Page[TenantOut]:
    tenants = await TenantService(db, auth).list_for(principal)
    return Page(items=[tenant_out(t) for t in tenants])


@router.post("/tenants", status_code=status.HTTP_201_CREATED, tags=["tenants"])
async def create_tenant(
    body: TenantCreate, response: Response, background: BackgroundTasks,
    principal: CurrentPrincipal, db: DbSession, auth: Auth, mailer: MailerDep,
) -> TenantOut:
    tenant, mail = await TenantService(db, auth).create(principal, body)
    await db.refresh(tenant)
    _send_later(background, mailer, mail)
    response.headers["Location"] = f"/api/v1/tenants/{tenant.id}"
    return tenant_out(tenant)


@router.get("/tenants/{tenant_id}", tags=["tenants"])
async def get_tenant(ctx: PathTenant, db: DbSession, auth: Auth) -> TenantOut:
    return tenant_out(await TenantService(db, auth).get(ctx))


@router.patch("/tenants/{tenant_id}", tags=["tenants"])
async def update_tenant(
    body: TenantUpdate, ctx: PathTenant, db: DbSession, auth: Auth
) -> TenantOut:
    return tenant_out(await TenantService(db, auth).rename(ctx, body.name))


@router.delete("/tenants/{tenant_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["tenants"])
async def delete_tenant(body: Confirm, ctx: PathTenant, db: DbSession, auth: Auth) -> None:
    await TenantService(db, auth).delete(ctx, body.confirm)


# --- members ---------------------------------------------------------------------------


class MemberAdded(BaseModel):
    user_id: uuid.UUID
    invited: bool


@router.get("/tenants/{tenant_id}/members", tags=["members"])
async def list_members(ctx: PathTenant, db: DbSession, auth: Auth) -> list[MemberOut]:
    return await MemberService(db, ctx, auth).list_members()


@router.post(
    "/tenants/{tenant_id}/members", status_code=status.HTTP_201_CREATED, tags=["members"]
)
async def add_member(
    body: MemberAdd, background: BackgroundTasks, ctx: PathTenant, db: DbSession, auth: Auth,
    mailer: MailerDep,
) -> MemberAdded:
    user_id, mail = await MemberService(db, ctx, auth).add(body)
    _send_later(background, mailer, mail)
    return MemberAdded(user_id=user_id, invited=mail is not None)


@router.delete(
    "/tenants/{tenant_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT, tags=["members"],
)
async def remove_member(
    user_id: uuid.UUID, ctx: PathTenant, db: DbSession, auth: Auth
) -> None:
    await MemberService(db, ctx, auth).remove(user_id)


# --- projects --------------------------------------------------------------------------


@router.get("/projects", tags=["projects"])
async def list_projects(ctx: CurrentTenant, db: DbSession, page: Pagination) -> Page[ProjectOut]:
    items, cursor = await ProjectService(db, ctx).list_projects(page)
    return Page(items=[project_out(p) for p in items], next_cursor=cursor)


@router.post("/projects", status_code=status.HTTP_201_CREATED, tags=["projects"])
async def create_project(
    body: ProjectCreate, response: Response, ctx: CurrentTenant, db: DbSession
) -> ProjectOut:
    project = await ProjectService(db, ctx).create(body)
    await db.refresh(project)
    response.headers["Location"] = f"/api/v1/projects/{project.id}"
    return project_out(project)


@router.get("/projects/{project_id}", tags=["projects"])
async def get_project(project_id: uuid.UUID, ctx: CurrentTenant, db: DbSession) -> ProjectOut:
    return project_out(await ProjectService(db, ctx).get(project_id))


@router.patch("/projects/{project_id}", tags=["projects"])
async def update_project(
    project_id: uuid.UUID, body: ProjectUpdate, ctx: CurrentTenant, db: DbSession
) -> ProjectOut:
    project = await ProjectService(db, ctx).update(project_id, body)
    await db.refresh(project)
    return project_out(project)


@router.delete(
    "/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["projects"]
)
async def delete_project(
    project_id: uuid.UUID, body: Confirm, ctx: CurrentTenant, db: DbSession
) -> None:
    await ProjectService(db, ctx).delete(project_id, body.confirm)
