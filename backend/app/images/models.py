import uuid
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk


class Image(UUIDPk, Timestamps, Base):
    """A catalog entry ("Debian 13"), independent of servers (ADR-0012).

    Where it can run is given by its image_templates. visibility=public: every tenant;
    visibility=tenant: only tenant_id (RLS).
    """

    __tablename__ = "images"
    __table_args__ = (
        CheckConstraint(
            "(visibility = 'public' AND tenant_id IS NULL)"
            " OR (visibility = 'tenant' AND tenant_id IS NOT NULL)",
            name="visibility_owner",
        ),
    )

    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default="")
    os_family: Mapped[str] = mapped_column(Text, server_default="linux")
    default_user: Mapped[str] = mapped_column(Text)
    min_disk_gb: Mapped[int] = mapped_column(Integer)  # largest of its templates' disks
    visibility: Mapped[str] = mapped_column(Text, server_default="public")
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE")
    )
    active: Mapped[bool] = mapped_column(Boolean, server_default="true")


class ImageTemplate(UUIDPk, Base):
    """The concrete template of an image on one server (cluster)."""

    __tablename__ = "image_templates"
    __table_args__ = (
        UniqueConstraint("image_id", "cluster_id"),  # one template per image per server
        # a template backs at most one image
        Index(
            "uq_image_templates_cluster_template", "cluster_id",
            text("(provider_ref->>'vmid')"), unique=True,
        ),
    )

    image_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("images.id", ondelete="CASCADE"), index=True
    )
    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="CASCADE")
    )
    provider_ref: Mapped[dict[str, Any]] = mapped_column(JSONB)
    disk_gb: Mapped[int] = mapped_column(Integer)
