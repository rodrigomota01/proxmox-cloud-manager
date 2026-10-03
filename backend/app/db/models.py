"""Imports every ORM model so Base.metadata is complete (Alembic, schema tests)."""

from app.audit.models import AuditLog
from app.auth.models import PasswordResetToken, RefreshToken, Session
from app.compute.models import Instance
from app.db.base import Base
from app.iam.models import Permission, Role, RoleBinding, RolePermission, User
from app.inventory.models import Node, ProviderCluster, ProviderCredential, StoragePool, SyncRun
from app.jobs.models import Job, JobEvent
from app.tenancy.models import Project, Tenant, TenantMembership

__all__ = [
    "AuditLog",
    "Base",
    "Instance",
    "Job",
    "JobEvent",
    "Node",
    "PasswordResetToken",
    "Permission",
    "Project",
    "ProviderCluster",
    "ProviderCredential",
    "RefreshToken",
    "Role",
    "RoleBinding",
    "RolePermission",
    "Session",
    "StoragePool",
    "SyncRun",
    "Tenant",
    "TenantMembership",
    "User",
]
