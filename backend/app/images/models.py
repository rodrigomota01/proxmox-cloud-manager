import uuid
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk


class Image(UUIDPk, Timestamps, Base):
    """A provider template offered for creating instances.

    Lives on one cluster, so it also decides where its instances are placed.
    visibility=public: every tenant; visibility=tenant: only tenant_id (RLS).
    """

    __tablename__ = "images"
    __table_args__ = (
        Index(
            "uq_images_cluster_template_active", "cluster_id",
            text("(provider_ref->>'vmid')"), unique=True, postgresql_where=text("active"),
        ),
        CheckConstraint(
            "(visibility = 'public' AND tenant_id IS NULL)"
            " OR (visibility = 'tenant' AND tenant_id IS NOT NULL)",
            name="visibility_owner",
        ),
    )

    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="RESTRICT")
    )
    provider_ref: Mapped[dict[str, Any]] = mapped_column(JSONB)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default="")
    os_family: Mapped[str] = mapped_column(Text, server_default="linux")
    default_user: Mapped[str] = mapped_column(Text)
    min_disk_gb: Mapped[int] = mapped_column(Integer)
    visibility: Mapped[str] = mapped_column(Text, server_default="public")
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE")
    )
    active: Mapped[bool] = mapped_column(Boolean, server_default="true")
