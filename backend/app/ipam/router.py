"""/admin/ipam/* and /admin/clusters/{id}/ipam: addresses vs. guests, network profiles,
and the registry editor (rows of awf_ip_pool, written by the worker through jobs)."""

import uuid
from collections.abc import Iterable
from typing import Annotated, Any

from fastapi import APIRouter, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AppSettings, DbSession, Principal, require_platform
from app.audit import service as audit
from app.compute.models import Instance
from app.compute.schemas import Accepted
from app.core.errors import Conflict, NotFound
from app.inventory.models import ProviderCluster
from app.ipam.models import IpamAddress, IpamNetwork
from app.ipam.report import Guest, report
from app.ipam.schemas import (
    AddressIn,
    AddressOut,
    GuestRef,
    IpamReportOut,
    IpamStatusOut,
    NetworkIn,
    NetworkOut,
    RegistryAddressOut,
    UnregisteredOut,
)
from app.ipam.service import source_for
from app.ipam.sync import parse_address
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


# --- the registry editor -------------------------------------------------------------------
# MySQL stays the source of truth and only the worker reaches it: each change is a job.
# The API refuses what would break a running instance of ours (an address it was created
# with cannot be freed, moved or removed while the instance lives).


async def _held_by(db: AsyncSession, external_ids: Iterable[int]) -> dict[int, Guest]:
    """Live instances created with these registry rows (Instance.network.ipam)."""
    ids = list(external_ids)
    if not ids:
        return {}
    rows = await db.execute(
        select(Instance).where(
            Instance.deleted_at.is_(None),
            Instance.network["ipam"]["external_id"].as_integer().in_(ids),
        )
    )
    return {
        int(i.network["ipam"]["external_id"]): Guest(i.id, i.name, i.managed, i.tenant_id)
        for i in rows.scalars()
    }


def _registry_out(a: IpamAddress, held: dict[int, Guest]) -> RegistryAddressOut:
    return RegistryAddressOut(
        id=a.id, external_id=a.external_id, address=str(a.address), prefix=a.prefix,
        hypervisor=a.hypervisor, node_name=a.node_name, cluster_id=a.cluster_id,
        assigned=a.assigned, mac=a.mac, hostname=a.hostname, host_owner=a.host_owner,
        ip_block=a.ip_block, load_balancer=a.load_balancer,
        held_by=_guest(held.get(a.external_id)), synced_at=a.synced_at,
    )


@router.get("/ipam/addresses")
async def list_registry(_: ClusterManager, db: DbSession) -> list[RegistryAddressOut]:
    """Every row of the registry (the screen groups them by hypervisor)."""
    addresses = (
        await db.execute(
            select(IpamAddress).order_by(IpamAddress.hypervisor, IpamAddress.address)
        )
    ).scalars().all()
    held = await _held_by(db, (a.external_id for a in addresses))
    return [_registry_out(a, held) for a in addresses]


def _require_source(settings: Any) -> None:
    if source_for(settings) is None:
        raise Conflict("the IP registry (CM_IPAM_MYSQL_URL) is not configured")


async def _check_duplicate(db: AsyncSession, body: AddressIn, *, except_id: int | None) -> None:
    parsed = parse_address(body.address)
    if parsed is None:  # the schema already refused anything unparsable
        raise Conflict("invalid address")
    other = await db.scalar(
        select(IpamAddress.external_id).where(
            IpamAddress.address == parsed[0], IpamAddress.external_id != (except_id or -1)
        )
    )
    if other is not None:
        raise Conflict(f"{parsed[0]} is already registered (row {other})")


async def _accepted(
    db: AsyncSession, response: Response, principal: Principal, job_type: str,
    payload: dict[str, Any], resource_id: uuid.UUID | None,
) -> Accepted:
    job = await enqueue(
        db, job_type, tenant_id=None, requested_by=principal.user_id,
        resource_type="ipam_address", resource_id=resource_id, payload=payload,
    )
    await audit.record(
        db, job_type, actor_user_id=principal.user_id, resource_type="ipam_address",
        resource_id=resource_id, details={k: v for k, v in payload.items() if v is not None},
    )
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/admin/jobs/{job.id}"
    return Accepted(job=await job_out(db, job))


@router.post("/ipam/addresses", status_code=status.HTTP_202_ACCEPTED)
async def create_registry_address(
    body: AddressIn, principal: ClusterManager, db: DbSession, settings: AppSettings,
    response: Response,
) -> Accepted:
    _require_source(settings)
    await _check_duplicate(db, body, except_id=None)
    return await _accepted(
        db, response, principal, "ipam.address.create", body.model_dump(), None
    )


@router.patch("/ipam/addresses/{address_id}", status_code=status.HTTP_202_ACCEPTED)
async def update_registry_address(
    address_id: uuid.UUID, body: AddressIn, principal: ClusterManager, db: DbSession,
    settings: AppSettings, response: Response,
) -> Accepted:
    _require_source(settings)
    row = await db.get(IpamAddress, address_id)
    if row is None:
        raise NotFound()
    await _check_duplicate(db, body, except_id=row.external_id)
    holder = (await _held_by(db, [row.external_id])).get(row.external_id)
    if holder is not None:
        same_ip = parse_address(body.address) == (str(row.address), row.prefix)
        if not body.assigned or not same_ip or body.hostname != row.hostname:
            raise Conflict(
                f"{row.address} belongs to the instance {holder.name}: it can only be freed "
                "or changed by deleting the instance"
            )
    payload = {**body.model_dump(), "external_id": row.external_id}
    return await _accepted(db, response, principal, "ipam.address.update", payload, row.id)


@router.delete("/ipam/addresses/{address_id}", status_code=status.HTTP_202_ACCEPTED)
async def delete_registry_address(
    address_id: uuid.UUID, principal: ClusterManager, db: DbSession, settings: AppSettings,
    response: Response,
) -> Accepted:
    _require_source(settings)
    row = await db.get(IpamAddress, address_id)
    if row is None:
        raise NotFound()
    holder = (await _held_by(db, [row.external_id])).get(row.external_id)
    if holder is not None:
        raise Conflict(f"{row.address} belongs to the instance {holder.name}: delete it first")
    payload = {"external_id": row.external_id, "address": str(row.address)}
    return await _accepted(db, response, principal, "ipam.address.delete", payload, row.id)
