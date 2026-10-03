"""Regions and zones (ADR-0012). Global catalog, managed by platform admins."""

import uuid

from sqlalchemy import Boolean, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk


class Region(UUIDPk, Timestamps, Base):
    __tablename__ = "regions"

    slug: Mapped[str] = mapped_column(Text, unique=True)  # e.g. br-sp
    name: Mapped[str] = mapped_column(Text)  # e.g. "Brasil - São Paulo"
    country_code: Mapped[str] = mapped_column(Text)  # ISO 3166-1 alpha-2
    description: Mapped[str] = mapped_column(Text, server_default="")
    active: Mapped[bool] = mapped_column(Boolean, server_default="true")


class Zone(UUIDPk, Timestamps, Base):
    """Failure domain inside a region; holds one or more provider clusters."""

    __tablename__ = "zones"

    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("regions.id", ondelete="RESTRICT"), index=True
    )
    slug: Mapped[str] = mapped_column(Text, unique=True)  # e.g. sp02-hv08
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default="")
    active: Mapped[bool] = mapped_column(Boolean, server_default="true")
