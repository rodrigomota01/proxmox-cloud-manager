"""Regions and zones (ADR-0012).

/api/v1/regions               any member: active regions with their *usable* zones
/api/v1/admin/regions         platform admins: full catalog, create/edit regions and zones
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentPrincipal, DbSession, Principal, require_platform
from app.audit import service as audit
from app.core.errors import Conflict, NotFound
from app.inventory.models import ProviderCluster
from app.regions.models import Region, Zone

router = APIRouter()

Slug = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$")
]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Country = Annotated[
    str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Za-z]{2}$")
]
Description = Annotated[str, Field(max_length=500)]
RegionAdmin = Annotated[Principal, require_platform("cluster:manage")]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegionCreate(Input):
    slug: Slug
    name: Name
    country_code: Country
    description: Description = ""


class RegionUpdate(Input):
    name: Name | None = None
    country_code: Country | None = None
    description: Description | None = None
    active: bool | None = None


class ZoneCreate(Input):
    slug: Slug
    name: Name
    description: Description = ""


class ZoneUpdate(Input):
    name: Name | None = None
    description: Description | None = None
    active: bool | None = None


class ZoneOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    description: str


class RegionOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    country_code: str
    description: str
    zones: list[ZoneOut]


class AdminZoneOut(ZoneOut):
    region_id: uuid.UUID
    active: bool
    clusters: list[str]  # names of the servers in this zone
    usable: bool  # active, with at least one server ready for new instances


class AdminRegionOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    country_code: str
    description: str
    active: bool
    zones: list[AdminZoneOut]


async def _ready_clusters(db: DbSession) -> dict[uuid.UUID, list[ProviderCluster]]:
    rows = (await db.execute(select(ProviderCluster).where(ProviderCluster.zone_id.is_not(None))))
    out: dict[uuid.UUID, list[ProviderCluster]] = {}
    for c in rows.scalars():
        out.setdefault(c.zone_id, []).append(c)  # type: ignore[arg-type]
    return out


def _usable(zone: Zone, clusters: list[ProviderCluster]) -> bool:
    return zone.active and any(c.settings.get("pool") for c in clusters)


async def _catalog(db: DbSession) -> tuple[list[Region], list[Zone], dict]:
    regions = list((await db.execute(select(Region).order_by(Region.name))).scalars())
    zones = list((await db.execute(select(Zone).order_by(Zone.name))).scalars())
    return regions, zones, await _ready_clusters(db)


# --- tenant ----------------------------------------------------------------------------


@router.get("/regions", tags=["regions"])
async def list_regions(_: CurrentPrincipal, db: DbSession) -> list[RegionOut]:
    """Only what can receive instances: active regions with usable zones."""
    regions, zones, clusters = await _catalog(db)
    out = []
    for r in regions:
        usable = [
            ZoneOut(id=z.id, slug=z.slug, name=z.name, description=z.description)
            for z in zones
            if z.region_id == r.id and _usable(z, clusters.get(z.id, []))
        ]
        if r.active and usable:
            out.append(RegionOut(
                id=r.id, slug=r.slug, name=r.name, country_code=r.country_code,
                description=r.description, zones=usable,
            ))
    return out


# --- admin -----------------------------------------------------------------------------


def _admin_out(r: Region, zones: list[Zone], clusters: dict) -> AdminRegionOut:
    return AdminRegionOut(
        id=r.id, slug=r.slug, name=r.name, country_code=r.country_code,
        description=r.description, active=r.active,
        zones=[
            AdminZoneOut(
                id=z.id, region_id=z.region_id, slug=z.slug, name=z.name,
                description=z.description, active=z.active,
                clusters=sorted(c.name for c in clusters.get(z.id, [])),
                usable=_usable(z, clusters.get(z.id, [])),
            )
            for z in zones
            if z.region_id == r.id
        ],
    )


@router.get("/admin/regions", tags=["admin"])
async def admin_list_regions(_: RegionAdmin, db: DbSession) -> list[AdminRegionOut]:
    regions, zones, clusters = await _catalog(db)
    return [_admin_out(r, zones, clusters) for r in regions]


async def _admin_one(db: DbSession, region_id: uuid.UUID) -> AdminRegionOut:
    regions, zones, clusters = await _catalog(db)
    region = next((r for r in regions if r.id == region_id), None)
    if region is None:
        raise NotFound()
    return _admin_out(region, zones, clusters)


async def _save(db: DbSession, obj: object, what: str) -> None:
    try:
        async with db.begin_nested():
            db.add(obj)
            await db.flush()
    except IntegrityError as exc:
        raise Conflict(f"A {what} with this slug already exists") from exc


@router.post("/admin/regions", status_code=status.HTTP_201_CREATED, tags=["admin"])
async def create_region(
    body: RegionCreate, principal: RegionAdmin, db: DbSession
) -> AdminRegionOut:
    region = Region(**body.model_dump())
    await _save(db, region, "region")
    await audit.record(
        db, "REGION_CREATE", actor_user_id=principal.user_id, resource_type="region",
        resource_id=region.id, details={"slug": region.slug},
    )
    return await _admin_one(db, region.id)


@router.patch("/admin/regions/{region_id}", tags=["admin"])
async def update_region(
    region_id: uuid.UUID, body: RegionUpdate, principal: RegionAdmin, db: DbSession
) -> AdminRegionOut:
    region = await db.get(Region, region_id)
    if region is None:
        raise NotFound()
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(region, field, value)
    await audit.record(
        db, "REGION_UPDATE", actor_user_id=principal.user_id, resource_type="region",
        resource_id=region.id, details={"fields": sorted(changes)},
    )
    return await _admin_one(db, region.id)


@router.post(
    "/admin/regions/{region_id}/zones", status_code=status.HTTP_201_CREATED, tags=["admin"]
)
async def create_zone(
    region_id: uuid.UUID, body: ZoneCreate, principal: RegionAdmin, db: DbSession
) -> AdminRegionOut:
    if await db.get(Region, region_id) is None:
        raise NotFound()
    zone = Zone(region_id=region_id, **body.model_dump())
    await _save(db, zone, "zone")
    await audit.record(
        db, "ZONE_CREATE", actor_user_id=principal.user_id, resource_type="zone",
        resource_id=zone.id, details={"slug": zone.slug, "region_id": str(region_id)},
    )
    return await _admin_one(db, region_id)


@router.patch("/admin/zones/{zone_id}", tags=["admin"])
async def update_zone(
    zone_id: uuid.UUID, body: ZoneUpdate, principal: RegionAdmin, db: DbSession
) -> AdminRegionOut:
    zone = await db.get(Zone, zone_id)
    if zone is None:
        raise NotFound()
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(zone, field, value)
    await audit.record(
        db, "ZONE_UPDATE", actor_user_id=principal.user_id, resource_type="zone",
        resource_id=zone.id, details={"fields": sorted(changes)},
    )
    return await _admin_one(db, zone.region_id)
