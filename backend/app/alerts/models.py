"""Alert rules, alert occurrences and notification channels.

Ownership (tenant_id): NULL = platform (only platform scope sees/changes it); otherwise
the tenant's. RLS enforces it (migration 0009). Alerts carry the tenant that owns the
*resource*, so a tenant sees alerts on its own instances whoever wrote the rule.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk

TARGETS = ("node", "storage", "instance")
METRICS = ("cpu", "memory", "disk", "net_in", "net_out")
SEVERITIES = ("warning", "critical")
# which metric makes sense for which target
TARGET_METRICS = {
    "node": ("cpu", "memory", "net_in", "net_out"),
    "storage": ("disk",),
    "instance": METRICS,
}
RATIO_METRICS = ("cpu", "memory", "disk")  # 0..1; the network ones are bytes/s


class AlertRule(UUIDPk, Timestamps, Base):
    __tablename__ = "alert_rules"
    __table_args__ = (
        CheckConstraint(f"target IN {TARGETS}", name="target"),
        CheckConstraint(f"metric IN {METRICS}", name="metric"),
        CheckConstraint(f"severity IN {SEVERITIES}", name="severity"),
        # tenants watch their instances; hosts and storage are the platform's business
        CheckConstraint("tenant_id IS NULL OR target = 'instance'", name="tenant_target"),
        CheckConstraint("threshold > 0 AND duration_seconds >= 0", name="limits"),
    )

    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(Text)
    target: Mapped[str] = mapped_column(Text)
    metric: Mapped[str] = mapped_column(Text)
    threshold: Mapped[float] = mapped_column(Float)  # fires when value > threshold
    duration_seconds: Mapped[int] = mapped_column(Integer, server_default="300")
    severity: Mapped[str] = mapped_column(Text, server_default="warning")
    enabled: Mapped[bool] = mapped_column(Boolean, server_default="true")


class Alert(UUIDPk, Base):
    """One occurrence: pending (condition true, waiting for the duration) -> firing ->
    resolved. A pending one that clears early is simply deleted."""

    __tablename__ = "alerts"
    __table_args__ = (
        Index(
            "uq_alerts_open", "rule_id", "resource_id", unique=True,
            postgresql_where=text("state IN ('pending', 'firing')"),
        ),
        Index("ix_alerts_tenant_state", "tenant_id", "state"),
        CheckConstraint("state IN ('pending', 'firing', 'resolved')", name="state"),
    )

    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("alert_rules.id", ondelete="CASCADE"))
    rule_tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE")
    )
    # owner of the resource (None: hosts, storage, guests not adopted yet)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE")
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL")
    )
    resource_type: Mapped[str] = mapped_column(Text)  # node|storage|instance
    resource_id: Mapped[uuid.UUID] = mapped_column()
    resource_name: Mapped[str] = mapped_column(Text)
    rule_name: Mapped[str] = mapped_column(Text)
    metric: Mapped[str] = mapped_column(Text)
    threshold: Mapped[float] = mapped_column(Float)
    severity: Mapped[str] = mapped_column(Text)
    value: Mapped[float] = mapped_column(Float)  # latest observed
    peak: Mapped[float] = mapped_column(Float)
    state: Mapped[str] = mapped_column(Text, server_default="pending")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class NotificationChannel(UUIDPk, Timestamps, Base):
    __tablename__ = "notification_channels"
    __table_args__ = (
        CheckConstraint("type IN ('email', 'webhook')", name="type"),
        CheckConstraint(f"min_severity IN {SEVERITIES}", name="min_severity"),
    )

    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(Text)
    type: Mapped[str] = mapped_column(Text)
    # email: {"to": [...]}; webhook: {"url": "https://..."}
    config: Mapped[dict[str, Any]] = mapped_column(JSONB)
    min_severity: Mapped[str] = mapped_column(Text, server_default="warning")
    enabled: Mapped[bool] = mapped_column(Boolean, server_default="true")
    # webhook signing secret (envelope encryption, AAD = channel id); shown once
    secret_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    dek_wrapped: Mapped[bytes | None] = mapped_column(LargeBinary)
    kek_ref: Mapped[str | None] = mapped_column(Text)
