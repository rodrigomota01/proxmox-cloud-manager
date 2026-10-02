"""In-memory, deterministic CloudProvider for tests."""

from dataclasses import dataclass, field, replace
from typing import ClassVar

from app.providers.base import (
    InstanceKind,
    InstanceObservation,
    Inventory,
    NodeInfo,
    OperationHandle,
    OperationResult,
    PowerAction,
    PowerState,
    ProgressCb,
    ProviderHealth,
    ProviderRef,
    ProviderUnavailable,
    StorageObservation,
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
    calls: list[tuple[str, str]] = field(default_factory=list)

    def add_node(self, name: str, *, online: bool = True) -> None:
        self.nodes.append(NodeInfo(name, online, 8, 32 * 1024**3, 0.1, 4 * 1024**3, 3600))

    def add_instance(
        self, vmid: int, name: str, *, node: str = "pve1", kind: str = "vm",
        power: PowerState = PowerState.STOPPED, vcpus: int = 2, memory_mb: int = 2048,
    ) -> InstanceObservation:
        pve_type = "qemu" if kind == "vm" else "lxc"
        obs = InstanceObservation(
            ref=ProviderRef({"vmid": vmid, "node": node, "type": pve_type}),
            kind=InstanceKind(kind), name=name, node=node, power_state=power,
            vcpus=vcpus, memory_mb=memory_mb, disk_gb=20,
        )
        self.instances[str(vmid)] = obs
        return obs

    def _check(self) -> None:
        if not self.available:
            raise ProviderUnavailable("fake provider down")

    async def health(self) -> ProviderHealth:
        self._check()
        return ProviderHealth("fake-1.0", sum(n.online for n in self.nodes), len(self.nodes))

    async def inventory(self) -> Inventory:
        self._check()
        return Inventory(list(self.nodes), list(self.instances.values()), list(self.storage))

    async def power(self, ref: ProviderRef, action: PowerAction) -> OperationHandle:
        self._check()
        self.calls.append((ref.key, action.value))
        obs = self.instances[ref.key]
        self.instances[ref.key] = replace(obs, power_state=_AFTER[action])
        return OperationHandle({"key": ref.key, "action": action.value})

    async def wait(
        self, op: OperationHandle, on_progress: ProgressCb | None = None
    ) -> OperationResult:
        return OperationResult(ok=True, message="OK")

    async def aclose(self) -> None:
        return None
