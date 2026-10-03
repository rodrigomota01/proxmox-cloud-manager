import ipaddress
import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    status: str  # free|in_use|detached|stale|conflict|unverified
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
