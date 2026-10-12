"""The IPv4 shown for a guest, taken from the most trustworthy source that has one.

1. platform -> what the platform configured when it created the instance
2. agent    -> what the guest itself reports (QEMU guest agent; needs the token to read
               the agent, see deploy/proxmox/setup-node.sh)
3. config   -> static IP in the provider config (cloud-init ipconfigN / container netN)
4. ipam     -> the IPAM row whose MAC is one of the guest's NICs

Agent addresses count only on the guest's own NICs (MAC in its config): bridges and
tunnels inside the guest (docker0, cni0...) are not how anyone reaches it.
"""

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.compute.models import Instance
from app.ipam.models import IpamAddress


@dataclass(frozen=True)
class ObservedIp:
    address: str  # with prefix when known: 10.0.0.5/24
    gateway: str | None
    source: str  # platform|agent|config|ipam


def _macs(i: Instance) -> list[str]:
    return [n["mac"] for n in i.nics or [] if n.get("mac")]


async def ipam_by_mac(db: AsyncSession, instances: Iterable[Instance]) -> dict[str, str]:
    """IPAM address per MAC, for the NICs of these instances (one query)."""
    macs = {m for i in instances for m in _macs(i)}
    if not macs:
        return {}
    rows = await db.execute(
        select(IpamAddress.mac, IpamAddress.address, IpamAddress.prefix)
        .where(IpamAddress.mac.in_(macs))
    )
    return {mac: f"{addr}/{prefix}" if prefix else str(addr) for mac, addr, prefix in rows}


def primary_ipv4(i: Instance, ipam: dict[str, str]) -> ObservedIp | None:
    if address := i.network.get("address"):
        return ObservedIp(address, i.network.get("gateway"), "platform")
    macs = _macs(i)
    gateways = {n["mac"]: n.get("gateway") for n in i.nics or [] if n.get("mac")}
    for a in i.guest_addresses or []:
        if not macs or a.get("mac") in macs:
            return ObservedIp(a["address"], gateways.get(a.get("mac")), "agent")
    for n in i.nics or []:
        if n.get("ip"):
            return ObservedIp(n["ip"], n.get("gateway"), "config")
    for mac in macs:
        if mac in ipam:
            return ObservedIp(ipam[mac], gateways.get(mac), "ipam")
    return None
