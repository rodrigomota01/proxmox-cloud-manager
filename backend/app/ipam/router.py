"""/admin/ipam/* and /admin/clusters/{id}/ipam: addresses vs. guests, network profiles."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Response, status
from sqlalchemy import func, select

from app.api.deps import AppSettings, DbSession, Principal, require_platform
from app.compute.schemas import Accepted
from app.core.errors import Conflict, NotFound
from app.inventory.models import ProviderCluster
from app.ipam.models import IpamAddress, IpamNetwork
from app.ipam.report import Guest, report
from app.ipam.schemas import (
    AddressOut,
    GuestRef,
    IpamReportOut,
    IpamStatusOut,
    NetworkIn,
    NetworkOut,
    UnregisteredOut,
)
from app.ipam.service import source_for
from app.jobs.presenter import job_out
from app.jobs.queue import enqueue

router = APIRouter(prefix="/admin", tags=["admin"])
ClusterManager = Annotated[Principal, require_platform("cluster:manage")]


def _guest(g: Guest | None) -> GuestRef | None:
    return GuestRef(id=g.id, name=g.name, managed=g.managed) if g else None


@router.get("/ipam")
async def ipam_status(_: ClusterManager, db: DbSession, settings: AppSettings) -> IpamStatusOut:
    total, integrated, last = (
        await db.execute(
            select(
                func.count(), func.count(IpamAddress.cluster_id), func.max(IpamAddress.synced_at)
            )
        )
    ).one()
    return IpamStatusOut(
        configured=source_for(settings) is not None, addresses=total, integrated=integrated,
        last_synced_at=last,
    )


@router.post("/ipam/sync", status_code=status.HTTP_202_ACCEPTED)
async def ipam_sync(principal: ClusterManager, db: DbSession, response: Response) -> Accepted:
    job = await enqueue(db, "ipam.sync", tenant_id=None, requested_by=principal.user_id)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/admin/jobs/{job.id}"
    return Accepted(job=await job_out(db, job))


@router.get("/clusters/{cluster_id}/ipam")
async def cluster_ipam(cluster_id: uuid.UUID, _: ClusterManager, db: DbSession) -> IpamReportOut:
    if await db.get(ProviderCluster, cluster_id) is None:
        raise NotFound()
    r = await report(db, cluster_id)
    counts: dict[str, int] = {}
    for a in r.addresses:
        counts[a.status] = counts.get(a.status, 0) + 1
    networks = (
        await db.execute(select(IpamNetwork).where(IpamNetwork.cluster_id == cluster_id))
    ).scalars().all()
    return IpamReportOut(
        nics_known=r.nics_known, counts=counts,
        addresses=[
            AddressOut(
                id=a.address.id, external_id=a.address.external_id, address=str(a.address.address),
                prefix=a.address.prefix, status=a.status, assigned=a.address.assigned,
                hostname=a.address.hostname, mac=a.address.mac, guest=_guest(a.guest),
                mac_mismatch=a.mac_mismatch,
            )
            for a in r.addresses
        ],
        unregistered=[
            UnregisteredOut(ip=u.ip, mac=u.mac, guest=GuestRef(
                id=u.guest.id, name=u.guest.name, managed=u.guest.managed))
            for u in r.unregistered
        ],
        networks=[
            NetworkOut(id=n.id, cidr=str(n.cidr), gateway=str(n.gateway), vlan=n.vlan,
                       bridge=n.bridge)
            for n in networks
        ],
        suggestions=[
            NetworkOut(id=None, cidr=s.cidr, gateway=s.gateway, vlan=s.vlan, bridge=s.bridge,
                       guests=s.guests)
            for s in r.suggestions
        ],
    )


@router.post("/clusters/{cluster_id}/ipam/networks", status_code=status.HTTP_201_CREATED)
async def add_network(
    cluster_id: uuid.UUID, body: NetworkIn, _: ClusterManager, db: DbSession
) -> NetworkOut:
    if await db.get(ProviderCluster, cluster_id) is None:
        raise NotFound()
    exists = await db.scalar(
        select(IpamNetwork.id).where(IpamNetwork.cluster_id == cluster_id,
                                     IpamNetwork.cidr == body.cidr)
    )
    if exists:
        raise Conflict("this network is already configured for the server")
    net = IpamNetwork(cluster_id=cluster_id, **body.model_dump())
    db.add(net)
    await db.flush()
    return NetworkOut(id=net.id, cidr=str(net.cidr), gateway=str(net.gateway), vlan=net.vlan,
                      bridge=net.bridge)


@router.delete("/ipam/networks/{network_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_network(network_id: uuid.UUID, _: ClusterManager, db: DbSession) -> None:
    net = await db.get(IpamNetwork, network_id)
    if net is None:
        raise NotFound()
    await db.delete(net)
