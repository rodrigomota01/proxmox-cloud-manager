"""Role bindings with the anti-escalation rules of docs/architecture/03-tenancy-e-rbac.md:

- nobody grants (or revokes) a role whose permissions they do not hold at that scope;
- nobody changes their own bindings;
- the last TENANT_ADMIN of a tenant cannot be removed;
- platform bindings are not managed here (only /admin, platform:admin).
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import TenantContext
from app.audit import service as audit
from app.core.errors import Conflict, Forbidden, NotFound, ValidationError
from app.iam.authz import Scope, authorize, is_member
from app.iam.models import Role, RoleBinding, RolePermission
from app.tenancy.models import Project

MANAGE = "member:manage"
TENANT_ADMIN = "TENANT_ADMIN"


async def role_by_name(db: AsyncSession, name: str) -> Role:
    role = await db.scalar(select(Role).where(Role.name == name))
    if role is None:
        raise ValidationError(errors=[{"field": "role", "message": "unknown role"}])
    return role


async def role_permissions(db: AsyncSession, role_id: uuid.UUID) -> set[str]:
    rows = await db.execute(
        select(RolePermission.permission).where(RolePermission.role_id == role_id)
    )
    return set(rows.scalars())


async def live_project(db: AsyncSession, tenant_id: uuid.UUID, project_id: uuid.UUID) -> Project:
    project = await db.scalar(
        select(Project).where(
            Project.id == project_id, Project.tenant_id == tenant_id, Project.deleted_at.is_(None)
        )
    )
    if project is None:
        raise NotFound()
    return project


class BindingService:
    def __init__(self, db: AsyncSession, ctx: TenantContext) -> None:
        self.db, self.ctx = db, ctx

    @property
    def actor(self) -> uuid.UUID:
        return self.ctx.principal.user_id

    def _scope(self, binding: RoleBinding) -> Scope:
        if binding.scope_type == "project":
            return Scope(self.ctx.tenant_id, binding.scope_id)
        return Scope(self.ctx.tenant_id)

    async def _authorize_role(self, role: Role, scope: Scope) -> None:
        held = await authorize(self.db, self.actor, MANAGE, scope)
        missing = await role_permissions(self.db, role.id) - held
        if missing:
            raise Forbidden(f"Cannot manage role {role.name}: it grants permissions you lack")

    async def create(
        self, user_id: uuid.UUID, role_name: str, project_id: uuid.UUID | None = None
    ) -> RoleBinding:
        scope_type = "project" if project_id else "tenant"
        scope = Scope(self.ctx.tenant_id, project_id)
        role = await role_by_name(self.db, role_name)
        if project_id:
            await live_project(self.db, self.ctx.tenant_id, project_id)
        await self._authorize_role(role, scope)
        if scope_type not in role.allowed_scopes:
            message = f"{role.name} cannot be bound at {scope_type} scope"
            raise ValidationError(errors=[{"field": "role", "message": message}])
        if user_id == self.actor:
            raise Forbidden("You cannot change your own role bindings")
        if not await is_member(self.db, user_id, self.ctx.tenant_id):
            raise NotFound("User is not a member of this tenant")

        binding = RoleBinding(
            user_id=user_id, role_id=role.id, scope_type=scope_type,
            scope_id=project_id or self.ctx.tenant_id, tenant_id=self.ctx.tenant_id,
            created_by=self.actor,
        )
        try:
            async with self.db.begin_nested():
                self.db.add(binding)
        except IntegrityError as exc:
            raise Conflict("This role binding already exists") from exc
        await audit.record(
            self.db, "ROLE_BINDING_CREATE", actor_user_id=self.actor,
            tenant_id=self.ctx.tenant_id, resource_type="role_binding", resource_id=binding.id,
            details={"user_id": str(user_id), "role": role.name, "scope": scope.label},
        )
        return binding

    async def delete(self, binding_id: uuid.UUID) -> None:
        binding = await self.db.get(RoleBinding, binding_id)  # RLS: only this tenant's
        if binding is None or binding.tenant_id != self.ctx.tenant_id:
            raise NotFound()
        await self.remove(binding)

    async def remove(self, binding: RoleBinding, *, allow_self: bool = False) -> None:
        role = await self.db.get_one(Role, binding.role_id)
        await self._authorize_role(role, self._scope(binding))
        if binding.user_id == self.actor and not allow_self:
            raise Forbidden("You cannot change your own role bindings")
        await self._ensure_not_last_admin(binding, role)
        await self.db.delete(binding)
        await self.db.flush()
        await audit.record(
            self.db, "ROLE_BINDING_DELETE", actor_user_id=self.actor,
            tenant_id=self.ctx.tenant_id, resource_type="role_binding", resource_id=binding.id,
            details={
                "user_id": str(binding.user_id), "role": role.name,
                "scope": self._scope(binding).label,
            },
        )

    async def _ensure_not_last_admin(self, binding: RoleBinding, role: Role) -> None:
        if role.name != TENANT_ADMIN or binding.scope_type != "tenant":
            return
        remaining = await self.db.scalar(
            select(func.count())
            .select_from(RoleBinding)
            .where(
                RoleBinding.role_id == role.id,
                RoleBinding.scope_type == "tenant",
                RoleBinding.scope_id == self.ctx.tenant_id,
                RoleBinding.id != binding.id,
            )
        )
        if not remaining:
            raise Conflict("A tenant must keep at least one TENANT_ADMIN")

    async def list_bindings(
        self, *, user_id: uuid.UUID | None = None, project_id: uuid.UUID | None = None
    ) -> list[tuple[RoleBinding, str]]:
        await authorize(self.db, self.actor, MANAGE, Scope(self.ctx.tenant_id, project_id))
        stmt = (
            select(RoleBinding, Role.name)
            .join(Role, Role.id == RoleBinding.role_id)
            .where(RoleBinding.tenant_id == self.ctx.tenant_id)
            .order_by(RoleBinding.created_at)
        )
        if user_id:
            stmt = stmt.where(RoleBinding.user_id == user_id)
        if project_id:
            stmt = stmt.where(
                RoleBinding.scope_type == "project", RoleBinding.scope_id == project_id
            )
        return [(b, name) for b, name in (await self.db.execute(stmt)).all()]
