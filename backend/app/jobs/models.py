import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPk

ACTIVE = ("pending", "running")


class Job(UUIDPk, Base):
    """Queue row and user-visible operation (ADR-0006). tenant_id NULL = platform job."""

    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')",
            name="status_valid",
        ),
        # what the worker polls
        Index("ix_jobs_claim", "status", "run_after"),
        Index("ix_jobs_tenant_created", "tenant_id", "created_at"),
        # one active operation per resource: concurrent power actions are refused
        Index(
            "uq_jobs_one_active_per_resource", "resource_type", "resource_id",
            unique=True, postgresql_where=text("status IN ('pending', 'running')"),
        ),
        Index(
            "uq_jobs_idempotency", "requested_by", "idempotency_key",
            unique=True, postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE")
    )
    project_id: Mapped[uuid.UUID | None]
    requested_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    type: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default="pending")
    resource_type: Mapped[str | None] = mapped_column(Text)
    resource_id: Mapped[uuid.UUID | None]
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, server_default="3")
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    run_after: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    locked_by: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JobEvent(Base):
    """Step log of a job; provider task ids (UPID) recorded here make jobs resumable."""

    __tablename__ = "job_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    job_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), index=True
    )
    tenant_id: Mapped[uuid.UUID | None]  # denormalized for RLS
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    kind: Mapped[str] = mapped_column(Text)  # started|provider_task|progress|retry|...
    message: Mapped[str] = mapped_column(Text, server_default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default="{}")
