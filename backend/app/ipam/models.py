"""IP address management backed by the legacy MySQL table awf_ip_pool (ADR-0014).

MySQL stays the source of truth; ipam_addresses is a local copy refreshed by the worker
(the API has no route to MySQL). ipam_networks says how to configure an address on a
server (prefix, gateway, VLAN), which awf_ip_pool does not record. Global tables: only
/admin/* reads them, plus the list of free addresses offered when creating instances.
"""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import CIDR, INET
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPk


class IpamAddress(UUIDPk, Base):
    __tablename__ = "ipam_addresses"

    external_id: Mapped[int] = mapped_column(BigInteger, unique=True)  # awf_ip_pool.id
    address: Mapped[str] = mapped_column(INET)  # host address, no prefix
    prefix: Mapped[int | None] = mapped_column(Integer)  # when ip_addr carries one (/31)
    hypervisor: Mapped[str | None] = mapped_column(Text)
    node_name: Mapped[str | None] = mapped_column(Text)  # pve_node_owner
    # the server it belongs to here (matched by node name); None = not integrated
    cluster_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="SET NULL"), index=True
    )
    assigned: Mapped[bool] = mapped_column(server_default="false")
    mac: Mapped[str | None] = mapped_column(Text)  # lowercase
    hostname: Mapped[str | None] = mapped_column(Text)  # hostname_lease
    host_owner: Mapped[str | None] = mapped_column(Text)
    ip_block: Mapped[str | None] = mapped_column(Text)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IpamNetwork(UUIDPk, Timestamps, Base):
    """How addresses inside `cidr` are configured on a server's guests."""

    __tablename__ = "ipam_networks"
    __table_args__ = (UniqueConstraint("cluster_id", "cidr"),)

    cluster_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("provider_clusters.id", ondelete="CASCADE")
    )
    cidr: Mapped[str] = mapped_column(CIDR)
    gateway: Mapped[str] = mapped_column(INET)
    vlan: Mapped[int | None] = mapped_column(Integer)
    bridge: Mapped[str | None] = mapped_column(Text)  # None: keep the template's
