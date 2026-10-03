"""What the IPAM says vs. what the guests actually use, for one server.

Per address of the server (awf_ip_pool row tied to it):

    free        not assigned, no guest uses it
    in_use      assigned, and a guest uses it (by cloud-init IP or by NIC MAC)
    detached    assigned to a guest that exists here (same name) but does not have the
                IP configured: often a public IP NATed by a load balancer/router to a
                guest on a private network. Check before freeing.
    stale       assigned, no guest uses it and none has the registered name (forgotten?)
    conflict    NOT assigned, yet a guest uses it (the next allocation would clash)
    unverified  assigned, but the guests' NICs were not read yet

Plus `unregistered`: public IPs configured on guests of this server that the IPAM does
not know at all. IP evidence wins over MAC; a MAC that differs from the registered one
is reported (mac_mismatch) but does not change the status.
"""

import ipaddress
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.compute.models import Instance
from app.ipam.models import IpamAddress, IpamNetwork


@dataclass
class Guest:
    id: uuid.UUID
    name: str
    managed: bool
    tenant_id: uuid.UUID | None


@dataclass
class AddressStatus:
    address: IpamAddress
    status: str
    guest: Guest | None = None
    mac_mismatch: str | None = None  # the guest's MAC when it differs from the IPAM's


@dataclass
class Unregistered:
    ip: str
    guest: Guest
    mac: str | None


@dataclass
class Suggestion:
    cidr: str
    gateway: str
    vlan: int | None
    bridge: str | None
    guests: int


@dataclass
class Report:
    addresses: list[AddressStatus] = field(default_factory=list)
    unregistered: list[Unregistered] = field(default_factory=list)
    suggestions: list[Suggestion] = field(default_factory=list)
    nics_known: bool = False


def _host(ip: str) -> str:
    return ip.split("/", 1)[0]


async def report(db: AsyncSession, cluster_id: uuid.UUID) -> Report:
    guests = (
        await db.execute(
            select(Instance).where(Instance.cluster_id == cluster_id, Instance.deleted_at.is_(None))
        )
    ).scalars().all()
    addresses = (
        await db.execute(
            select(IpamAddress).where(IpamAddress.cluster_id == cluster_id)
            .order_by(IpamAddress.address)
        )
    ).scalars().all()
    networks = (
        await db.execute(select(IpamNetwork.cidr).where(IpamNetwork.cluster_id == cluster_id))
    ).scalars().all()
    out = Report(nics_known=any(g.nics is not None for g in guests))

    by_ip: dict[str, tuple[Guest, str | None]] = {}
    by_mac: dict[str, Guest] = {}
    by_name = {g.name: Guest(g.id, g.name, g.managed, g.tenant_id) for g in guests}
    nets: dict[tuple[str, str, int | None, str | None], int] = {}
    for g in guests:
        guest = Guest(g.id, g.name, g.managed, g.tenant_id)
        for nic in g.nics or []:
            if nic.get("mac"):
                by_mac[nic["mac"]] = guest
            if nic.get("ip"):
                by_ip[_host(nic["ip"])] = (guest, nic.get("mac"))
                try:
                    iface = ipaddress.ip_interface(nic["ip"])
                except ValueError:
                    continue
                if nic.get("gateway") and iface.network.prefixlen < 31:
                    key = (str(iface.network), nic["gateway"], nic.get("vlan"), nic.get("bridge"))
                    nets[key] = nets.get(key, 0) + 1

    known = {str(a.address) for a in addresses}
    for a in addresses:
        ip = str(a.address)
        hit = by_ip.get(ip)
        guest, guest_mac = hit if hit else (by_mac.get(a.mac) if a.mac else None, a.mac)
        if guest is not None:
            status = "in_use" if a.assigned else "conflict"
        elif a.assigned and not out.nics_known:
            status = "unverified"
        elif a.assigned and a.hostname in by_name:
            status, guest = "detached", by_name[a.hostname]
        elif a.assigned:
            status = "stale"
        else:
            status = "free"
        mismatch = guest_mac if hit and a.mac and guest_mac and guest_mac != a.mac else None
        out.addresses.append(AddressStatus(a, status, guest, mismatch))

    for ip, (guest, mac) in sorted(by_ip.items()):
        try:
            public = ipaddress.ip_address(ip).is_global
        except ValueError:
            continue
        if public and ip not in known and not await _known_elsewhere(db, ip):
            out.unregistered.append(Unregistered(ip, guest, mac))

    covered = {str(c) for c in networks}
    for (cidr, gateway, vlan, bridge), count in sorted(nets.items(), key=lambda kv: -kv[1]):
        net = ipaddress.ip_network(cidr)
        if cidr in covered or not any(ipaddress.ip_address(k) in net for k in known):
            continue
        out.suggestions.append(Suggestion(cidr, gateway, vlan, bridge, count))
    return out


async def _known_elsewhere(db: AsyncSession, ip: str) -> bool:
    """Registered under another server (or none): not 'unregistered', just misplaced."""
    return await db.scalar(select(IpamAddress.id).where(IpamAddress.address == ip)) is not None
