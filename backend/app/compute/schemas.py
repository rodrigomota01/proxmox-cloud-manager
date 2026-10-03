import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel


class InstanceOut(BaseModel):
    """Tenant view. No provider identifiers (vmid/node/cluster) — ADR-0010."""

    id: uuid.UUID
    project_id: uuid.UUID
    kind: str
    name: str
    state: str
    power_state: str
    vcpus: int
    memory_mb: int
    root_disk_gb: int
    tags: list[str]
    created_at: datetime
    last_seen_at: datetime | None


class JobOut(BaseModel):
    id: uuid.UUID
    type: str
    status: str
    project_id: uuid.UUID | None
    resource_type: str | None
    resource_id: uuid.UUID | None
    payload: dict[str, Any]  # request parameters (e.g. {"action": "start"}); no provider ids
    result: dict[str, Any] | None
    error_code: str | None
    error_message: str | None
    attempts: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class JobEventOut(BaseModel):
    kind: str
    message: str
    occurred_at: datetime


class JobDetail(JobOut):
    events: list[JobEventOut]


class Accepted(BaseModel):
    job: JobOut


class DashboardSummary(BaseModel):
    projects: int
    instances: dict[str, dict[str, int]]  # kind -> power_state -> count
    active_jobs: int
    recent_jobs: list[JobOut]
