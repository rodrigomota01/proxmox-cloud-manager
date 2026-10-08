"""System permissions and roles — source of truth for the RBAC catalog.

Mirrors the matrix in docs/architecture/03-tenancy-e-rbac.md. Synced into the database
by `python -m app.cli migrate` (as cm_owner); cm_app can only read these tables.
"""

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.iam.models import Permission, Role, RolePermission

_LIFECYCLE = ("view", "start", "stop", "restart", "console", "create", "delete", "configure")
_OPERATE = ("view", "start", "stop", "restart", "console")

PERMISSIONS: dict[str, str] = {
    **{f"vm:{a}": f"VM: {a}" for a in (*_LIFECYCLE, "migrate")},
    **{f"container:{a}": f"Container: {a}" for a in (*_LIFECYCLE, "migrate")},
    "snapshot:create": "Create snapshots",
    "snapshot:rollback": "Roll back to a snapshot",
    "template:clone": "Create instances from templates",
    "template:create": "Create tenant-private templates",
    "template:publish": "Publish public templates",
    "storage:view": "View storage classes",
    "storage:create": "Create storage",
    "storage:delete": "Delete storage",
    "network:view": "View networks",
    "network:manage": "Manage tenant networks",
    "project:create": "Create projects",
    "project:delete": "Delete projects",
    "member:manage": "Manage members and role bindings",
    "quota:view": "View quotas",
    "quota:manage": "Manage quotas",
    "billing:view": "View usage and cost",
    "k8s:view": "View the Kubernetes clusters linked to the tenant (never the kubeconfig)",
    "billing:manage": "Manage price tables",
    "audit:view": "View audit logs",
    "tenant:create": "Create tenants",
    "tenant:delete": "Delete tenants",
    "tenant:manage": "Manage tenant settings",
    "cluster:manage": "Manage provider clusters and credentials",
    "cluster:sync": "Trigger inventory sync",
    "node:view": "View hypervisor nodes",
    "alert:manage": "Manage alert rules and notification channels",
    "user:manage": "Manage user accounts (profile, status, password reset)",
    "platform:admin": "Manage platform administrators",
}


def _compute(actions: tuple[str, ...]) -> set[str]:
    return {f"{kind}:{a}" for kind in ("vm", "container") for a in actions}


# every tenant role sees the costs of what it can see, and the tenant's clusters
_COMMON_VIEW = {"storage:view", "network:view", "quota:view", "billing:view", "k8s:view"}
_SNAPSHOTS = {"snapshot:create", "snapshot:rollback"}

ROLES: dict[str, tuple[str, list[str], set[str]]] = {
    # name: (description, allowed scopes, permissions)
    "SUPER_ADMIN": ("Everything, break-glass", ["platform"], set(PERMISSIONS)),
    "PLATFORM_ADMIN": (
        "Operate the platform", ["platform"], set(PERMISSIONS) - {"platform:admin"},
    ),
    "TENANT_ADMIN": (
        "Everything inside the tenant",
        ["tenant"],
        _compute(_LIFECYCLE) | _SNAPSHOTS | _COMMON_VIEW | {
            "template:clone", "template:create", "network:manage", "project:create",
            "project:delete", "member:manage", "billing:view", "audit:view", "tenant:manage",
            "alert:manage",
        },
    ),
    "PROJECT_ADMIN": (
        "Everything inside the project",
        ["project"],
        _compute(_LIFECYCLE) | _SNAPSHOTS | _COMMON_VIEW
        | {"template:clone", "member:manage", "billing:view"},
    ),
    "OPERATOR": (
        "Operate instances, no create/delete",
        ["tenant", "project"],
        _compute(_OPERATE) | _SNAPSHOTS | _COMMON_VIEW,
    ),
    "USER": (
        "Create and operate project resources",
        ["project"],
        _compute(_LIFECYCLE) | _SNAPSHOTS | _COMMON_VIEW | {"template:clone"},
    ),
    "READ_ONLY": (
        "Read only",
        ["platform", "tenant", "project"],
        _compute(("view",)) | _COMMON_VIEW,
    ),
}


async def sync_catalog(session: AsyncSession) -> None:
    """Idempotent upsert of system permissions/roles. Must run as cm_owner."""
    for name, description in PERMISSIONS.items():
        await session.execute(
            insert(Permission)
            .values(name=name, description=description)
            .on_conflict_do_update(index_elements=["name"], set_={"description": description})
        )
    for name, (description, scopes, perms) in ROLES.items():
        await session.execute(
            insert(Role)
            .values(name=name, description=description, is_system=True, allowed_scopes=scopes)
            .on_conflict_do_update(
                index_elements=["name"],
                set_={"description": description, "is_system": True, "allowed_scopes": scopes},
            )
        )
        role_id = (await session.execute(select(Role.id).where(Role.name == name))).scalar_one()
        await session.execute(delete(RolePermission).where(RolePermission.role_id == role_id))
        await session.execute(
            insert(RolePermission), [{"role_id": role_id, "permission": p} for p in sorted(perms)]
        )
    await session.execute(delete(Permission).where(Permission.name.not_in(PERMISSIONS)))
