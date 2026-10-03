import re
import uuid
from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints, field_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
# user@realm!tokenid (Proxmox API token id)
TokenId = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[^@!\s]+@[^@!\s]+![A-Za-z0-9_.-]+$")
]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _check_api_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if not value.startswith(("https://", "http://")) or "?" in value or "#" in value:
        raise ValueError("expected https://host[:port]")
    return value.removesuffix("/api2/json")


def _check_ca(value: str | None) -> str | None:
    if value is not None and "-----BEGIN CERTIFICATE-----" not in value:
        raise ValueError("expected PEM certificate(s)")
    return value


class VmidRange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: Annotated[int, Field(ge=100, le=999_999_999)] = 10_000
    end: Annotated[int, Field(ge=100, le=999_999_999)] = 19_999


# Proxmox pool where new instances are created (the token's ACL scope)
Pool = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9._-]{1,64}$")]


class ClusterCreate(Input):
    name: Name
    api_url: Annotated[str, Field(max_length=255)]
    pool: Pool | None = None
    zone_id: uuid.UUID | None = None
    ca_pem: Annotated[str | None, Field(max_length=65_536)] = None
    insecure_skip_verify: bool = False
    vmid_range: VmidRange = VmidRange()

    _url = field_validator("api_url")(_check_api_url)
    _ca = field_validator("ca_pem")(_check_ca)


class ClusterUpdate(Input):
    name: Name | None = None
    pool: Pool | None = None
    zone_id: uuid.UUID | None = None
    api_url: Annotated[str | None, Field(max_length=255)] = None
    ca_pem: Annotated[str | None, Field(max_length=65_536)] = None
    insecure_skip_verify: bool | None = None
    vmid_range: VmidRange | None = None

    @field_validator("api_url")
    @classmethod
    def _url(cls, value: str | None) -> str | None:
        return None if value is None else _check_api_url(value)

    _ca = field_validator("ca_pem")(_check_ca)


_PVE_SECRET = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")


class CredentialsPut(Input):
    token_id: TokenId
    secret: Annotated[SecretStr, Field(min_length=1, max_length=256)]

    @field_validator("secret")
    @classmethod
    def _secret_format(cls, value: SecretStr) -> SecretStr:
        # Proxmox token secrets are UUIDs; catching a pasted password here beats a 401
        # from the hypervisor (and repeated failed logins against it)
        cleaned = value.get_secret_value().strip()
        if not _PVE_SECRET.match(cleaned):
            raise ValueError(
                "expected the Proxmox token secret (UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
            )
        return SecretStr(cleaned)


class ClusterOut(BaseModel):
    id: uuid.UUID
    name: str
    provider: str
    api_url: str
    has_custom_ca: bool
    insecure_skip_verify: bool
    status: str
    version: str | None
    settings: dict[str, Any]
    zone_id: uuid.UUID | None
    zone_name: str | None
    region_name: str | None
    has_credentials: bool
    token_id: str | None  # the id is not secret; the secret is never returned
    credentials_rotated_at: datetime | None
    last_synced_at: datetime | None
    last_error: str | None
    created_at: datetime


class CredentialsOut(BaseModel):
    token_id: str
    rotated_at: datetime


class ConnectionTest(BaseModel):
    ok: bool
    version: str | None = None
    nodes_online: int | None = None
    nodes_total: int | None = None
    guests_visible: int | None = None
    error: str | None = None


class SyncRunOut(BaseModel):
    id: uuid.UUID
    cluster_id: uuid.UUID
    trigger: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    stats: dict[str, Any]
    error: str | None


class NodeBase(BaseModel):
    id: uuid.UUID
    cluster_id: uuid.UUID
    name: str
    status: str
    cpu_count: int
    memory_bytes: int
    cpu_usage: float
    memory_used_bytes: int
    uptime_seconds: int
    last_seen_at: datetime | None


class NodeOut(NodeBase):
    # capacity planning: what guests on this node were given vs what it physically has
    cluster_name: str
    zone_name: str | None
    region_name: str | None
    instances_total: int
    instances_running: int
    vcpus_allocated: int
    memory_allocated_mb: int


class NodeMetricPointOut(BaseModel):
    t: int
    cpu: float
    memory_used_mb: int
    memory_total_mb: int
    net_in_bps: float
    net_out_bps: float
    load: float
    iowait: float


class NodeMetricsOut(BaseModel):
    range: str
    points: list[NodeMetricPointOut]


class StorageOut(BaseModel):
    id: uuid.UUID
    cluster_id: uuid.UUID
    node: str
    name: str
    type: str
    content: list[str]
    shared: bool
    active: bool
    total_bytes: int
    used_bytes: int


class AdminInstanceOut(BaseModel):
    """Admin view: includes provider identifiers (vmid/node), never shown to tenants."""

    id: uuid.UUID
    cluster_id: uuid.UUID
    tenant_id: uuid.UUID | None
    project_id: uuid.UUID | None
    kind: str
    name: str
    provider_name: str
    state: str
    power_state: str
    vcpus: int
    memory_mb: int
    root_disk_gb: int
    vmid: int
    node: str
    tags: list[str]
    managed: bool
    last_seen_at: datetime | None


class AdoptRequest(Input):
    tenant_id: uuid.UUID
    project_id: uuid.UUID
    name: Name | None = None


class Confirm(Input):
    confirm: str
