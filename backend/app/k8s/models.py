"""Kubernetes clusters (ADR-0016, ADR-0017), platform-only.

- k8s_clusters: one row per cluster, copied from the legacy kubernetes_clusters table
  (source='table') or registered by a platform admin (source='manual'). The kubeconfig
  is stored sealed (envelope encryption, like Proxmox tokens) and only leaves the
  backend through the audited download route.
- k8s_snapshots: the last state read from each cluster's API by the worker (health,
  load, namespaces, workloads, services). Read-only collection; no secrets stored.

Platform data: the tables are reached through /admin/* (cluster:manage) and RLS allows
platform scope only. A cluster may be linked to one tenant (tenant_id); its members read
it through the k8s_tenant_* views (migration 0014), which carry no credential column.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, LargeBinary, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPk

SOURCES = ("table", "manual")
HEALTH = ("healthy", "warning", "critical", "unreachable")


class K8sCluster(UUIDPk, Base):
    __tablename__ = "k8s_clusters"
    __table_args__ = (CheckConstraint(f"source IN {SOURCES}", name="source"),)

    name: Mapped[str] = mapped_column(Text, unique=True)  # kubernetes_clusters.client
    # the table sync only touches (and removes) its own rows
    source: Mapped[str] = mapped_column(Text, server_default="table")
    # the client the cluster belongs to (set by a platform admin, never by the sync)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), index=True
    )
    api_server: Mapped[str | None] = mapped_column(Text)  # api_server_dns
    server_url: Mapped[str | None] = mapped_column(Text)  # from the kubeconfig
    # what the table says vs. what the kubeconfig's client certificate says
    certs_expire_on: Mapped[date | None] = mapped_column(Date)
    cert_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    nodes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default="[]")
    kubeconfig_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    dek_wrapped: Mapped[bytes | None] = mapped_column(LargeBinary)
    kek_ref: Mapped[str | None] = mapped_column(Text)
    kubeconfig_sha256: Mapped[str | None] = mapped_column(Text)  # re-seal only on change
    kubeconfig_error: Mapped[str | None] = mapped_column(Text)
    source_modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class K8sSnapshot(Base):
    """Last collection from the cluster API. `summary` feeds lists and the dashboard;
    `data` holds the detail (nodes, namespaces, workloads, pods, services, ingresses)."""

    __tablename__ = "k8s_snapshots"
    __table_args__ = (CheckConstraint(f"health IN {HEALTH}", name="health"),)

    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("k8s_clusters.id", ondelete="CASCADE"), primary_key=True
    )
    health: Mapped[str] = mapped_column(Text)
    reasons: Mapped[list[str]] = mapped_column(JSONB, server_default="[]")
    error: Mapped[str | None] = mapped_column(Text)
    version: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # last successful collection: `data` may be older than collected_at when unreachable
    ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
