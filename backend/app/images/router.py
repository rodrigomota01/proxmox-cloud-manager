"""Image catalog: tenants list what they may use; platform admins register templates.

/api/v1/images                          tenant (X-Tenant-Id): public + own, active only
/api/v1/admin/clusters/{id}/templates   templates the token can see (live)
/api/v1/admin/images                    register / list / update / retire
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentTenant, DbSession, Principal, require_platform
from app.audit import service as audit
from app.core.errors import Conflict, NotFound, ValidationError
from app.images.models import Image
from app.inventory.models import ProviderCluster
from app.providers.base import ProviderError
from app.providers.registry import ProviderRegistry
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
    """Tenant view: no provider identifiers."""

    id: uuid.UUID
    name: str
    description: str
    os_family: str
    default_user: str
    min_disk_gb: int
    visibility: str


class AdminImageOut(ImageOut):
    cluster_id: uuid.UUID
    template_vmid: int
    tenant_id: uuid.UUID | None
    active: bool
    created_at: datetime


class TemplateOut(BaseModel):
    vmid: int
    name: str
    node: str
    disk_gb: int
    image_id: uuid.UUID | None  # already registered as


class ImageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cluster_id: uuid.UUID
    template_vmid: Annotated[int, Field(ge=100)]
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


def image_out(i: Image) -> ImageOut:
    return ImageOut(
        id=i.id, name=i.name, description=i.description, os_family=i.os_family,
        default_user=i.default_user, min_disk_gb=i.min_disk_gb, visibility=i.visibility,
    )


def admin_image_out(i: Image) -> AdminImageOut:
    return AdminImageOut(
        **image_out(i).model_dump(), cluster_id=i.cluster_id,
        template_vmid=int(i.provider_ref["vmid"]), tenant_id=i.tenant_id, active=i.active,
        created_at=i.created_at,
    )


# --- tenant ----------------------------------------------------------------------------


@router.get("/images", tags=["images"])
async def list_images(ctx: CurrentTenant, db: DbSession) -> list[ImageOut]:
    # RLS: public images + this tenant's; active only
    rows = await db.execute(
        select(Image)
        .where(Image.active, (Image.tenant_id.is_(None)) | (Image.tenant_id == ctx.tenant_id))
        .order_by(Image.name)
    )
    return [image_out(i) for i in rows.scalars()]


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
        str(i.provider_ref["vmid"]): i.id
        for i in (
            await db.execute(select(Image).where(Image.cluster_id == cluster.id, Image.active))
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
    rows = await db.execute(select(Image).order_by(Image.name))
    return [admin_image_out(i) for i in rows.scalars()]


@router.post("/admin/images", status_code=status.HTTP_201_CREATED, tags=["admin"])
async def register_image(
    body: ImageCreate, principal: ImageAdmin, db: DbSession, registry: Registry
) -> AdminImageOut:
    cluster = await db.get(ProviderCluster, body.cluster_id)
    if cluster is None:
        raise ValidationError(errors=[{"field": "cluster_id", "message": "unknown cluster"}])
    if body.tenant_id and await db.get(Tenant, body.tenant_id) is None:
        raise ValidationError(errors=[{"field": "tenant_id", "message": "unknown tenant"}])

    # find the template's node, then read its config
    try:
        async with registry.open(db, cluster) as provider:
            found = next(
                (t for t in (await provider.inventory()).templates
                 if int(t.ref.data["vmid"]) == body.template_vmid),
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

    image = Image(
        cluster_id=cluster.id, provider_ref=details.ref.data, name=body.name,
        description=body.description, os_family=body.os_family,
        default_user=body.default_user, min_disk_gb=details.disk_gb,
        visibility=body.visibility, tenant_id=body.tenant_id,
    )
    try:
        async with db.begin_nested():
            db.add(image)
    except IntegrityError as exc:
        raise Conflict("This template is already registered as an active image") from exc
    await audit.record(
        db, "IMAGE_REGISTER", actor_user_id=principal.user_id, tenant_id=body.tenant_id,
        resource_type="image", resource_id=image.id,
        details={"cluster": cluster.name, "template_vmid": body.template_vmid,
                 "guest_agent": details.has_guest_agent},
    )
    await db.refresh(image)
    return admin_image_out(image)


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
    try:
        async with db.begin_nested():
            await db.flush()
    except IntegrityError as exc:
        raise Conflict("Another active image uses this template") from exc
    await audit.record(
        db, "IMAGE_UPDATE", actor_user_id=principal.user_id, tenant_id=image.tenant_id,
        resource_type="image", resource_id=image.id, details={"fields": sorted(changes)},
    )
    await db.refresh(image)
    return admin_image_out(image)

