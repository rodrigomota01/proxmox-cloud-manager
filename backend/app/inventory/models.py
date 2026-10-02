"""Provider clusters, credentials and the observed infrastructure. Global tables (no
RLS): reachable only through /admin/* endpoints."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk


class ProviderCluster(UUIDPk, Timestamps, Base):
    __tablename__ = "provider_clusters"

    name: Mapped[str] = mapped_column(Text, unique=True)
    provider: Mapped[str] = mapped_column(Text, server_default="proxmox")
    api_url: Mapped[str] = mapped_column(Text)
    ca_pem: Mapped[str | None] = mapped_column(Text)  # None -> system CAs
    insecure_skip_verify: Mapped[bool] = mapped_column(Boolean, server_default="false")
    status: Mapped[str] = mapped_column(Text, server_default="unknown")  # online|offline|...
    version: Mapped[str | None] = mapped_column(Text)
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class ProviderCredential(Base):
    """Write-only secret (envelope encryption, ADR-0007). Never leaves the backend."""

    __tablename__ = "provider_credentials"

    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="CASCADE"), primary_key=True
    )
    token_id: Mapped[str] = mapped_column(Text)
    secret_ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    dek_wrapped: Mapped[bytes] = mapped_column(LargeBinary)
    kek_ref: Mapped[str] = mapped_column(Text)
    rotated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Node(UUIDPk, Base):
    __tablename__ = "nodes"
    __table_args__ = (UniqueConstraint("cluster_id", "name"),)

    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)  # online|offline|unknown
    cpu_count: Mapped[int] = mapped_column(Integer, server_default="0")
    memory_bytes: Mapped[int] = mapped_column(BigInteger, server_default="0")
    cpu_usage: Mapped[float] = mapped_column(Float, server_default="0")
    memory_used_bytes: Mapped[int] = mapped_column(BigInteger, server_default="0")
    uptime_seconds: Mapped[int] = mapped_column(BigInteger, server_default="0")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StoragePool(UUIDPk, Base):
    __tablename__ = "storage_pools"
    __table_args__ = (UniqueConstraint("cluster_id", "node", "name"),)

    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="CASCADE")
    )
    node: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    type: Mapped[str] = mapped_column(Text)
    content: Mapped[list[str]] = mapped_column(ARRAY(Text))
    shared: Mapped[bool] = mapped_column(Boolean)
    active: Mapped[bool] = mapped_column(Boolean)
    total_bytes: Mapped[int] = mapped_column(BigInteger)
    used_bytes: Mapped[int] = mapped_column(BigInteger)
    offered: Mapped[bool] = mapped_column(Boolean, server_default="false")  # Phase 2
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SyncRun(UUIDPk, Base):
    __tablename__ = "sync_runs"

    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="CASCADE"), index=True
    )
    trigger: Mapped[str] = mapped_column(Text)  # scheduled|manual
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, server_default="running")  # succeeded|failed
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    error: Mapped[str | None] = mapped_column(Text)
