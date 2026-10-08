"""Price tables and accrued usage (ADR-0015).

Prices are monthly, per allocated unit. A price change inserts new `price_items` rows
(effective now) instead of editing old ones: costs already accrued keep the price they
were accrued at, and the history of a table stays readable.

`usage_records` holds one row per instance per hour (in UTC) with the seconds observed
and the cost accrued in that hour, split by resource. Tenants read their rows (RLS);
only the worker (platform scope) writes them.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk

# vcpu and memory_gb are charged while the guest runs; disk_gb and instance while it exists
RESOURCES = ("vcpu", "memory_gb", "disk_gb", "instance")
HOURS_PER_MONTH = 730
Money = Numeric(18, 6)


class PriceTable(UUIDPk, Timestamps, Base):
    __tablename__ = "price_tables"
    __table_args__ = (
        Index("uq_price_tables_default", "is_default", unique=True,
              postgresql_where=text("is_default")),
    )

    name: Mapped[str] = mapped_column(Text, unique=True)
    description: Mapped[str] = mapped_column(Text, server_default="")
    # tenants without a table of their own are priced by the default one
    is_default: Mapped[bool] = mapped_column(server_default="false")


class PriceItem(UUIDPk, Base):
    __tablename__ = "price_items"
    __table_args__ = (
        UniqueConstraint("price_table_id", "resource", "effective_from"),
        CheckConstraint(f"resource IN {RESOURCES}", name="resource"),
        CheckConstraint("monthly_price >= 0", name="price"),
    )

    price_table_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("price_tables.id", ondelete="CASCADE")
    )
    resource: Mapped[str] = mapped_column(Text)
    monthly_price: Mapped[Decimal] = mapped_column(Money)  # per unit, per 730 h
    effective_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class UsageRecord(UUIDPk, Base):
    __tablename__ = "usage_records"
    __table_args__ = (
        UniqueConstraint("instance_id", "period_start"),
        Index("ix_usage_records_tenant_period", "tenant_id", "period_start"),
        CheckConstraint("running_seconds <= seconds", name="seconds"),
    )

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"))
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL")
    )
    instance_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("instances.id", ondelete="CASCADE")
    )
    price_table_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("price_tables.id", ondelete="SET NULL")
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # UTC hour
    # sizing as last observed in the hour
    instance_name: Mapped[str] = mapped_column(Text)
    vcpus: Mapped[int] = mapped_column(Integer)
    memory_mb: Mapped[int] = mapped_column(Integer)
    disk_gb: Mapped[int] = mapped_column(Integer)
    seconds: Mapped[int] = mapped_column(Integer, server_default="0")
    running_seconds: Mapped[int] = mapped_column(Integer, server_default="0")
    cost_vcpu: Mapped[Decimal] = mapped_column(Money, server_default="0")
    cost_memory: Mapped[Decimal] = mapped_column(Money, server_default="0")
    cost_disk: Mapped[Decimal] = mapped_column(Money, server_default="0")
    cost_instance: Mapped[Decimal] = mapped_column(Money, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class BillingCursor(Base):
    """Single row: usage has been accrued up to `accrued_until`."""

    __tablename__ = "billing_cursor"
    __table_args__ = (CheckConstraint("id = 1", name="single_row"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    accrued_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
