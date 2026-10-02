"""ProxmoxProvider: CloudProvider over ProxmoxClient + mapper."""

import asyncio
from typing import ClassVar
from urllib.parse import quote

from app.providers.base import (
    Inventory,
    OperationHandle,
    OperationResult,
    PowerAction,
    ProgressCb,
    ProviderError,
    ProviderHealth,
    ProviderRef,
)
from app.providers.proxmox import mapper
from app.providers.proxmox.client import ProxmoxClient

# suspend/resume of LXC are not supported by PVE
_LXC_ACTIONS = {PowerAction.START, PowerAction.STOP, PowerAction.SHUTDOWN, PowerAction.REBOOT}


class ProxmoxProvider:
    kind: ClassVar[str] = "proxmox"

    def __init__(self, client: ProxmoxClient, *, poll_max_seconds: float = 5.0) -> None:
        self.client = client
        self.poll_max_seconds = poll_max_seconds

    async def aclose(self) -> None:
        await self.client.aclose()

    async def health(self) -> ProviderHealth:
        version = await self.client.get("/version")
        resources = await self.client.get("/cluster/resources", {"type": "node"}) or []
        nodes = [mapper.node(n) for n in resources]
        return ProviderHealth(
            version=str((version or {}).get("version", "unknown")),
            nodes_online=sum(n.online for n in nodes),
            nodes_total=len(nodes),
        )

    async def inventory(self) -> Inventory:
        return mapper.inventory(await self.client.get("/cluster/resources") or [])

    async def power(self, ref: ProviderRef, action: PowerAction) -> OperationHandle:
        pve_type, node, vmid = ref.data["type"], ref.data["node"], int(ref.data["vmid"])
        if pve_type == "lxc" and action not in _LXC_ACTIONS:
            raise ProviderError(f"{action} is not supported for containers")
        upid = await self.client.post(
            f"/nodes/{quote(node, safe='')}/{pve_type}/{vmid}/status/{action.value}"
        )
        return OperationHandle({"upid": upid, "node": node})

    async def wait(
        self, op: OperationHandle, on_progress: ProgressCb | None = None
    ) -> OperationResult:
        node, upid = op.data["node"], op.data["upid"]
        path = f"/nodes/{quote(node, safe='')}/tasks/{quote(upid, safe='')}/status"
        delay = 0.5
        while True:
            status = await self.client.get(path) or {}
            if status.get("status") == "stopped":
                exit_status = str(status.get("exitstatus", ""))
                return OperationResult(ok=exit_status == "OK", message=exit_status)
            if on_progress:
                await on_progress("running")
            await asyncio.sleep(delay)
            delay = min(delay * 2, self.poll_max_seconds)
