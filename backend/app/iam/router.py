"""/api/v1/roles, /role-bindings and /me/permissions."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Query, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.api.deps import CurrentPrincipal, CurrentTenant, DbSession, enter_tenant
from app.core.errors import ValidationError
from app.iam.authz import PLATFORM, Scope, effective_permissions
from app.iam.models import Role, RolePermission
from app.iam.service import BindingService, live_project
from app.tenancy.schemas import BindingOut
from app.tenancy.service import binding_out

router = APIRouter()


class RoleOut(BaseModel):
    name: str
    description: str
    allowed_scopes: list[str]
    permissions: list[str]


class BindingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: uuid.UUID
    role: str
    project_id: uuid.UUID | None = None


class PermissionsOut(BaseModel):
    scope: str
    permissions: list[str]


@router.get("/roles", tags=["iam"])
async def list_roles(_: CurrentPrincipal, db: DbSession) -> list[RoleOut]:
    roles = (await db.execute(select(Role).order_by(Role.name))).scalars().all()
    perms = (await db.execute(select(RolePermission))).scalars().all()
    by_role: dict[uuid.UUID, list[str]] = {}
    for rp in perms:
        by_role.setdefault(rp.role_id, []).append(rp.permission)
    return [
        RoleOut(
            name=r.name, description=r.description, allowed_scopes=r.allowed_scopes,
            permissions=sorted(by_role.get(r.id, [])),
        )
        for r in roles
    ]


@router.get("/role-bindings", tags=["iam"])
async def list_bindings(
    ctx: CurrentTenant, db: DbSession,
    user_id: uuid.UUID | None = None, project_id: uuid.UUID | None = None,
) -> list[BindingOut]:
    rows = await BindingService(db, ctx).list_bindings(user_id=user_id, project_id=project_id)
    return [binding_out(b, role) for b, role in rows]


@router.post("/role-bindings", status_code=status.HTTP_201_CREATED, tags=["iam"])
async def create_binding(body: BindingCreate, ctx: CurrentTenant, db: DbSession) -> BindingOut:
    binding = await BindingService(db, ctx).create(body.user_id, body.role, body.project_id)
    await db.refresh(binding)
    return binding_out(binding, body.role)


@router.delete(
    "/role-bindings/{binding_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["iam"]
)
async def delete_binding(binding_id: uuid.UUID, ctx: CurrentTenant, db: DbSession) -> None:
    await BindingService(db, ctx).delete(binding_id)


@router.get("/me/permissions", tags=["me"])
async def my_permissions(
    principal: CurrentPrincipal,
    db: DbSession,
    scope: Annotated[str, Query(description="platform | tenant:<id> | project:<id>")],
    x_tenant_id: Annotated[uuid.UUID | None, Header(alias="X-Tenant-Id")] = None,
) -> PermissionsOut:
    """For the UI to hide actions — never an access control by itself."""
    kind, _, raw_id = scope.partition(":")
    if kind == "platform" and not raw_id:
        resolved = PLATFORM
    elif kind in ("tenant", "project"):
        try:
            target = uuid.UUID(raw_id)
        except ValueError as exc:
            raise _bad_scope() from exc
        tenant_id = target if kind == "tenant" else x_tenant_id
        if tenant_id is None:
            raise ValidationError(
                errors=[{"field": "X-Tenant-Id", "message": "required for project scope"}]
            )
        await enter_tenant(db, principal, tenant_id)
        if kind == "project":
            await live_project(db, tenant_id, target)
        resolved = Scope(tenant_id, target if kind == "project" else None)
    else:
        raise _bad_scope()
    perms = await effective_permissions(db, principal.user_id, resolved)
    return PermissionsOut(scope=resolved.label, permissions=sorted(perms))


def _bad_scope() -> ValidationError:
    return ValidationError(
        errors=[{"field": "scope", "message": "expected platform, tenant:<id> or project:<id>"}]
    )
