"""Imports every ORM model so Base.metadata is complete (Alembic, schema tests)."""

from app.alerts.models import Alert, AlertRule, NotificationChannel
from app.audit.models import AuditLog
from app.auth.models import PasswordResetToken, RefreshToken, Session
from app.billing.models import BillingCursor, PriceItem, PriceTable, UsageRecord
from app.compute.models import Instance
from app.db.base import Base
from app.iam.models import Permission, Role, RoleBinding, RolePermission, User
from app.images.models import Image, ImageTemplate
from app.inventory.models import Node, ProviderCluster, ProviderCredential, StoragePool, SyncRun
from app.ipam.models import IpamAddress, IpamNetwork
from app.jobs.models import Job, JobEvent
from app.k8s.models import K8sCluster, K8sSnapshot
from app.regions.models import Region, Zone
from app.sshkeys.models import SshPublicKey
from app.tenancy.models import Project, Tenant, TenantMembership, TenantQuota

__all__ = [
    "Alert",
    "AlertRule",
    "AuditLog",
    "Base",
    "BillingCursor",
    "Image",
    "ImageTemplate",
    "Instance",
    "IpamAddress",
    "IpamNetwork",
    "Job",
    "JobEvent",
    "K8sCluster",
    "K8sSnapshot",
    "Node",
    "NotificationChannel",
    "PasswordResetToken",
    "Permission",
    "PriceItem",
    "PriceTable",
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
    "UsageRecord",
    "User",
    "Zone",
]
