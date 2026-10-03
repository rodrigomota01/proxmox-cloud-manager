"""In-memory stand-in for the legacy MySQL awf_ip_pool."""

from dataclasses import dataclass, field, replace

from app.ipam.source import PoolRow


def row(id_, ip, *, assigned=False, mac=None, host=None, node="tagima") -> PoolRow:
    return PoolRow(id=id_, ip_addr=ip, assigned=assigned, mac=mac, host_owner=None,
                   hostname=host, hypervisor="hv08.sp02.atena.io", node=node, ip_block=None)


@dataclass
class FakeIpamSource:
    rows: list[PoolRow] = field(default_factory=list)
    calls: list[tuple] = field(default_factory=list)
    refuse: set[int] = field(default_factory=set)  # reserve() loses the race for these

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
