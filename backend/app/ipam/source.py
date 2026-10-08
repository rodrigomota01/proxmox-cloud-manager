"""The legacy IPAM table (MySQL/MariaDB `awf_ip_pool`), the source of truth for IPs.

Only the worker talks to it. Writes are conditional single-row UPDATEs, so two systems
reserving the same address cannot both win: `reserve` only succeeds on a free row.
The database user needs SELECT and UPDATE on that table and nothing else.
"""

from dataclasses import dataclass
from typing import Protocol

from app.infra.mysql import MysqlDb

COLUMNS = (
    "id, assigned, assigned_to_macaddr, host_owner, hostname_lease, ip_addr, hypervisor, "
    "pve_node_owner, ipBlock"
)


@dataclass(frozen=True)
class PoolRow:
    id: int
    ip_addr: str
    assigned: bool
    mac: str | None
    host_owner: str | None
    hostname: str | None
    hypervisor: str | None
    node: str | None
    ip_block: str | None


class IpamSource(Protocol):
    async def fetch(self) -> list[PoolRow]: ...
    async def reserve(self, row_id: int, *, hostname: str, mac: str | None) -> bool: ...
    async def set_mac(self, row_id: int, *, hostname: str, mac: str) -> bool: ...
    async def release(self, row_id: int, *, hostname: str, clear_mac: bool) -> bool: ...


def _bit(value: object) -> bool:
    if isinstance(value, bytes | bytearray):
        return any(value)
    return bool(value)


def _text(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


class MysqlIpamSource(MysqlDb):
    async def fetch(self) -> list[PoolRow]:
        rows, _ = await self._execute(f"SELECT {COLUMNS} FROM awf_ip_pool")  # noqa: S608
        return [
            PoolRow(
                id=int(r[0]), assigned=_bit(r[1]), mac=(_text(r[2]) or "").lower() or None,
                host_owner=_text(r[3]), hostname=_text(r[4]), ip_addr=str(r[5] or "").strip(),
                hypervisor=_text(r[6]), node=_text(r[7]), ip_block=_text(r[8]),
            )
            for r in rows
        ]

    async def reserve(self, row_id: int, *, hostname: str, mac: str | None) -> bool:
        """Mark a *free* row as ours. A pre-assigned MAC (virtual MAC of a failover IP)
        is kept: the guest must use it, not the other way round."""
        _, count = await self._execute(
            "UPDATE awf_ip_pool SET assigned = 1, hostname_lease = %s, "
            "assigned_to_macaddr = COALESCE(NULLIF(assigned_to_macaddr, ''), %s) "
            "WHERE id = %s AND (assigned = 0 OR assigned IS NULL)",
            (hostname, mac, row_id),
        )
        return count == 1

    async def set_mac(self, row_id: int, *, hostname: str, mac: str) -> bool:
        """Record the MAC the new guest got, on a row we hold that had none."""
        _, count = await self._execute(
            "UPDATE awf_ip_pool SET assigned_to_macaddr = %s WHERE id = %s "
            "AND hostname_lease = %s AND (assigned_to_macaddr IS NULL OR assigned_to_macaddr = '')",
            (mac, row_id, hostname),
        )
        return count == 1

    async def release(self, row_id: int, *, hostname: str, clear_mac: bool) -> bool:
        """Free a row we reserved (only while it still carries our hostname)."""
        mac = ", assigned_to_macaddr = NULL" if clear_mac else ""
        _, count = await self._execute(
            f"UPDATE awf_ip_pool SET assigned = 0, hostname_lease = NULL{mac} "  # noqa: S608
            "WHERE id = %s AND hostname_lease = %s",
            (row_id, hostname),
        )
        return count == 1
