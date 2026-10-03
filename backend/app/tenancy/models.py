import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk


class Tenant(UUIDPk, Timestamps, Base):
    __tablename__ = "tenants"

    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default="active")


class TenantMembership(UUIDPk, Base):
    __tablename__ = "tenant_memberships"
    __table_args__ = (UniqueConstraint("tenant_id", "user_id"),)

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Project(UUIDPk, Timestamps, Base):
    __tablename__ = "projects"
    __table_args__ = (
        Index(
            "uq_projects_tenant_slug_live", "tenant_id", "slug",
            unique=True, postgresql_where=text("deleted_at IS NULL"),
        ),
    )

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"))
    slug: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default="")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TenantQuota(UUIDPk, Base):
    """Limit per tenant and resource. Missing row -> the platform default (settings)."""

    __tablename__ = "tenant_quotas"
    __table_args__ = (UniqueConstraint("tenant_id", "resource"),)

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"))
    resource: Mapped[str] = mapped_column(Text)  # vcpus|memory_mb|storage_gb|instances
    limit_value: Mapped[int] = mapped_column(BigInteger)
