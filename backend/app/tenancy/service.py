"""Tenants, memberships and projects. Every read runs under the tenant's RLS scope;
every write is authorized against the row loaded from the database (never against
identifiers the client sent)."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, exists, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, TenantContext
from app.audit import service as audit
from app.auth.service import AuthService
from app.core.errors import Conflict, Forbidden, NotFound, ValidationError
from app.core.ids import uuid7
from app.core.pagination import PageParams, paginate
from app.db.session import set_tenant_scope
from app.iam.authz import PLATFORM, Scope, authorize, effective_permissions
from app.iam.models import Role, RoleBinding, User
from app.iam.service import TENANT_ADMIN, BindingService, live_project
from app.infra.mailer import Mail
from app.tenancy.models import Project, Tenant, TenantMembership
from app.tenancy.schemas import (
    BindingOut,
    MemberAdd,
    MemberOut,
    ProjectCreate,
    ProjectUpdate,
    TenantCreate,
)


def _require_confirm(given: str, expected: str) -> None:
    if given != expected:
        raise ValidationError(
            f"Type '{expected}' to confirm",
            errors=[{"field": "confirm", "message": "does not match the resource name"}],
        )


async def _flush_or_conflict(db: AsyncSession, obj: object, message: str) -> None:
    try:
        async with db.begin_nested():
            db.add(obj)
    except IntegrityError as exc:
        raise Conflict(message) from exc


# --- tenants ---------------------------------------------------------------------------


class TenantService:
    def __init__(self, db: AsyncSession, auth: AuthService) -> None:
        self.db, self.auth = db, auth

    async def list_for(self, principal: Principal) -> list[Tenant]:
        # RLS (app.user_id): only tenants the user is a member of
        rows = await self.db.execute(
            select(Tenant)
            .join(TenantMembership, TenantMembership.tenant_id == Tenant.id)
            .where(TenantMembership.user_id == principal.user_id)
            .order_by(Tenant.name)
        )
        return list(rows.scalars())

    async def create(
        self, principal: Principal, body: TenantCreate
    ) -> tuple[Tenant, Mail | None]:
        await authorize(self.db, principal.user_id, "tenant:create", PLATFORM)
        # id known before the insert: RLS only lets cm_app write rows of the scoped tenant
        tenant = Tenant(id=uuid7(), slug=body.slug, name=body.name)
        await set_tenant_scope(self.db, [tenant.id])
        await _flush_or_conflict(self.db, tenant, "A tenant with this slug already exists")
        await audit.record(
            self.db, "TENANT_CREATE", actor_user_id=principal.user_id, tenant_id=tenant.id,
            resource_type="tenant", resource_id=tenant.id, details={"slug": tenant.slug},
        )
        mail = None
        if body.admin_email:
            ctx = TenantContext(principal, tenant.id, via_platform=True)
            _, mail = await MemberService(self.db, ctx, self.auth).add(
                MemberAdd(email=body.admin_email, role=TENANT_ADMIN), tenant=tenant
            )
        return tenant, mail

    async def get(self, ctx: TenantContext) -> Tenant:
        tenant = await self.db.get(Tenant, ctx.tenant_id)
        if tenant is None:
            raise NotFound()
        return tenant

    async def rename(self, ctx: TenantContext, name: str) -> Tenant:
        await authorize(self.db, ctx.principal.user_id, "tenant:manage", Scope(ctx.tenant_id))
        tenant = await self.get(ctx)
        old, tenant.name = tenant.name, name
        await audit.record(
            self.db, "TENANT_UPDATE", actor_user_id=ctx.principal.user_id,
            tenant_id=tenant.id, resource_type="tenant", resource_id=tenant.id,
            details={"name": {"from": old, "to": name}},
        )
        return tenant

    async def delete(self, ctx: TenantContext, confirm: str) -> None:
        await authorize(self.db, ctx.principal.user_id, "tenant:delete", Scope(ctx.tenant_id))
        tenant = await self.get(ctx)
        _require_confirm(confirm, tenant.slug)
        has_projects = await self.db.scalar(
            select(
                exists().where(Project.tenant_id == tenant.id, Project.deleted_at.is_(None))
            )
        )
        if has_projects:
            raise Conflict("Delete the tenant's projects first")
        await audit.record(
            self.db, "TENANT_DELETE", actor_user_id=ctx.principal.user_id,
            tenant_id=tenant.id, resource_type="tenant", resource_id=tenant.id,
            details={"slug": tenant.slug},
        )
        await self.db.delete(tenant)  # memberships, bindings, projects cascade


# --- members ---------------------------------------------------------------------------


class MemberService:
    def __init__(self, db: AsyncSession, ctx: TenantContext, auth: AuthService) -> None:
        self.db, self.ctx, self.auth = db, ctx, auth
        self.bindings = BindingService(db, ctx)

    @property
    def actor(self) -> uuid.UUID:
        return self.ctx.principal.user_id

    async def list(self) -> list[MemberOut]:
        await authorize(self.db, self.actor, "member:manage", Scope(self.ctx.tenant_id))
        users = (
            await self.db.execute(
                select(User)
                .join(TenantMembership, TenantMembership.user_id == User.id)
                .where(TenantMembership.tenant_id == self.ctx.tenant_id)
                .order_by(User.email)
            )
        ).scalars().all()
        bindings = (
            await self.db.execute(
                select(RoleBinding, Role.name)
                .join(Role, Role.id == RoleBinding.role_id)
                .where(RoleBinding.tenant_id == self.ctx.tenant_id)
                .order_by(RoleBinding.created_at)
            )
        ).all()
        by_user: dict[uuid.UUID, list[BindingOut]] = {}
        for b, role in bindings:
            by_user.setdefault(b.user_id, []).append(binding_out(b, role))
        return [
            MemberOut(
                user_id=u.id, email=u.email, display_name=u.display_name,
                invited=u.password_hash is None, bindings=by_user.get(u.id, []),
            )
            for u in users
        ]

    async def add(
        self, body: MemberAdd, *, tenant: Tenant | None = None
    ) -> tuple[uuid.UUID, Mail | None]:
        """Adds a member with one role binding. Unknown e-mails become invited users.
        Returns the user id and the invitation e-mail to send, if any."""
        scope = Scope(self.ctx.tenant_id, body.project_id)
        await authorize(self.db, self.actor, "member:manage", scope)
        if body.project_id:
            await live_project(self.db, self.ctx.tenant_id, body.project_id)

        mail = None
        user = await self.db.scalar(select(User).where(User.email == body.email))
        if user is None:
            user = User(email=body.email, display_name=body.display_name or body.email)
            self.db.add(user)
            await self.db.flush()
            tenant = tenant or await self.db.get_one(Tenant, self.ctx.tenant_id)
            inviter = await self.db.get_one(User, self.actor)
            mail = await self.auth.invite(
                user, tenant_name=tenant.name, invited_by=inviter.display_name
            )
            await audit.record(
                self.db, "USER_INVITE", actor_user_id=self.actor, tenant_id=self.ctx.tenant_id,
                resource_type="user", resource_id=user.id,
            )

        if user.id == self.actor:
            raise Forbidden("You cannot change your own role bindings")
        already = await self.db.scalar(
            select(
                exists().where(
                    TenantMembership.user_id == user.id,
                    TenantMembership.tenant_id == self.ctx.tenant_id,
                )
            )
        )
        if not already:
            self.db.add(TenantMembership(tenant_id=self.ctx.tenant_id, user_id=user.id))
            await self.db.flush()
            await audit.record(
                self.db, "MEMBER_ADD", actor_user_id=self.actor, tenant_id=self.ctx.tenant_id,
                resource_type="user", resource_id=user.id,
            )
        await self.bindings.create(user.id, body.role, body.project_id)
        return user.id, mail

    async def remove(self, user_id: uuid.UUID) -> None:
        await authorize(self.db, self.actor, "member:manage", Scope(self.ctx.tenant_id))
        if user_id == self.actor:
            raise Forbidden("You cannot remove yourself")
        membership = await self.db.scalar(
            select(TenantMembership).where(
                TenantMembership.user_id == user_id,
                TenantMembership.tenant_id == self.ctx.tenant_id,
            )
        )
        if membership is None:
            raise NotFound()
        bindings = (
            await self.db.execute(
                select(RoleBinding).where(
                    RoleBinding.user_id == user_id, RoleBinding.tenant_id == self.ctx.tenant_id
                )
            )
        ).scalars().all()
        for binding in bindings:  # each removal re-checks escalation and last-admin rules
            await self.bindings.remove(binding)
        await self.db.delete(membership)
        await audit.record(
            self.db, "MEMBER_REMOVE", actor_user_id=self.actor, tenant_id=self.ctx.tenant_id,
            resource_type="user", resource_id=user_id,
        )


def binding_out(b: RoleBinding, role: str) -> BindingOut:
    return BindingOut(
        id=b.id, user_id=b.user_id, role=role, scope_type=b.scope_type,
        scope_id=b.scope_id, created_at=b.created_at,
    )


# --- projects --------------------------------------------------------------------------


class ProjectService:
    def __init__(self, db: AsyncSession, ctx: TenantContext) -> None:
        self.db, self.ctx = db, ctx

    @property
    def actor(self) -> uuid.UUID:
        return self.ctx.principal.user_id

    async def list(self, params: PageParams) -> tuple[list[Project], str | None]:
        stmt = select(Project).where(
            Project.tenant_id == self.ctx.tenant_id, Project.deleted_at.is_(None)
        )
        tenant_perms = await effective_permissions(self.db, self.actor, Scope(self.ctx.tenant_id))
        if "vm:view" not in tenant_perms:
            # only projects where the user has a project-level binding
            stmt = stmt.where(
                Project.id.in_(
                    select(RoleBinding.scope_id).where(
                        RoleBinding.user_id == self.actor, RoleBinding.scope_type == "project"
                    )
                )
            )
        return await paginate(self.db, stmt, Project.id, params)

    async def get(self, project_id: uuid.UUID) -> Project:
        project = await live_project(self.db, self.ctx.tenant_id, project_id)
        await authorize(
            self.db, self.actor, "vm:view", Scope(self.ctx.tenant_id, project.id)
        )
        return project

    async def create(self, body: ProjectCreate) -> Project:
        await authorize(self.db, self.actor, "project:create", Scope(self.ctx.tenant_id))
        project = Project(
            tenant_id=self.ctx.tenant_id, slug=body.slug, name=body.name,
            description=body.description,
        )
        await _flush_or_conflict(self.db, project, "A project with this slug already exists")
        await audit.record(
            self.db, "PROJECT_CREATE", actor_user_id=self.actor, tenant_id=self.ctx.tenant_id,
            resource_type="project", resource_id=project.id, details={"slug": project.slug},
        )
        return project

    async def update(self, project_id: uuid.UUID, body: ProjectUpdate) -> Project:
        project = await live_project(self.db, self.ctx.tenant_id, project_id)
        await authorize(self.db, self.actor, "project:create", Scope(self.ctx.tenant_id))
        changes = body.model_dump(exclude_none=True)
        for field, value in changes.items():
            setattr(project, field, value)
        await self.db.flush()
        await audit.record(
            self.db, "PROJECT_UPDATE", actor_user_id=self.actor, tenant_id=self.ctx.tenant_id,
            resource_type="project", resource_id=project.id, details={"fields": sorted(changes)},
        )
        return project

    async def delete(self, project_id: uuid.UUID, confirm: str) -> None:
        project = await live_project(self.db, self.ctx.tenant_id, project_id)
        await authorize(self.db, self.actor, "project:delete", Scope(self.ctx.tenant_id))
        _require_confirm(confirm, project.slug)
        # Phase 2: refuse while the project still has instances
        project.deleted_at = datetime.now(UTC)
        await self.db.execute(
            delete(RoleBinding).where(
                RoleBinding.scope_type == "project", RoleBinding.scope_id == project.id
            )
        )
        await audit.record(
            self.db, "PROJECT_DELETE", actor_user_id=self.actor, tenant_id=self.ctx.tenant_id,
            resource_type="project", resource_id=project.id, details={"slug": project.slug},
        )
