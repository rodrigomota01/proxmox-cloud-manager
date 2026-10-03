import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    ARRAY,
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk


class Instance(UUIDPk, Timestamps, Base):
    """VM or container. Tenant-scoped (RLS); discovered guests (managed=false) have no
    tenant yet and are therefore visible only in platform scope until adopted."""

    __tablename__ = "instances"
    __table_args__ = (
        Index(
            "uq_instances_cluster_guest_live", "cluster_id", text("(provider_ref->>'vmid')"),
            unique=True, postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_instances_tenant_project", "tenant_id", "project_id"),
        # IPs are typed by users: never hand the same one to two live instances
        Index(
            "uq_instances_cluster_ipv4_live", "cluster_id", "ipv4", unique=True,
            postgresql_where=text("deleted_at IS NULL AND ipv4 IS NOT NULL"),
        ),
        CheckConstraint(
            "NOT managed OR (tenant_id IS NOT NULL AND project_id IS NOT NULL)",
            name="managed_has_owner",
        ),
    )

    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="RESTRICT")
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT")
    )
    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="RESTRICT")
    )
    node_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("nodes.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(Text)  # vm|container
    name: Mapped[str] = mapped_column(Text)
    # provisioning|active|error|deleting|deleted|deleted_externally
    state: Mapped[str] = mapped_column(Text, server_default="active")
    power_state: Mapped[str] = mapped_column(Text, server_default="unknown")
    # observed sizing (intent vs. observation and drift arrive with Phase 2 resize)
    vcpus: Mapped[int] = mapped_column(Integer)
    memory_mb: Mapped[int] = mapped_column(Integer)
    root_disk_gb: Mapped[int] = mapped_column(Integer)
    image_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("images.id", ondelete="SET NULL")
    )
    ipv4: Mapped[str | None] = mapped_column(INET)  # address without prefix
    network: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    provider_ref: Mapped[dict[str, Any]] = mapped_column(JSONB)
    provider_name: Mapped[str] = mapped_column(Text)  # name as seen in the provider
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    managed: Mapped[bool] = mapped_column(server_default="false")
    # live usage, refreshed by the reconciler (one /cluster/resources call per cycle)
    cpu_usage: Mapped[float] = mapped_column(Float, server_default="0")  # 0..1 of vcpus
    memory_used_mb: Mapped[int] = mapped_column(Integer, server_default="0")
    uptime_seconds: Mapped[int] = mapped_column(BigInteger, server_default="0")
    missing_count: Mapped[int] = mapped_column(Integer, server_default="0")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, server_default="1")

    __mapper_args__ = {"version_id_col": version}  # noqa: RUF012

