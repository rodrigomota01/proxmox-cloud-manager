"""In-memory, deterministic CloudProvider for tests."""

import asyncio
import math
from dataclasses import dataclass, field, replace
from typing import ClassVar

from app.providers.base import (
    FilesystemUsage,
    GuestAgentUnavailable,
    GuestNic,
    InstanceKind,
    InstanceObservation,
    InstanceSpec,
    Inventory,
    MetricPoint,
    NodeInfo,
    NodeMetricPoint,
    OperationHandle,
    OperationResult,
    PowerAction,
    PowerState,
    ProgressCb,
    ProviderError,
    ProviderHealth,
    ProviderRef,
    ProviderUnavailable,
    ProviderValidationError,
    StorageObservation,
    TemplateDetails,
    TemplateObservation,
)

_AFTER = {
    PowerAction.START: PowerState.RUNNING,
    PowerAction.RESUME: PowerState.RUNNING,
    PowerAction.REBOOT: PowerState.RUNNING,
    PowerAction.STOP: PowerState.STOPPED,
    PowerAction.SHUTDOWN: PowerState.STOPPED,
    PowerAction.SUSPEND: PowerState.PAUSED,
}


@dataclass
class FakeProvider:
    kind: ClassVar[str] = "fake"

    nodes: list[NodeInfo] = field(default_factory=list)
    instances: dict[str, InstanceObservation] = field(default_factory=dict)
    storage: list[StorageObservation] = field(default_factory=list)
    available: bool = True
    task_error: str | None = None  # make wait() report a failed provider task
    inventory_delay: float = 0.0  # simulate a slow server
    wait_gate: asyncio.Event | None = None  # wait() blocks until set (a long task)
    templates: dict[str, TemplateDetails] = field(default_factory=dict)
    hidden_vmids: set[int] = field(default_factory=set)  # used, but invisible to the token
    fail_steps: set[str] = field(default_factory=set)  # e.g. {"configure"} -> ProviderError
    configured: dict[str, InstanceSpec] = field(default_factory=dict)
    calls: list[tuple[str, str]] = field(default_factory=list)
    # vmid -> what its guest agent reports; absent = no agent
    filesystems: dict[str, list[FilesystemUsage]] = field(default_factory=dict)
    nics: dict[str, list[GuestNic]] = field(default_factory=dict)  # vmid -> NICs

    def add_node(self, name: str, *, online: bool = True) -> None:
        self.nodes.append(NodeInfo(name, online, 8, 32 * 1024**3, 0.1, 4 * 1024**3, 3600))

    def add_instance(
        self, vmid: int, name: str, *, node: str = "pve1", kind: str = "vm",
        power: PowerState = PowerState.STOPPED, vcpus: int = 2, memory_mb: int = 2048,
        pool: str | None = "cm-lab", tags: tuple[str, ...] = (),
    ) -> InstanceObservation:
        pve_type = "qemu" if kind == "vm" else "lxc"
        obs = InstanceObservation(
            ref=ProviderRef({"vmid": vmid, "node": node, "type": pve_type}),
            kind=InstanceKind(kind), name=name, node=node, power_state=power,
            vcpus=vcpus, memory_mb=memory_mb, disk_gb=20, pool=pool, tags=tags,
        )
        self.instances[str(vmid)] = obs
        return obs

    def add_template(
        self, vmid: int, name: str, *, node: str = "pve1", disk_gb: int = 32,
        cloudinit: bool = True,
    ) -> TemplateDetails:
        details = TemplateDetails(
            ref=ProviderRef({"vmid": vmid, "node": node, "type": "qemu", "disk": "scsi0"}),
            name=name, disk_gb=disk_gb, has_cloudinit=cloudinit, has_guest_agent=True,
        )
        self.templates[str(vmid)] = details
        return details

    def _fail(self, step: str) -> None:
        if step in self.fail_steps:
            raise ProviderError(f"fake failure at {step}")

    def _check(self) -> None:
        if not self.available:
            raise ProviderUnavailable("fake provider down")

    async def health(self) -> ProviderHealth:
        self._check()
        return ProviderHealth("fake-1.0", sum(n.online for n in self.nodes), len(self.nodes))

    async def inventory(self) -> Inventory:
        self._check()
        if self.inventory_delay:
            await asyncio.sleep(self.inventory_delay)
        templates = [
            TemplateObservation(t.ref, t.name, t.ref.data["node"], 2, 2048, t.disk_gb)
            for t in self.templates.values()
        ]
        return Inventory(
            list(self.nodes), list(self.instances.values()), list(self.storage), templates
        )

    async def metrics(self, ref: ProviderRef, timeframe: str) -> list[MetricPoint]:
        self._check()
        obs = self.instances[ref.key]
        step = {"hour": 60, "day": 1800, "week": 10800}[timeframe]
        return [
            MetricPoint(
                time=1_700_000_000 + i * step,
                cpu=0.2 + 0.15 * math.sin(i / 6),
                memory_used_mb=int(obs.memory_mb * (0.5 + 0.1 * math.sin(i / 9))),
                memory_total_mb=obs.memory_mb,
                net_in_bps=50_000 + 20_000 * math.sin(i / 4),
                net_out_bps=20_000 + 5_000 * math.cos(i / 5),
                disk_read_bps=10_000.0,
                disk_write_bps=30_000 + 10_000 * math.sin(i / 7),
            )
            for i in range(70)
        ]

    async def node_metrics(self, node: str, timeframe: str) -> list[NodeMetricPoint]:
        self._check()
        step = {"hour": 60, "day": 1800, "week": 10800}[timeframe]
        return [
            NodeMetricPoint(
                time=1_700_000_000 + i * step, cpu=0.3 + 0.1 * math.sin(i / 5),
                memory_used_mb=20_000, memory_total_mb=32_768,
                net_in_bps=1e6, net_out_bps=5e5, load=1.5 + math.sin(i / 8), iowait=0.01,
            )
            for i in range(70)
        ]

    async def describe_template(self, ref: ProviderRef) -> TemplateDetails:
        self._check()
        if ref.key not in self.templates:
            raise ProviderValidationError(f"{ref.key} is not a template")
        return self.templates[ref.key]

    async def slot_available(self, ref: ProviderRef) -> bool:
        self._check()
        vmid = int(ref.data["vmid"])
        return (
            str(vmid) not in self.instances and str(vmid) not in self.templates
            and vmid not in self.hidden_vmids
        )

    async def clone_template(
        self, template: ProviderRef, target: ProviderRef, spec: InstanceSpec
    ) -> OperationHandle:
        self._check()
        self._fail("clone")
        if not await self.slot_available(target):
            raise ProviderValidationError(f"VM {target.key} already exists")
        self.calls.append((target.key, "clone"))
        self.instances[target.key] = InstanceObservation(
            ref=ProviderRef({k: target.data[k] for k in ("vmid", "node", "type")}),
            kind=InstanceKind.VM, name=spec.name, node=target.data["node"],
            power_state=PowerState.STOPPED, vcpus=2, memory_mb=2048,
            disk_gb=self.templates[template.key].disk_gb, pool=target.data.get("pool"),
        )
        return OperationHandle({"key": target.key, "action": "clone"})

    async def configure_instance(self, ref: ProviderRef, spec: InstanceSpec) -> None:
        self._check()
        self._fail("configure")
        self.configured[ref.key] = spec
        obs = self.instances[ref.key]
        self.instances[ref.key] = replace(
            obs, name=spec.name, vcpus=spec.vcpus, memory_mb=spec.memory_mb, tags=spec.tags
        )

    async def grow_disk(self, ref: ProviderRef, template: ProviderRef, size_gb: int) -> None:
        self._check()
        self._fail("grow")
        obs = self.instances[ref.key]
        if size_gb > obs.disk_gb:
            self.instances[ref.key] = replace(obs, disk_gb=size_gb)

    async def delete_instance(self, ref: ProviderRef) -> OperationHandle | None:
        self._check()
        self._fail("delete")
        if ref.key not in self.instances:
            return None
        del self.instances[ref.key]
        self.calls.append((ref.key, "delete"))
        return OperationHandle({"key": ref.key, "action": "delete"})

    async def guest_nics(self, ref: ProviderRef) -> list[GuestNic]:
        self._check()
        return self.nics.get(ref.key, [])

    async def guest_filesystems(self, ref: ProviderRef) -> list[FilesystemUsage]:
        self._check()
        if ref.key not in self.filesystems:
            raise GuestAgentUnavailable("QEMU guest agent is not running")
        return self.filesystems[ref.key]

    async def get_instance(self, ref: ProviderRef) -> InstanceObservation:
        self._check()
        if ref.key not in self.instances:  # same wording as Proxmox
            raise ProviderError(f"Configuration file for VM {ref.key} does not exist")
        return self.instances[ref.key]

    async def power(self, ref: ProviderRef, action: PowerAction) -> OperationHandle:
        self._check()
        self._fail(f"power:{action.value}")
        self.calls.append((ref.key, action.value))
        obs = self.instances[ref.key]
        self.instances[ref.key] = replace(obs, power_state=_AFTER[action])
        return OperationHandle({"key": ref.key, "action": action.value})

    async def wait(
        self, op: OperationHandle, on_progress: ProgressCb | None = None
    ) -> OperationResult:
        if self.wait_gate is not None:
            await self.wait_gate.wait()
        if self.task_error:
            return OperationResult(ok=False, message=self.task_error)
        return OperationResult(ok=True, message="OK")

    async def aclose(self) -> None:
        return None
