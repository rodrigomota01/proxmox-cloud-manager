"""Image catalog (ADR-0012): logical images with one template per server.

/api/v1/images                           tenant: public + own, active, with the zones
                                         where each one can run (?zone_id= filters)
/api/v1/admin/clusters/{id}/templates    templates the cluster token can see (live)
/api/v1/admin/images                     create (from a first template) / list / update
/api/v1/admin/images/{id}/templates      add/remove the image's template on a server
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentTenant, DbSession, Principal, require_platform
from app.audit import service as audit
from app.core.errors import Conflict, NotFound, ValidationError
from app.images.models import Image, ImageTemplate
from app.inventory.models import ProviderCluster
from app.providers.base import ProviderError, TemplateDetails
from app.providers.registry import ProviderRegistry
from app.regions.models import Zone
from app.tenancy.models import Tenant

router = APIRouter()

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
# the Linux user cloud-init creates (and that receives the SSH keys)
User = Annotated[str, StringConstraints(pattern=r"^[a-z_][a-z0-9_-]{0,31}$")]
ImageAdmin = Annotated[Principal, require_platform("template:publish")]


def get_registry(request: Request) -> ProviderRegistry:
    return request.app.state.providers


Registry = Annotated[ProviderRegistry, Depends(get_registry)]


class ImageOut(BaseModel):
    """Tenant view: no servers, templates or provider identifiers."""

    id: uuid.UUID
    name: str
    description: str
    os_family: str
    default_user: str
    min_disk_gb: int
    visibility: str
    zone_ids: list[uuid.UUID]  # zones where it can run now


class TemplateRefOut(BaseModel):
    id: uuid.UUID
    cluster_id: uuid.UUID
    cluster_name: str
    zone_name: str | None
    template_vmid: int
    disk_gb: int


class AdminImageOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    os_family: str
    default_user: str
    min_disk_gb: int
    visibility: str
    tenant_id: uuid.UUID | None
    active: bool
    created_at: datetime
    templates: list[TemplateRefOut]


class TemplateOut(BaseModel):
    vmid: int
    name: str
    node: str
    disk_gb: int
    image_id: uuid.UUID | None  # already registered for this image


class TemplateAdd(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cluster_id: uuid.UUID
    template_vmid: Annotated[int, Field(ge=100)]


class ImageCreate(TemplateAdd):
    name: Name
    description: Annotated[str, Field(max_length=1000)] = ""
    os_family: Literal["linux", "windows"] = "linux"
    default_user: User = "debian"
    visibility: Literal["public", "tenant"] = "public"
    tenant_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _owner(self) -> "ImageCreate":
        if (self.visibility == "tenant") != (self.tenant_id is not None):
            raise ValueError("tenant_id is required exactly when visibility is 'tenant'")
        return self


class ImageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    description: Annotated[str | None, Field(max_length=1000)] = None
    default_user: User | None = None
    active: bool | None = None


# --- helpers ---------------------------------------------------------------------------


async def zones_by_image(db: AsyncSession, image_ids: list[uuid.UUID]) -> dict[uuid.UUID, set]:
    """Zones where each image can run: it has a template on a server of the zone that is
    ready for new instances (target pool set) and the zone is active."""
    if not image_ids:
        return {}
    rows = await db.execute(
        select(ImageTemplate.image_id, ProviderCluster.zone_id, ProviderCluster.settings)
        .join(ProviderCluster, ProviderCluster.id == ImageTemplate.cluster_id)
        .join(Zone, Zone.id == ProviderCluster.zone_id)
        .where(ImageTemplate.image_id.in_(image_ids), Zone.active)
    )
    out: dict[uuid.UUID, set] = {}
    for image_id, zone_id, settings in rows:
        if settings.get("pool"):
            out.setdefault(image_id, set()).add(zone_id)
    return out


async def admin_out(db: AsyncSession, images: list[Image]) -> list[AdminImageOut]:
    ids = [i.id for i in images]
    rows = (
        await db.execute(
            select(ImageTemplate, ProviderCluster.name, Zone.name)
            .join(ProviderCluster, ProviderCluster.id == ImageTemplate.cluster_id)
            .outerjoin(Zone, Zone.id == ProviderCluster.zone_id)
            .where(ImageTemplate.image_id.in_(ids))
            .order_by(ProviderCluster.name)
        )
    ).all() if ids else []
    templates: dict[uuid.UUID, list[TemplateRefOut]] = {}
    for t, cluster_name, zone_name in rows:
        templates.setdefault(t.image_id, []).append(TemplateRefOut(
            id=t.id, cluster_id=t.cluster_id, cluster_name=cluster_name, zone_name=zone_name,
            template_vmid=int(t.provider_ref["vmid"]), disk_gb=t.disk_gb,
        ))
    return [
        AdminImageOut(
            id=i.id, name=i.name, description=i.description, os_family=i.os_family,
            default_user=i.default_user, min_disk_gb=i.min_disk_gb, visibility=i.visibility,
            tenant_id=i.tenant_id, active=i.active, created_at=i.created_at,
            templates=templates.get(i.id, []),
        )
        for i in images
    ]


async def describe(
    db: AsyncSession, registry: ProviderRegistry, cluster_id: uuid.UUID, vmid: int
) -> tuple[ProviderCluster, TemplateDetails]:
    """Reads a template from its server; refuses it without a cloud-init drive."""
    cluster = await db.get(ProviderCluster, cluster_id)
    if cluster is None:
        raise ValidationError(errors=[{"field": "cluster_id", "message": "unknown cluster"}])
    try:
        async with registry.open(db, cluster) as provider:
            found = next(
                (t for t in (await provider.inventory()).templates
                 if int(t.ref.data["vmid"]) == vmid),
                None,
            )
            if found is None:
                raise ValidationError(
                    "Template not found or not visible to the cluster token",
                    errors=[{"field": "template_vmid", "message": "not found"}],
                )
            details = await provider.describe_template(found.ref)
    except ProviderError as exc:
        raise Conflict(f"Cannot read the template: {exc}") from exc
    if not details.has_cloudinit:
        raise ValidationError(
            "The template has no cloud-init drive: keys and IP could not be injected",
            errors=[{"field": "template_vmid", "message": "cloud-init drive required"}],
        )
    return cluster, details


async def _add_template(
    db: AsyncSession, image: Image, cluster: ProviderCluster, details: TemplateDetails
) -> None:
    try:
        async with db.begin_nested():
            db.add(ImageTemplate(
                image_id=image.id, cluster_id=cluster.id, provider_ref=details.ref.data,
                disk_gb=details.disk_gb,
            ))
            await db.flush()
    except IntegrityError as exc:
        raise Conflict(
            "This server already has a template for the image, or the template backs "
            "another image"
        ) from exc
    await _refresh_min_disk(db, image)


async def _refresh_min_disk(db: AsyncSession, image: Image) -> None:
    # a new instance must fit the largest template of the image (any zone may be picked)
    largest = await db.scalar(
        select(func.max(ImageTemplate.disk_gb)).where(ImageTemplate.image_id == image.id)
    )
    image.min_disk_gb = int(largest or image.min_disk_gb or 1)


# --- tenant ----------------------------------------------------------------------------


@router.get("/images", tags=["images"])
async def list_images(
    ctx: CurrentTenant, db: DbSession, zone_id: uuid.UUID | None = None
) -> list[ImageOut]:
    # RLS: public images + this tenant's; active only
    images = list((await db.execute(
        select(Image)
        .where(Image.active, (Image.tenant_id.is_(None)) | (Image.tenant_id == ctx.tenant_id))
        .order_by(Image.name)
    )).scalars())
    zones = await zones_by_image(db, [i.id for i in images])
    out = [
        ImageOut(
            id=i.id, name=i.name, description=i.description, os_family=i.os_family,
            default_user=i.default_user, min_disk_gb=i.min_disk_gb, visibility=i.visibility,
            zone_ids=sorted(zones.get(i.id, set()), key=str),
        )
        for i in images
    ]
    return [i for i in out if zone_id in i.zone_ids] if zone_id else out


# --- admin -----------------------------------------------------------------------------


@router.get("/admin/clusters/{cluster_id}/templates", tags=["admin"])
async def list_templates(
    cluster_id: uuid.UUID, _: ImageAdmin, db: DbSession, registry: Registry
) -> list[TemplateOut]:
    cluster = await db.get(ProviderCluster, cluster_id)
    if cluster is None:
        raise NotFound()
    try:
        async with registry.open(db, cluster) as provider:
            templates = (await provider.inventory()).templates
    except ProviderError as exc:
        raise Conflict(f"Cannot list templates: {exc}") from exc
    registered = {
        str(t.provider_ref["vmid"]): t.image_id
        for t in (
            await db.execute(select(ImageTemplate).where(ImageTemplate.cluster_id == cluster.id))
        ).scalars()
    }
    return [
        TemplateOut(
            vmid=int(t.ref.data["vmid"]), name=t.name, node=t.node, disk_gb=t.disk_gb,
            image_id=registered.get(t.ref.key),
        )
        for t in sorted(templates, key=lambda t: int(t.ref.data["vmid"]))
    ]


@router.get("/admin/images", tags=["admin"])
async def admin_list_images(_: ImageAdmin, db: DbSession) -> list[AdminImageOut]:
    images = list((await db.execute(select(Image).order_by(Image.name))).scalars())
    return await admin_out(db, images)


@router.post("/admin/images", status_code=status.HTTP_201_CREATED, tags=["admin"])
async def create_image(
    body: ImageCreate, principal: ImageAdmin, db: DbSession, registry: Registry
) -> AdminImageOut:
    if body.tenant_id and await db.get(Tenant, body.tenant_id) is None:
        raise ValidationError(errors=[{"field": "tenant_id", "message": "unknown tenant"}])
    cluster, details = await describe(db, registry, body.cluster_id, body.template_vmid)
    image = Image(
        name=body.name, description=body.description, os_family=body.os_family,
        default_user=body.default_user, min_disk_gb=details.disk_gb,
        visibility=body.visibility, tenant_id=body.tenant_id,
    )
    db.add(image)
    await db.flush()
    await _add_template(db, image, cluster, details)
    await audit.record(
        db, "IMAGE_CREATE", actor_user_id=principal.user_id, tenant_id=body.tenant_id,
        resource_type="image", resource_id=image.id,
        details={"name": image.name, "cluster": cluster.name,
                 "template_vmid": body.template_vmid},
    )
    await db.refresh(image)
    return (await admin_out(db, [image]))[0]


@router.post(
    "/admin/images/{image_id}/templates", status_code=status.HTTP_201_CREATED, tags=["admin"]
)
async def add_template(
    image_id: uuid.UUID, body: TemplateAdd, principal: ImageAdmin, db: DbSession,
    registry: Registry,
) -> AdminImageOut:
    image = await db.get(Image, image_id)
    if image is None:
        raise NotFound()
    cluster, details = await describe(db, registry, body.cluster_id, body.template_vmid)
    await _add_template(db, image, cluster, details)
    await audit.record(
        db, "IMAGE_TEMPLATE_ADD", actor_user_id=principal.user_id, tenant_id=image.tenant_id,
        resource_type="image", resource_id=image.id,
        details={"cluster": cluster.name, "template_vmid": body.template_vmid},
    )
    await db.refresh(image)
    return (await admin_out(db, [image]))[0]


@router.delete("/admin/images/{image_id}/templates/{template_id}", tags=["admin"])
async def remove_template(
    image_id: uuid.UUID, template_id: uuid.UUID, principal: ImageAdmin, db: DbSession
) -> AdminImageOut:
    image = await db.get(Image, image_id)
    if image is None:
        raise NotFound()
    removed = await db.execute(
        delete(ImageTemplate).where(
            ImageTemplate.id == template_id, ImageTemplate.image_id == image_id
        )
    )
    if not removed.rowcount:
        raise NotFound()
    await _refresh_min_disk(db, image)
    await audit.record(
        db, "IMAGE_TEMPLATE_REMOVE", actor_user_id=principal.user_id,
        tenant_id=image.tenant_id, resource_type="image", resource_id=image.id,
        details={"template_id": str(template_id)},
    )
    await db.refresh(image)
    return (await admin_out(db, [image]))[0]


@router.patch("/admin/images/{image_id}", tags=["admin"])
async def update_image(
    image_id: uuid.UUID, body: ImageUpdate, principal: ImageAdmin, db: DbSession
) -> AdminImageOut:
    image = await db.get(Image, image_id)
    if image is None:
        raise NotFound()
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(image, field, value)
    await audit.record(
        db, "IMAGE_UPDATE", actor_user_id=principal.user_id, tenant_id=image.tenant_id,
        resource_type="image", resource_id=image.id, details={"fields": sorted(changes)},
    )
    await db.flush()
    await db.refresh(image)
    return (await admin_out(db, [image]))[0]
