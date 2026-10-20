"""PVE dicts -> domain types. The only module that knows PVE field names."""

import ipaddress
import re
from typing import Any

from app.providers.base import (
    FilesystemUsage,
    GuestAddress,
    GuestExecStatus,
    GuestNic,
    InstanceKind,
    InstanceObservation,
    Inventory,
    MetricPoint,
    NicSpec,
    NodeInfo,
    NodeMetricPoint,
    PhysicalDisk,
    PowerState,
    ProviderRef,
    StaticIPv4,
    StorageObservation,
    TemplateDetails,
    TemplateObservation,
    VirtualDisk,
    VolumeUsage,
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
        root_disk_bytes=_int(item.get("maxdisk")),
        root_disk_used_bytes=_int(item.get("disk")),
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
        net_in_bytes=_int(item.get("netin")),
        net_out_bytes=_int(item.get("netout")),
        # for qemu "disk" is always 0: only the guest agent knows what is used inside
        disk_used_bytes=_int(item.get("disk")) if pve_type == "lxc" else None,
    )


# pseudo/read-only filesystems that say nothing about the guest running out of space
_SKIP_FS = {"squashfs", "tmpfs", "devtmpfs", "overlay", "iso9660", "udf", "ramfs", "autofs"}


def filesystems(result: list[dict[str, Any]]) -> list[FilesystemUsage]:
    """From GET .../agent/get-fsinfo. A disk mounted twice (bind mounts) counts once."""
    seen: set[tuple[int, int]] = set()
    out: list[FilesystemUsage] = []
    for fs in result:
        total, used = _int(fs.get("total-bytes")), _int(fs.get("used-bytes"))
        if not total or str(fs.get("type")) in _SKIP_FS:
            continue
        key = (total, used)
        if key in seen:
            continue
        seen.add(key)
        out.append(FilesystemUsage(str(fs.get("mountpoint") or fs.get("name") or "?"),
                                   str(fs.get("type") or ""), used, total))
    return sorted(out, key=lambda f: f.mountpoint)


def guest_addresses(result: list[dict[str, Any]]) -> list[GuestAddress]:
    """From GET .../agent/network-get-interfaces, in the guest's interface order."""
    out: list[GuestAddress] = []
    for iface in result:
        mac = str(iface.get("hardware-address") or "").lower() or None
        for a in iface.get("ip-addresses") or []:
            if a.get("ip-address-type") != "ipv4":
                continue
            try:
                ip = ipaddress.ip_interface(f"{a.get('ip-address')}/{_int(a.get('prefix')) or 32}")
            except ValueError:
                continue
            if ip.ip.is_loopback or ip.ip.is_link_local:
                continue
            out.append(GuestAddress(mac, ip.with_prefixlen))
    return out


def exec_status(item: dict[str, Any]) -> GuestExecStatus:
    """From GET .../agent/exec-status."""
    exited = bool(_int(item.get("exited")))
    return GuestExecStatus(
        exited=exited,
        exitcode=_int(item.get("exitcode")) if exited else None,
        out=str(item.get("out-data") or ""),
        err=str(item.get("err-data") or ""),
        truncated=bool(_int(item.get("out-truncated")) or _int(item.get("err-truncated"))),
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


def size_bytes(spec: str) -> int:
    """'storage-vz:10001/vm-10001-disk-0.qcow2,size=32G' -> 34359738368"""
    for part in spec.split(","):
        if part.startswith("size="):
            value = part[5:]
            unit = value[-1].upper()
            try:
                if unit in _SIZE_UNITS:
                    return int(float(value[:-1]) * _SIZE_UNITS[unit] * _GIB)
                return int(value)
            except ValueError:
                return 0
    return 0


_VM_DISK = re.compile(r"^(?:(?:scsi|virtio|sata|ide)\d+|efidisk0|tpmstate0)$")
_CT_DISK = re.compile(r"^(?:rootfs|mp\d+)$")


def vm_disks(config: dict[str, Any], pve_type: str) -> list[VirtualDisk]:
    """Every disk in a guest's configuration. VMs: scsiN/virtioN/sataN/ideN plus EFI and
    TPM state; containers: rootfs and mpN. Left out: CD-ROMs, cloud-init drives,
    passthrough and container bind mounts (no storage behind them)."""
    pattern = _CT_DISK if pve_type == "lxc" else _VM_DISK
    out: list[VirtualDisk] = []
    for key in sorted((k for k in config if pattern.match(k)), key=_disk_order):
        spec = str(config[key])
        volume, _, rest = spec.partition(",")
        if "media=cdrom" in spec or "cloudinit" in volume or ":" not in volume:
            continue  # CD-ROM / cloud-init / passthrough (/dev/...) / bind mount
        filename = volume.split(":", 1)[1].rsplit("/", 1)[-1]
        fmt = _kv(rest).get("format") or (
            filename.rsplit(".", 1)[1] if "." in filename
            else "subvol" if filename.startswith("subvol-") else None
        )
        out.append(VirtualDisk(key, volume.split(":", 1)[0], volume, size_bytes(spec), fmt))
    return out


def _disk_order(key: str) -> tuple[int, str, int]:
    """rootfs first, then by bus and number: scsi2 before scsi10."""
    head = key.rstrip("0123456789")
    num = key[len(head):]
    return (0 if key == "rootfs" else 1, head, int(num) if num else 0)


def volumes(content: list[dict[str, Any]]) -> list[VolumeUsage]:
    """From GET /nodes/{node}/storage/{storage}/content?content=images."""
    return [
        VolumeUsage(str(v["volid"]), _int(v.get("size")),
                    _int(v["used"]) if v.get("used") is not None else None)
        for v in content if v.get("volid")
    ]


def physical_disks(items: list[dict[str, Any]]) -> list[PhysicalDisk]:
    """From GET /nodes/{node}/disks/list."""
    out = []
    for d in items:
        health = d.get("health")
        wearout = d.get("wearout")
        out.append(PhysicalDisk(
            device=str(d.get("devpath") or "?"),
            model=d.get("model") or None,
            serial=d.get("serial") or None,
            type=d.get("type") or None,
            size_bytes=_int(d.get("size")),
            used=d.get("used") or None,
            health=str(health) if health and health != "UNKNOWN" else None,
            wearout=int(wearout) if isinstance(wearout, int | float) else None,  # "N/A"
        ))
    return sorted(out, key=lambda x: x.device)


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


def _kv(spec: str) -> dict[str, str]:
    return dict(part.split("=", 1) for part in spec.split(",") if "=" in part)


_NIC_MODELS = ("virtio", "e1000", "e1000e", "rtl8139", "vmxnet3")


def nics(config: dict[str, Any], pve_type: str) -> list[GuestNic]:
    """From GET .../config. VMs: netN=virtio=MAC,bridge=..,tag=.. + ipconfigN=ip=..,gw=..;
    containers: netN=name=eth0,hwaddr=MAC,bridge=..,ip=..,gw=..,tag=.."""
    out: list[GuestNic] = []
    for key in sorted(k for k in config if k.startswith("net") and k[3:].isdigit()):
        fields = _kv(str(config[key]))
        if pve_type == "lxc":
            mac, ip, gw = fields.get("hwaddr"), fields.get("ip"), fields.get("gw")
        else:
            mac = next((fields[m] for m in _NIC_MODELS if m in fields), None)
            cloud = _kv(str(config.get(f"ipconfig{key[3:]}", "")))
            ip, gw = cloud.get("ip"), cloud.get("gw")
        if ip in ("dhcp", "manual", "auto"):
            ip = None
        tag = fields.get("tag")
        out.append(GuestNic(key, mac.lower() if mac else None, fields.get("bridge"),
                            int(tag) if tag and tag.isdigit() else None, ip, gw))
    return out


DESCRIPTION_MAX = 8192  # what PVE itself accepts


def description(config: dict[str, Any]) -> str | None:
    """The guest's notes from GET .../config (the API returns them decoded). Blank
    means none; surrounding whitespace is noise."""
    text = str(config.get("description") or "").strip()
    return text[:DESCRIPTION_MAX] or None


def net_with(current: str, nic: NicSpec) -> str:
    """Rewrite a VM netN spec ('virtio=MAC,bridge=vmbr0,firewall=1') with the given MAC,
    bridge and VLAN, keeping the model and every other option."""
    parts = [p for p in current.split(",") if p]
    out: list[str] = []
    seen_model = False
    for part in parts:
        key = part.partition("=")[0]
        if key in _NIC_MODELS and not seen_model:
            seen_model = True
            out.append(f"{key}={nic.mac.upper()}" if nic.mac else part)
        elif key == "bridge" and nic.bridge:
            out.append(f"bridge={nic.bridge}")
        elif key == "tag" and nic.vlan:
            continue  # re-added below
        else:
            out.append(part)
    if not seen_model:
        out.insert(0, f"virtio={nic.mac.upper()}" if nic.mac else "virtio")
    if nic.bridge and not any(p.startswith("bridge=") for p in out):
        out.append(f"bridge={nic.bridge}")
    if nic.vlan:
        out.append(f"tag={nic.vlan}")
    return ",".join(out)
