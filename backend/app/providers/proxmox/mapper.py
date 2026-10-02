"""PVE dicts -> domain types. The only module that knows PVE field names."""

from typing import Any

from app.providers.base import (
    InstanceKind,
    InstanceObservation,
    Inventory,
    NodeInfo,
    PowerState,
    ProviderRef,
    StorageObservation,
)

_KIND = {"qemu": InstanceKind.VM, "lxc": InstanceKind.CONTAINER}
_POWER = {
    "running": PowerState.RUNNING,
    "stopped": PowerState.STOPPED,
    "paused": PowerState.PAUSED,
    "suspended": PowerState.PAUSED,
}
_MIB, _GIB = 1024**2, 1024**3


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def instance_ref(vmid: int, node: str, pve_type: str) -> ProviderRef:
    return ProviderRef({"vmid": vmid, "node": node, "type": pve_type})


def node(item: dict[str, Any]) -> NodeInfo:
    return NodeInfo(
        name=item["node"],
        online=item.get("status") == "online",
        cpu_count=_int(item.get("maxcpu")),
        memory_bytes=_int(item.get("maxmem")),
        cpu_usage=float(item.get("cpu") or 0.0),
        memory_used_bytes=_int(item.get("mem")),
        uptime_seconds=_int(item.get("uptime")),
    )


def instance(item: dict[str, Any]) -> InstanceObservation:
    pve_type = item["type"]
    tags = tuple(t for t in str(item.get("tags") or "").replace(",", ";").split(";") if t)
    return InstanceObservation(
        ref=instance_ref(int(item["vmid"]), item["node"], pve_type),
        kind=_KIND[pve_type],
        name=item.get("name") or f"{pve_type}-{item['vmid']}",
        node=item["node"],
        power_state=_POWER.get(str(item.get("status")), PowerState.UNKNOWN),
        vcpus=_int(item.get("maxcpu")),
        memory_mb=_int(item.get("maxmem")) // _MIB,
        disk_gb=_int(item.get("maxdisk")) // _GIB,
        tags=tags,
        pool=item.get("pool"),
        uptime_seconds=_int(item.get("uptime")),
    )


def storage(item: dict[str, Any]) -> StorageObservation:
    return StorageObservation(
        node=item["node"],
        name=item["storage"],
        type=str(item.get("plugintype") or ""),
        content=tuple(c for c in str(item.get("content") or "").split(",") if c),
        shared=bool(_int(item.get("shared"))),
        active=item.get("status") == "available",
        total_bytes=_int(item.get("maxdisk")),
        used_bytes=_int(item.get("disk")),
    )


def inventory(resources: list[dict[str, Any]]) -> Inventory:
    """From GET /cluster/resources. Templates are images (Phase 2), not instances."""
    inv = Inventory()
    for item in resources:
        kind = item.get("type")
        if kind == "node":
            inv.nodes.append(node(item))
        elif kind in _KIND and not _int(item.get("template")):
            inv.instances.append(instance(item))
        elif kind == "storage":
            inv.storage.append(storage(item))
    return inv
