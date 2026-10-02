import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.auth.schemas import Email

# Becomes part of Proxmox pool names (cm-<tenant>-<project>), so keep it DNS-label-like.
Slug = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$")
]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Description = Annotated[str, Field(max_length=1000)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Confirm(Input):
    confirm: str


# --- tenants ---------------------------------------------------------------------------


class TenantCreate(Input):
    slug: Slug
    name: Name
    admin_email: Email | None = None  # becomes TENANT_ADMIN (invited if new)


class TenantUpdate(Input):
    name: Name


class TenantOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    status: str
    created_at: datetime


# --- members ---------------------------------------------------------------------------


class MemberAdd(Input):
    email: Email
    display_name: Name | None = None  # used only when the user is created (invited)
    role: str
    project_id: uuid.UUID | None = None  # None -> tenant-level binding


class BindingOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    role: str
    scope_type: str
    scope_id: uuid.UUID
    created_at: datetime


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    invited: bool  # has not set a password yet
    bindings: list[BindingOut]


# --- projects --------------------------------------------------------------------------


class ProjectCreate(Input):
    slug: Slug
    name: Name
    description: Description = ""


class ProjectUpdate(Input):
    name: Name | None = None
    description: Description | None = None


class ProjectOut(BaseModel):
    id: uuid.UUID
    tenant_id: uuid.UUID
    slug: str
    name: str
    description: str
    created_at: datetime


class Page[T](BaseModel):
    items: list[T]
    next_cursor: str | None = None
