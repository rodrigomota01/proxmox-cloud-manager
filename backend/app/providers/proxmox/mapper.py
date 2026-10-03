"""PVE dicts -> domain types. The only module that knows PVE field names."""

from typing import Any

from app.providers.base import (
    InstanceKind,
    InstanceObservation,
    Inventory,
    MetricPoint,
    NodeInfo,
    NodeMetricPoint,
    PowerState,
    ProviderRef,
    StaticIPv4,
    StorageObservation,
    TemplateDetails,
    TemplateObservation,
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
        cpu_usage=float(item.get("cpu") or 0.0),
        memory_used_mb=_int(item.get("mem")) // _MIB,
    )


def metric_point(item: dict[str, Any]) -> MetricPoint | None:
    """From GET .../rrddata; samples with no data yet (stopped guest) are skipped."""
    if item.get("cpu") is None and item.get("mem") is None:
        return None
    return MetricPoint(
        time=_int(item.get("time")),
        cpu=float(item.get("cpu") or 0.0),
        memory_used_mb=int(float(item.get("mem") or 0)) // _MIB,
        memory_total_mb=int(float(item.get("maxmem") or 0)) // _MIB,
        net_in_bps=float(item.get("netin") or 0.0),
        net_out_bps=float(item.get("netout") or 0.0),
        disk_read_bps=float(item.get("diskread") or 0.0),
        disk_write_bps=float(item.get("diskwrite") or 0.0),
    )


def node_metric_point(item: dict[str, Any]) -> NodeMetricPoint | None:
    """From GET /nodes/{node}/rrddata."""
    if item.get("cpu") is None and item.get("memused") is None:
        return None
    return NodeMetricPoint(
        time=_int(item.get("time")),
        cpu=float(item.get("cpu") or 0.0),
        memory_used_mb=int(float(item.get("memused") or 0)) // _MIB,
        memory_total_mb=int(float(item.get("memtotal") or 0)) // _MIB,
        net_in_bps=float(item.get("netin") or 0.0),
        net_out_bps=float(item.get("netout") or 0.0),
        load=float(item.get("loadavg") or 0.0),
        iowait=float(item.get("iowait") or 0.0),
    )


def instance_status(ref: ProviderRef, item: dict[str, Any]) -> InstanceObservation:
    """From GET /nodes/{node}/{type}/{vmid}/status/current (live, not cached)."""
    power = _POWER.get(str(item.get("status")), PowerState.UNKNOWN)
    if power is PowerState.RUNNING and item.get("qmpstatus") in ("paused", "suspended"):
        power = PowerState.PAUSED
    return instance(
        {
            **item,
            "type": ref.data["type"], "vmid": ref.data["vmid"], "node": ref.data["node"],
            "status": power.value,
            "maxcpu": item.get("cpus", item.get("maxcpu")),
        }
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


def template(item: dict[str, Any]) -> TemplateObservation:
    return TemplateObservation(
        ref=instance_ref(int(item["vmid"]), item["node"], item["type"]),
        name=item.get("name") or f"template-{item['vmid']}",
        node=item["node"],
        vcpus=_int(item.get("maxcpu")),
        memory_mb=_int(item.get("maxmem")) // _MIB,
        disk_gb=_int(item.get("maxdisk")) // _GIB,
        pool=item.get("pool"),
    )


def inventory(resources: list[dict[str, Any]]) -> Inventory:
    """From GET /cluster/resources. Templates are listed apart: they become images."""
    inv = Inventory()
    for item in resources:
        kind = item.get("type")
        if kind == "node":
            inv.nodes.append(node(item))
        elif kind == "qemu" and _int(item.get("template")):
            inv.templates.append(template(item))
        elif kind in _KIND and not _int(item.get("template")):
            inv.instances.append(instance(item))
        elif kind == "storage":
            inv.storage.append(storage(item))
    return inv


_SIZE_UNITS = {"K": 1 / 1024**2, "M": 1 / 1024, "G": 1, "T": 1024}


def disk_size_gb(spec: str) -> int:
    """'storage-vz:9998/disk.qcow2,size=32G' -> 32"""
    for part in spec.split(","):
        if part.startswith("size="):
            value = part[5:]
            unit = value[-1].upper()
            if unit in _SIZE_UNITS:
                return int(float(value[:-1]) * _SIZE_UNITS[unit])
            return int(value) // _GIB
    return 0


def boot_disk(config: dict[str, Any]) -> str | None:
    """First disk of 'boot: order=scsi0;ide2;net0' that is not a CD-ROM."""
    order = str(config.get("boot", ""))
    candidates = order.removeprefix("order=").split(";") if "order=" in order else []
    disk_keys = ("scsi", "virt", "sata")
    candidates += [k for k in sorted(config) if k[:4] in disk_keys and k[-1:].isdigit()]
    for key in candidates:
        value = str(config.get(key, ""))
        if value and "media=cdrom" not in value and "cloudinit" not in value:
            return key
    return None


def template_details(ref: ProviderRef, config: dict[str, Any]) -> TemplateDetails:
    disk = boot_disk(config)
    agent = str(config.get("agent", "0"))
    return TemplateDetails(
        ref=ProviderRef({**ref.data, "disk": disk}),
        name=str(config.get("name", "")),
        disk_gb=disk_size_gb(str(config.get(disk, ""))) if disk else 0,
        has_cloudinit=any("cloudinit" in str(v) for v in config.values()),
        has_guest_agent=agent.startswith("1") or "enabled=1" in agent,
    )


def ipconfig(ip: StaticIPv4) -> str:
    return f"ip={ip.address},gw={ip.gateway}"
