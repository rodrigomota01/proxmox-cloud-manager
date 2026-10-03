"""Which IPAM addresses can be offered to a new instance, and how to configure them.

An address is offered when the IPAM says it is free, no guest here uses it (by IP or
MAC: see report.py), no live instance of ours already holds it, and we know how to
configure it: /31 entries carry their own gateway (the other address of the /31);
anything else needs a network profile of its server that contains it.
"""

import ipaddress
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.compute.models import Instance
from app.ipam.models import IpamAddress, IpamNetwork
from app.ipam.report import report


@dataclass(frozen=True)
class Offer:
    address: IpamAddress
    cidr: str  # "177.54.151.133/24"
    gateway: str
    vlan: int | None
    bridge: str | None

    def network(self, dns: list[str]) -> dict[str, Any]:
        """What Instance.network stores; `ipam` lets the jobs reserve and release it."""
        a = self.address
        return {
            "address": self.cidr, "gateway": self.gateway, "dns": dns,
            "vlan": self.vlan, "bridge": self.bridge, "mac": a.mac,
            "ipam": {"external_id": a.external_id, "mac_preassigned": a.mac is not None},
        }


def configure(address: IpamAddress, networks: list[IpamNetwork]) -> Offer | None:
    ip = ipaddress.ip_address(str(address.address))
    if address.prefix == 31:
        pair = list(ipaddress.ip_network(f"{ip}/31", strict=False))
        gateway = pair[0] if ip == pair[1] else pair[1]
        return Offer(address, f"{ip}/31", str(gateway), None, None)
    for net in networks:
        network = ipaddress.ip_network(str(net.cidr))
        if ip in network and ip not in (network.network_address, network.broadcast_address):
            if address.prefix is not None and address.prefix != network.prefixlen:
                continue  # the IPAM says otherwise: do not guess
            return Offer(address, f"{ip}/{network.prefixlen}", str(net.gateway), net.vlan,
                         net.bridge)
    return None


async def offers(db: AsyncSession, cluster_id: uuid.UUID) -> list[Offer]:
    networks = list(
        (await db.execute(select(IpamNetwork).where(IpamNetwork.cluster_id == cluster_id)))
        .scalars()
    )
    held = {
        str(ip) for ip in (
            await db.execute(
                select(Instance.ipv4).where(
                    Instance.cluster_id == cluster_id, Instance.deleted_at.is_(None),
                    Instance.ipv4.is_not(None),
                )
            )
        ).scalars()
    }
    out = []
    for status in (await report(db, cluster_id)).addresses:
        if status.status != "free" or str(status.address.address) in held:
            continue
        offer = configure(status.address, networks)
        if offer is not None:
            out.append(offer)
    return out
