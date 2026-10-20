"""In-memory stand-in for the legacy MySQL awf_ip_pool."""

from dataclasses import dataclass, field, replace

from app.ipam.source import PoolFields, PoolRow


def row(id_, ip, *, assigned=False, mac=None, host=None, node="tagima") -> PoolRow:
    return PoolRow(id=id_, ip_addr=ip, assigned=assigned, mac=mac, host_owner=None,
                   hostname=host, hypervisor="hv08.sp02.atena.io", node=node, ip_block=None)


@dataclass
class FakeIpamSource:
    rows: list[PoolRow] = field(default_factory=list)
    calls: list[tuple] = field(default_factory=list)
    refuse: set[int] = field(default_factory=set)  # reserve() loses the race for these
    next_id: int = 1000  # ids handed to inserted rows

    def _get(self, row_id: int) -> tuple[int, PoolRow]:
        return next((i, r) for i, r in enumerate(self.rows) if r.id == row_id)

    async def fetch(self) -> list[PoolRow]:
        return list(self.rows)

    async def reserve(self, row_id, *, hostname, mac):
        self.calls.append(("reserve", row_id, hostname))
        i, r = self._get(row_id)
        if r.assigned or row_id in self.refuse:
            return False
        self.rows[i] = replace(r, assigned=True, hostname=hostname, mac=r.mac or mac)
        return True

    async def set_mac(self, row_id, *, hostname, mac):
        self.calls.append(("set_mac", row_id, mac))
        i, r = self._get(row_id)
        if r.hostname != hostname or r.mac:
            return False
        self.rows[i] = replace(r, mac=mac)
        return True

    async def release(self, row_id, *, hostname, clear_mac):
        self.calls.append(("release", row_id, clear_mac))
        i, r = self._get(row_id)
        if r.hostname != hostname:
            return False
        self.rows[i] = replace(r, assigned=False, hostname=None, mac=None if clear_mac else r.mac)
        return True

    async def insert(self, fields: PoolFields) -> int:
        self.calls.append(("insert", fields.ip_addr))
        self.next_id += 1
        self.rows.append(PoolRow(
            id=self.next_id, ip_addr=fields.ip_addr, assigned=fields.assigned, mac=fields.mac,
            host_owner=fields.host_owner, hostname=fields.hostname,
            hypervisor=fields.hypervisor, node=fields.node, ip_block=fields.ip_block,
        ))
        return self.next_id

    async def update(self, row_id: int, fields: PoolFields) -> bool:
        self.calls.append(("update", row_id, fields.ip_addr))
        try:
            i, r = self._get(row_id)
        except StopIteration:
            return False
        self.rows[i] = replace(
            r, ip_addr=fields.ip_addr, assigned=fields.assigned, mac=fields.mac,
            host_owner=fields.host_owner, hostname=fields.hostname,
            hypervisor=fields.hypervisor, node=fields.node, ip_block=fields.ip_block,
        )
        return True

    async def delete(self, row_id: int) -> bool:
        self.calls.append(("delete", row_id))
        before = len(self.rows)
        self.rows = [r for r in self.rows if r.id != row_id]
        return len(self.rows) < before

    async def free(self, row_id: int) -> bool:
        self.calls.append(("free", row_id))
        i, r = self._get(row_id)
        if not r.assigned:
            return False
        self.rows[i] = replace(r, assigned=False, hostname=None)
        return True
