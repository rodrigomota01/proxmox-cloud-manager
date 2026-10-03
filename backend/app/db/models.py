"""Imports every ORM model so Base.metadata is complete (Alembic, schema tests)."""

from app.audit.models import AuditLog
from app.auth.models import PasswordResetToken, RefreshToken, Session
from app.compute.models import Instance
from app.db.base import Base
from app.iam.models import Permission, Role, RoleBinding, RolePermission, User
from app.images.models import Image, ImageTemplate
from app.inventory.models import Node, ProviderCluster, ProviderCredential, StoragePool, SyncRun
from app.jobs.models import Job, JobEvent
from app.regions.models import Region, Zone
from app.sshkeys.models import SshPublicKey
from app.tenancy.models import Project, Tenant, TenantMembership, TenantQuota

__all__ = [
    "AuditLog",
    "Base",
    "Image",
    "ImageTemplate",
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
    "Region",
    "Role",
    "RoleBinding",
    "RolePermission",
    "Session",
    "SshPublicKey",
    "StoragePool",
    "SyncRun",
    "Tenant",
    "TenantMembership",
    "TenantQuota",
    "User",
    "Zone",
]
