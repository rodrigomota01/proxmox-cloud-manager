"""Authorization: effective permissions over the scope chain project -> tenant -> platform.

docs/architecture/03-tenancy-e-rbac.md. Roles and tenants are not in the access token;
they are resolved per request, so removing access takes effect immediately.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import ColumnElement, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.core.errors import Forbidden, NotFound
from app.iam.models import RoleBinding, RolePermission
from app.tenancy.models import TenantMembership


@dataclass(frozen=True)
class Scope:
    """Where a permission is checked. project_id implies tenant_id."""

    tenant_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None

    @property
    def label(self) -> str:
        if self.project_id:
            return f"project:{self.project_id}"
        return f"tenant:{self.tenant_id}" if self.tenant_id else "platform"


PLATFORM = Scope()


def _binding_matches(scope: Scope) -> ColumnElement[bool]:
    clauses = [RoleBinding.scope_type == "platform"]
    if scope.tenant_id:
        clauses.append(
            and_(RoleBinding.scope_type == "tenant", RoleBinding.scope_id == scope.tenant_id)
        )
    if scope.project_id:
        clauses.append(
            and_(RoleBinding.scope_type == "project", RoleBinding.scope_id == scope.project_id)
        )
    return or_(*clauses)


async def effective_permissions(db: AsyncSession, user_id: uuid.UUID, scope: Scope) -> set[str]:
    rows = await db.execute(
        select(RolePermission.permission)
        .join(RoleBinding, RoleBinding.role_id == RolePermission.role_id)
        .where(RoleBinding.user_id == user_id, _binding_matches(scope))
        .distinct()
    )
    return set(rows.scalars())


async def is_member(db: AsyncSession, user_id: uuid.UUID, tenant_id: uuid.UUID) -> bool:
    return bool(
        await db.scalar(
            select(
                exists().where(
                    TenantMembership.user_id == user_id, TenantMembership.tenant_id == tenant_id
                )
            )
        )
    )


async def authorize(
    db: AsyncSession, user_id: uuid.UUID, permission: str, scope: Scope
) -> set[str]:
    """Raises unless `permission` is granted at `scope`. Returns the effective set.

    Denials answer 404 when the user cannot see the scope at all (no membership), so
    the existence of other tenants' resources never leaks; 403 otherwise. The denial is
    audited and committed before raising (the request transaction is rolled back) —
    call this before any write in the request.
    """
    perms = await effective_permissions(db, user_id, scope)
    if permission in perms:
        return perms
    visible = scope.tenant_id is None or await is_member(db, user_id, scope.tenant_id)
    await audit.record(
        db, "AUTHZ_DENIED", outcome="denied", actor_user_id=user_id,
        tenant_id=scope.tenant_id if visible else None,
        details={"permission": permission, "scope": scope.label},
    )
    await db.commit()
    raise Forbidden() if visible else NotFound()
