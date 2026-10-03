"""ProxmoxProvider: CloudProvider over ProxmoxClient + mapper."""

import asyncio
from typing import ClassVar
from urllib.parse import quote

from app.providers.base import (
    InstanceObservation,
    InstanceSpec,
    Inventory,
    OperationHandle,
    OperationResult,
    PowerAction,
    ProgressCb,
    ProviderError,
    ProviderHealth,
    ProviderRef,
    ProviderValidationError,
    TemplateDetails,
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

    async def get_instance(self, ref: ProviderRef) -> InstanceObservation:
        # /cluster/resources is refreshed by pvestatd every ~10s; right after a task it
        # can still show the old state. status/current asks the node directly.
        pve_type, node, vmid = ref.data["type"], ref.data["node"], int(ref.data["vmid"])
        item = await self.client.get(
            f"/nodes/{quote(node, safe='')}/{pve_type}/{vmid}/status/current"
        )
        return mapper.instance_status(ref, item or {})

    # --- provisioning --------------------------------------------------------------------

    @staticmethod
    def _path(ref: ProviderRef) -> str:
        node = quote(ref.data["node"], safe="")
        return f"/nodes/{node}/{ref.data['type']}/{int(ref.data['vmid'])}"

    async def describe_template(self, ref: ProviderRef) -> TemplateDetails:
        config = await self.client.get(f"{self._path(ref)}/config") or {}
        if not config.get("template"):
            raise ProviderValidationError(f"{ref.key} is not a template")
        return mapper.template_details(ref, config)

    async def slot_available(self, ref: ProviderRef) -> bool:
        # checks the whole cluster, including guests this token cannot see
        try:
            await self.client.get("/cluster/nextid", {"vmid": int(ref.data["vmid"])})
        except ProviderValidationError:
            return False
        return True

    async def clone_template(
        self, template: ProviderRef, target: ProviderRef, spec: InstanceSpec
    ) -> OperationHandle:
        data = {"newid": int(target.data["vmid"]), "name": spec.name, "full": 1}
        if pool := target.data.get("pool"):
            data["pool"] = pool
        upid = await self.client.post(f"{self._path(template)}/clone", data)
        return OperationHandle({"upid": upid, "node": template.data["node"]})

    async def configure_instance(self, ref: ProviderRef, spec: InstanceSpec) -> None:
        """Synchronous PUT; safe to repeat. Sets every access/identity field explicitly:
        keys, user and IP replace the template's, and its password is removed."""
        data: dict[str, object] = {
            "cores": spec.vcpus,
            "sockets": 1,
            "memory": spec.memory_mb,
            "name": spec.name,
            "ciuser": spec.user,
            # PVE stores sshkeys URL-encoded (as `qm config` shows)
            "sshkeys": quote("\n".join(spec.ssh_keys), safe=""),
            "ipconfig0": mapper.ipconfig(spec.ipv4),
            "description": spec.description,
            "delete": "cipassword",
        }
        if spec.ipv4.dns:
            data["nameserver"] = " ".join(spec.ipv4.dns)
        if spec.tags:
            data["tags"] = ";".join(spec.tags)
        await self.client.put(f"{self._path(ref)}/config", data)

    async def grow_disk(self, ref: ProviderRef, template: ProviderRef, size_gb: int) -> None:
        disk = template.data.get("disk") or "scsi0"
        config = await self.client.get(f"{self._path(ref)}/config") or {}
        if mapper.disk_size_gb(str(config.get(disk, ""))) >= size_gb:
            return  # already there (or a repeated step); disks never shrink
        await self.client.put(f"{self._path(ref)}/resize", {"disk": disk, "size": f"{size_gb}G"})

    async def delete_instance(self, ref: ProviderRef) -> OperationHandle | None:
        try:
            upid = await self.client.delete(
                self._path(ref), {"purge": 1, "destroy-unreferenced-disks": 1}
            )
        except ProviderError as exc:
            if "does not exist" in str(exc):
                return None
            raise
        return OperationHandle({"upid": upid, "node": ref.data["node"]})

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
