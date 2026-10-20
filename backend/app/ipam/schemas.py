import ipaddress
import re
import uuid
from datetime import datetime
from typing import Annotated

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


class IpamStatusOut(BaseModel):
    configured: bool  # CM_IPAM_MYSQL_URL set
    addresses: int
    integrated: int  # tied to one of our servers
    last_synced_at: datetime | None


class GuestRef(BaseModel):
    id: uuid.UUID
    name: str
    managed: bool


class AddressOut(BaseModel):
    id: uuid.UUID
    external_id: int
    address: str
    prefix: int | None
    status: str  # free|in_use|load_balancer|detached|stale|conflict|unverified
    assigned: bool
    hostname: str | None
    mac: str | None
    guest: GuestRef | None
    mac_mismatch: str | None


class UnregisteredOut(BaseModel):
    ip: str
    mac: str | None
    guest: GuestRef


class NetworkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cidr: str
    gateway: str
    vlan: Annotated[int, Field(ge=1, le=4094)] | None = None
    bridge: Annotated[str, Field(pattern=r"^[A-Za-z0-9._-]{1,32}$")] | None = None

    @model_validator(mode="after")
    def _gateway_inside(self) -> "NetworkIn":
        try:
            net = ipaddress.ip_network(self.cidr, strict=False)
            gw = ipaddress.ip_address(self.gateway)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        if gw not in net:
            raise ValueError("the gateway must be inside the network")
        self.cidr = str(net)
        return self


class NetworkOut(BaseModel):
    id: uuid.UUID | None  # None: a suggestion, not saved yet
    cidr: str
    gateway: str
    vlan: int | None
    bridge: str | None
    guests: int | None = None  # suggestions: how many guests use it


class IpamReportOut(BaseModel):
    nics_known: bool
    counts: dict[str, int]
    addresses: list[AddressOut]
    unregistered: list[UnregisteredOut]
    networks: list[NetworkOut]
    suggestions: list[NetworkOut]


# --- the registry itself (editing awf_ip_pool rows, ADR-0014) ------------------------------

Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
_MAC = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")


class AddressIn(BaseModel):
    """One row as the admin fills it. Blank optional fields are stored as NULL."""

    model_config = ConfigDict(extra="forbid")

    address: str  # "177.54.151.42" or "152.236.18.11/31" (the prefix is kept as typed)
    hypervisor: Short | None = None  # the host, as the registry names it
    node_name: Short | None = None  # pve_node_owner: ties the row to a server here
    assigned: bool = False
    mac: str | None = None
    hostname: Short | None = None
    host_owner: Short | None = None
    ip_block: Short | None = None
    load_balancer: bool = False  # dedicated to a load balancer: in use whatever `assigned` says

    @field_validator("address")
    @classmethod
    def _address(cls, value: str) -> str:
        text = value.strip()
        try:
            if "/" in text:
                iface = ipaddress.ip_interface(text)
                return f"{iface.ip}/{iface.network.prefixlen}"
            return str(ipaddress.ip_address(text))
        except ValueError as exc:
            raise ValueError("expected an IP address, optionally with /prefix") from exc

    @field_validator("mac")
    @classmethod
    def _mac(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        mac = value.strip().lower().replace("-", ":")
        if not _MAC.match(mac):
            raise ValueError("expected a MAC like bc:24:11:00:00:01")
        return mac

    @field_validator("hypervisor", "node_name", "hostname", "host_owner", "ip_block", mode="before")
    @classmethod
    def _blank_is_none(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value


class RegistryAddressOut(BaseModel):
    """A row of the registry as last copied, plus the instance of ours created with it."""

    id: uuid.UUID
    external_id: int
    address: str
    prefix: int | None
    hypervisor: str | None
    node_name: str | None
    cluster_id: uuid.UUID | None  # the server here whose node is node_name
    assigned: bool
    mac: str | None
    hostname: str | None
    host_owner: str | None
    ip_block: str | None
    load_balancer: bool
    held_by: GuestRef | None  # a live instance the platform created with this address
    synced_at: datetime
