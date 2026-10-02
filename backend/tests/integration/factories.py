"""Test data builders. They write as cm_owner (bypassing RLS)."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.iam.models import Role, RoleBinding, User
from app.tenancy.models import Project, Tenant, TenantMembership

PASSWORD = "correct horse battery staple"


async def make_user(
    db: AsyncSession, email: str, *, password: str = PASSWORD, active: bool = True
) -> User:
    user = User(
        email=email, display_name=email.split("@")[0], password_hash=hash_password(password),
        is_active=active,
    )
    db.add(user)
    await db.commit()
    return user


async def make_tenant(db: AsyncSession, slug: str) -> Tenant:
    tenant = Tenant(slug=slug, name=slug.title())
    db.add(tenant)
    await db.commit()
    return tenant


async def make_project(db: AsyncSession, tenant: Tenant, slug: str) -> Project:
    project = Project(tenant_id=tenant.id, slug=slug, name=slug)
    db.add(project)
    await db.commit()
    return project


async def _role_id(db: AsyncSession, name: str) -> uuid.UUID:
    return (await db.execute(select(Role.id).where(Role.name == name))).scalar_one()


async def add_member(
    db: AsyncSession, tenant: Tenant, user: User, role: str = "TENANT_ADMIN",
    project: Project | None = None,
) -> None:
    """Membership (if missing) plus one binding at tenant or project scope."""
    exists = await db.scalar(
        select(TenantMembership.id).where(
            TenantMembership.tenant_id == tenant.id, TenantMembership.user_id == user.id
        )
    )
    if exists is None:
        db.add(TenantMembership(tenant_id=tenant.id, user_id=user.id))
    db.add(
        RoleBinding(
            user_id=user.id, role_id=await _role_id(db, role),
            scope_type="project" if project else "tenant",
            scope_id=project.id if project else tenant.id, tenant_id=tenant.id,
        )
    )
    await db.commit()


async def grant_platform(db: AsyncSession, user: User, role: str) -> None:
    db.add(RoleBinding(user_id=user.id, role_id=await _role_id(db, role), scope_type="platform"))
    await db.commit()
