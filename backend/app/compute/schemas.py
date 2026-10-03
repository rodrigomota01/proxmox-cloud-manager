import ipaddress
import uuid
from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

# hostname label: also the guest's name in the provider and its cloud-init hostname
Hostname = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")
]
Tag = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_.-]{0,31}$")]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IPv4Config(Input):
    """Static IPv4 typed by the user (no IPAM in the MVP)."""

    address: str  # "203.0.113.10/28"
    gateway: str
    dns: Annotated[list[str], Field(max_length=3)] = []

    @model_validator(mode="after")
    def _consistent(self) -> "IPv4Config":
        try:
            iface = ipaddress.IPv4Interface(self.address)
            gateway = ipaddress.IPv4Address(self.gateway)
            dns = [ipaddress.IPv4Address(d) for d in self.dns]
        except ValueError as exc:
            raise ValueError(f"invalid IPv4: {exc}") from exc
        net = iface.network
        if "/" not in self.address or net.prefixlen > 30:
            raise ValueError("address must be IP/prefix with prefix <= 30, e.g. 203.0.113.10/28")
        if iface.ip in (net.network_address, net.broadcast_address):
            raise ValueError("address is the network or broadcast address")
        if gateway not in net or gateway == iface.ip:
            raise ValueError("gateway must be another address in the same subnet")
        self.address, self.gateway = str(iface), str(gateway)
        self.dns = [str(d) for d in dns]
        return self


class InstanceCreate(Input):
    project_id: uuid.UUID
    name: Hostname
    image_id: uuid.UUID
    zone_id: uuid.UUID  # the platform picks the server inside the zone
    vcpus: Annotated[int, Field(ge=1, le=32)]
    memory_mb: Annotated[int, Field(ge=512, le=262_144, multiple_of=256)]
    root_disk_gb: Annotated[int, Field(ge=1, le=2048)]
    ssh_key_ids: Annotated[list[uuid.UUID], Field(min_length=1, max_length=10)]
    ipv4: IPv4Config
    tags: Annotated[list[Tag], Field(max_length=10)] = []


class InstanceDelete(Input):
    confirm: str  # must equal the instance name


class FilesystemOut(BaseModel):
    mountpoint: str
    type: str
    used_bytes: int
    total_bytes: int


class DiskUsageOut(BaseModel):
    """Space used inside the guest. VMs need the QEMU guest agent; containers do not."""

    usage: float | None  # fullest filesystem, 0..1; None = unknown
    used_bytes: int | None
    total_bytes: int | None
    filesystems: list[FilesystemOut]
    agent: str | None  # ok|unavailable|forbidden (VMs); None for containers
    checked_at: datetime | None


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
    image_id: uuid.UUID | None
    read_only: bool  # outside the managed pool: visible, not operable
    zone_id: uuid.UUID | None  # from the server it runs on (ADR-0012)
    zone_name: str | None
    region_name: str | None
    cpu_usage: float  # 0..1 of the allocated vCPUs, as of last_seen_at
    memory_used_mb: int
    uptime_seconds: int
    net_in_bps: float  # bytes/s between the last two syncs
    net_out_bps: float
    disk: DiskUsageOut
    ipv4: str | None  # with prefix, as configured (e.g. 203.0.113.10/28)
    gateway: str | None
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
    resource_name: str | None = None  # e.g. the instance name (kept after deletion)
    requested_by_name: str | None = None


class JobEventOut(BaseModel):
    kind: str
    message: str
    occurred_at: datetime


class JobDetail(JobOut):
    events: list[JobEventOut]


class Accepted(BaseModel):
    job: JobOut


class InstanceAccepted(Accepted):
    instance: InstanceOut


class QuotaLineOut(BaseModel):
    resource: str
    limit: int
    used: int
    available: int


class DashboardSummary(BaseModel):
    projects: int
    instances: dict[str, dict[str, int]]  # kind -> power_state -> count
    active_jobs: int
    recent_jobs: list[JobOut]


class MetricPointOut(BaseModel):
    t: int  # unix seconds
    cpu: float  # 0..1 of allocated vCPUs
    memory_used_mb: int
    memory_total_mb: int
    net_in_bps: float
    net_out_bps: float
    disk_read_bps: float
    disk_write_bps: float


class MetricsOut(BaseModel):
    range: str
    points: list[MetricPointOut]
