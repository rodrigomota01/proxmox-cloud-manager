"""CloudProvider contract and domain types (docs/architecture/04-integracao-proxmox.md).

Nothing here mentions qemu, lxc, UPID or vmid: ProviderRef and OperationHandle are
opaque to the domain; only the provider that produced them opens them.
"""

import enum
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar, Protocol


class ProviderError(Exception):
    """Base error. Messages are safe to log; never include credentials."""


class ProviderUnavailable(ProviderError):
    """Timeout, connection failure, 5xx, or circuit breaker open."""


class ProviderAuthError(ProviderError):
    """401/403: token missing, revoked or lacking privileges."""


class ProviderValidationError(ProviderError):
    """400: the provider rejected the parameters."""


class ProviderOperationError(ProviderError):
    """An asynchronous operation finished with an error."""


class InstanceKind(enum.StrEnum):
    VM = "vm"
    CONTAINER = "container"


class PowerState(enum.StrEnum):
    RUNNING = "running"
    STOPPED = "stopped"
    PAUSED = "paused"
    UNKNOWN = "unknown"


class PowerAction(enum.StrEnum):
    START = "start"
    STOP = "stop"
    SHUTDOWN = "shutdown"
    REBOOT = "reboot"
    SUSPEND = "suspend"
    RESUME = "resume"


@dataclass(frozen=True)
class ProviderRef:
    """Opaque locator of a guest inside one cluster. Stored as JSONB."""

    data: dict[str, Any]

    @property
    def key(self) -> str:
        """Stable identity inside the cluster (survives node migration)."""
        return str(self.data["vmid"])


@dataclass(frozen=True)
class ProviderHealth:
    version: str
    nodes_online: int
    nodes_total: int


@dataclass(frozen=True)
class NodeInfo:
    name: str
    online: bool
    cpu_count: int
    memory_bytes: int
    cpu_usage: float  # 0..1
    memory_used_bytes: int
    uptime_seconds: int


@dataclass(frozen=True)
class InstanceObservation:
    ref: ProviderRef
    kind: InstanceKind
    name: str
    node: str
    power_state: PowerState
    vcpus: int
    memory_mb: int
    disk_gb: int
    tags: tuple[str, ...] = ()
    pool: str | None = None
    uptime_seconds: int = 0


@dataclass(frozen=True)
class StorageObservation:
    node: str
    name: str
    type: str
    content: tuple[str, ...]
    shared: bool
    active: bool
    total_bytes: int
    used_bytes: int


@dataclass(frozen=True)
class Inventory:
    """One consistent snapshot (Proxmox: a single /cluster/resources call)."""

    nodes: list[NodeInfo] = field(default_factory=list)
    instances: list[InstanceObservation] = field(default_factory=list)
    storage: list[StorageObservation] = field(default_factory=list)


@dataclass(frozen=True)
class OperationHandle:
    data: dict[str, Any]


@dataclass(frozen=True)
class OperationResult:
    ok: bool
    message: str = ""


ProgressCb = Callable[[str], Awaitable[None]]


class CloudProvider(Protocol):
    kind: ClassVar[str]

    async def health(self) -> ProviderHealth: ...
    async def inventory(self) -> Inventory: ...
    async def get_instance(self, ref: ProviderRef) -> InstanceObservation:
        """Live state of one guest (not the cached bulk listing)."""
        ...
    async def power(self, ref: ProviderRef, action: PowerAction) -> OperationHandle: ...
    async def wait(
        self, op: OperationHandle, on_progress: ProgressCb | None = None
    ) -> OperationResult: ...
    async def aclose(self) -> None: ...
