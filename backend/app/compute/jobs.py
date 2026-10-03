"""instance.* job handlers."""

from collections.abc import Awaitable
from datetime import UTC, datetime
from typing import Any

import aiomysql
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.compute.models import Instance
from app.images.models import Image, ImageTemplate
from app.inventory.models import ProviderCluster
from app.ipam.models import IpamAddress
from app.ipam.service import source_for
from app.ipam.source import IpamSource
from app.jobs.queue import JobContext, JobFailed, RetryLater, handler, on_failure
from app.providers.base import (
    CloudProvider,
    InstanceSpec,
    NicSpec,
    OperationHandle,
    PowerAction,
    PowerState,
    ProviderError,
    ProviderRef,
    StaticIPv4,
)


async def _lock_fresh(db: AsyncSession, instance: Instance) -> None:
    """Re-read the row, locked, right before writing the outcome. Between reading it and
    now the job waited on the provider for seconds or minutes, and the reconciler may
    have refreshed the row meanwhile (a stale copy fails the version check)."""
    await db.refresh(instance, with_for_update=True)


@handler("instance.power")
async def instance_power(ctx: JobContext) -> dict[str, Any]:
    action = PowerAction(ctx.job.payload["action"])
    db = await ctx.session()
    try:
        instance = await db.get(Instance, ctx.job.resource_id)
        if instance is None or instance.deleted_at is not None or not instance.managed:
            raise JobFailed("NOT_FOUND", "instance no longer exists")
        cluster = await db.get_one(ProviderCluster, instance.cluster_id)
        ref = ProviderRef(instance.provider_ref)
        async with ctx.providers.open(db, cluster) as provider:
            # resume: if a previous attempt already started the provider task, wait for
            # that task instead of sending the command again
            recorded = await ctx.provider_task("power")
            if recorded is not None:
                op = OperationHandle(recorded)
            else:
                op = await provider.power(ref, action)
                await ctx.event(
                    "provider_task", f"{action.value} submitted", step="power", operation=op.data
                )
            result = await provider.wait(op)
            if not result.ok:
                raise JobFailed("PROVIDER_TASK_FAILED", result.message or "task failed")
            live = await provider.get_instance(ref)
        await _lock_fresh(db, instance)
        instance.power_state = live.power_state.value
        instance.last_seen_at = datetime.now(UTC)
        await db.commit()
        return {"power_state": instance.power_state}
    finally:
        await db.close()


# --- instance.create -------------------------------------------------------------------


def _spec(instance: Instance, payload: dict[str, Any]) -> InstanceSpec:
    net = instance.network
    return InstanceSpec(
        name=instance.name, vcpus=instance.vcpus, memory_mb=instance.memory_mb,
        disk_gb=instance.root_disk_gb, user=payload["user"],
        ssh_keys=tuple(payload["ssh_keys"]),
        ipv4=StaticIPv4(net["address"], net["gateway"], tuple(net.get("dns", []))),
        tags=("cm-managed", f"cm-t-{str(instance.tenant_id)[:8]}"),
        description=f"managed-by: cloud-manager / instance: {instance.id}",
        nic=(
            NicSpec(net.get("mac"), net.get("bridge"), net.get("vlan"))
            if any(net.get(k) for k in ("mac", "bridge", "vlan")) else None
        ),
    )


# --- IPAM (legacy MySQL awf_ip_pool; ADR-0014) ------------------------------------------


def _ipam_source(ctx: JobContext) -> IpamSource:
    source = source_for(ctx.providers.settings)
    if source is None:
        raise JobFailed("IPAM_NOT_CONFIGURED", "the address comes from the IPAM, which is off")
    return source


async def _ipam_call(coro: Awaitable[bool]) -> bool:
    try:
        return await coro
    except (aiomysql.Error, OSError) as exc:  # MySQL unreachable: try again later
        raise RetryLater(f"IPAM: {exc}") from exc


async def _mirror(db: AsyncSession, external_id: int, **values: Any) -> None:
    """Keep the local copy in step until the next sync confirms it."""
    row = await db.scalar(select(IpamAddress).where(IpamAddress.external_id == external_id))
    if row is not None:
        for key, value in values.items():
            setattr(row, key, value)


async def _ipam_reserve(ctx: JobContext, db: AsyncSession, instance: Instance) -> None:
    ipam = instance.network.get("ipam")
    if not ipam or await ctx.events("ip_reserved"):
        return
    ok = await _ipam_call(
        _ipam_source(ctx).reserve(ipam["external_id"], hostname=instance.name, mac=None)
    )
    if not ok:
        raise JobFailed("IP_TAKEN", f"IP {instance.ipv4} was taken in the IPAM meanwhile")
    await _mirror(db, ipam["external_id"], assigned=True, hostname=instance.name)
    await ctx.checkpoint(db)
    await ctx.event("ip_reserved", f"IP {instance.ipv4} reserved in the IPAM")


async def _ipam_record_mac(
    ctx: JobContext, provider: CloudProvider, ref: ProviderRef, instance: Instance
) -> None:
    """A row without a pre-assigned MAC learns the one the guest got (best effort)."""
    ipam = instance.network.get("ipam")
    if not ipam or ipam.get("mac_preassigned"):
        return
    nics = await provider.guest_nics(ref)
    mac = nics[0].mac if nics else None
    if mac:
        await _ipam_call(
            _ipam_source(ctx).set_mac(ipam["external_id"], hostname=instance.name, mac=mac)
        )


async def _ipam_release(ctx: JobContext, db: AsyncSession, instance: Instance) -> None:
    ipam = instance.network.get("ipam")
    if not ipam:
        return
    released = await _ipam_call(_ipam_source(ctx).release(
        ipam["external_id"], hostname=instance.name, clear_mac=not ipam.get("mac_preassigned"),
    ))
    if released:
        await _mirror(db, ipam["external_id"], assigned=False, hostname=None)
        await ctx.event("ip_released", f"IP {instance.ipv4} released in the IPAM")
    else:  # someone else changed the row since: leave it to them
        await ctx.event("ip_not_released", f"IP {instance.ipv4} no longer carries this name")


async def _allocate_guest_id(
    db: AsyncSession, cluster: ProviderCluster, provider: CloudProvider, node: str
) -> ProviderRef:
    """Lowest free id in the cluster's reserved range: not used by any live instance we
    know of, and free in the provider itself (it also sees guests our token cannot)."""
    key = int.from_bytes(cluster.id.bytes[8:], "big", signed=True)
    await db.execute(select(func.pg_advisory_xact_lock(key)))
    used = {
        int(v)
        for v in (
            await db.execute(
                select(Instance.provider_ref["vmid"].astext).where(
                    Instance.cluster_id == cluster.id,
                    Instance.deleted_at.is_(None),
                    Instance.provider_ref.has_key("vmid"),
                )
            )
        ).scalars()
    }
    vmid_range = cluster.settings.get("vmid_range") or {"start": 10_000, "end": 19_999}
    pool = cluster.settings["pool"]
    for vmid in range(int(vmid_range["start"]), int(vmid_range["end"]) + 1):
        if vmid in used:
            continue
        ref = ProviderRef({"vmid": vmid, "node": node, "type": "qemu", "pool": pool})
        if await provider.slot_available(ref):
            return ref
    raise JobFailed("NO_CAPACITY", "no free guest id left in the cluster's reserved range")


@handler("instance.create")
async def instance_create(ctx: JobContext) -> dict[str, Any]:
    db = await ctx.session()
    try:
        instance = await db.get(Instance, ctx.job.resource_id)
        if instance is None or instance.deleted_at is not None:
            raise JobFailed("NOT_FOUND", "instance no longer exists")
        image = await db.get(Image, instance.image_id) if instance.image_id else None
        if image is None:
            raise JobFailed("IMAGE_NOT_FOUND", "the image no longer exists")
        cluster = await db.get_one(ProviderCluster, instance.cluster_id)
        if not cluster.settings.get("pool"):
            raise JobFailed("CLUSTER_NOT_READY", "cluster has no target pool")
        image_template = await db.scalar(
            select(ImageTemplate).where(
                ImageTemplate.image_id == image.id, ImageTemplate.cluster_id == cluster.id
            )
        )
        if image_template is None:
            raise JobFailed("IMAGE_NOT_FOUND", "the image has no template on the chosen server")
        template = ProviderRef(image_template.provider_ref)
        spec = _spec(instance, ctx.job.payload)

        async with ctx.providers.open(db, cluster) as provider:
            # 1. guest id, committed before anything exists in the provider
            if "vmid" not in instance.provider_ref:
                ref = await _allocate_guest_id(db, cluster, provider, template.data["node"])
                instance.provider_ref = ref.data
                instance.provider_pool = ref.data["pool"]  # created inside the managed pool
                await ctx.checkpoint(db)
                await ctx.event("allocated", f"guest id {ref.key}")
            ref = ProviderRef(instance.provider_ref)
            # 1b. the address, before anything exists that would use it
            await _ipam_reserve(ctx, db, instance)

            # 2. clone (resumable: wait for a recorded task instead of cloning twice)
            recorded = await ctx.provider_task("clone")
            if recorded is None:
                op = await provider.clone_template(template, ref, spec)
                await ctx.event("provider_task", "clone submitted", step="clone", operation=op.data)
            else:
                op = OperationHandle(recorded)
            result = await provider.wait(op)
            if not result.ok:
                raise JobFailed("PROVIDER_TASK_FAILED", f"clone: {result.message}")

            # 3-4. identity/access and size: idempotent, safe to repeat on resume
            await provider.configure_instance(ref, spec)
            await provider.grow_disk(ref, template, instance.root_disk_gb)
            await _ipam_record_mac(ctx, provider, ref, instance)
            await ctx.event("configured")

            # 5. start
            recorded = await ctx.provider_task("start")
            if recorded is None:
                op = await provider.power(ref, PowerAction.START)
                await ctx.event("provider_task", "start submitted", step="start", operation=op.data)
            else:
                op = OperationHandle(recorded)
            result = await provider.wait(op)
            if not result.ok:
                raise JobFailed("PROVIDER_TASK_FAILED", f"start: {result.message}")
            live = await provider.get_instance(ref)

        await _lock_fresh(db, instance)
        instance.state, instance.power_state = "active", live.power_state.value
        instance.last_seen_at = datetime.now(UTC)
        await audit.record(
            db, "INSTANCE_CREATED", actor_user_id=ctx.job.requested_by,
            tenant_id=instance.tenant_id, resource_type="instance", resource_id=instance.id,
        )
        await db.commit()
        return {"power_state": instance.power_state}
    finally:
        await db.close()


@on_failure("instance.create")
async def instance_create_failed(ctx: JobContext, code: str, message: str) -> None:
    """Undo a half-created instance: destroy the guest (if any), then free quota and IP
    by retiring the row. If destroying fails, the guest shows up as discovered for an
    admin to handle — never silently kept as a tenant resource."""
    db = await ctx.session()
    try:
        instance = await db.get(Instance, ctx.job.resource_id)
        if instance is None or instance.deleted_at is not None:
            return
        if "vmid" in instance.provider_ref:
            cluster = await db.get_one(ProviderCluster, instance.cluster_id)
            ref = ProviderRef(instance.provider_ref)
            try:
                async with ctx.providers.open(db, cluster) as provider:
                    await _destroy(provider, ref, instance.provider_name)
                await ctx.event("compensated", "partially created guest destroyed")
            except (ProviderError, JobFailed) as exc:
                await ctx.event("compensation_failed", str(exc))
        if await ctx.events("ip_reserved"):
            try:
                await _ipam_release(ctx, db, instance)
            except (RetryLater, JobFailed) as exc:
                await ctx.event("compensation_failed", f"IP not released: {exc}")
        await _lock_fresh(db, instance)
        instance.state, instance.deleted_at = "error", datetime.now(UTC)
        await audit.record(
            db, "INSTANCE_CREATE_FAILED", outcome="failure",
            actor_user_id=ctx.job.requested_by, tenant_id=instance.tenant_id,
            resource_type="instance", resource_id=instance.id,
            details={"code": code, "message": message[:500]},
        )
        await db.commit()
    finally:
        await db.close()


# --- instance.delete -------------------------------------------------------------------


async def _destroy(provider: CloudProvider, ref: ProviderRef, expected_name: str) -> None:
    """Stop (hard) if needed, then delete with disks. A guest that is already gone counts
    as deleted. Refuses when the guest at that id is not the one we expect: deleting by
    id alone could destroy somebody else's VM."""
    try:
        live = await provider.get_instance(ref)
    except ProviderError as exc:
        if "does not exist" in str(exc):
            return
        raise
    if live.name != expected_name:
        raise JobFailed(
            "GUEST_MISMATCH",
            f"guest {ref.key} is named {live.name!r}, expected {expected_name!r}: not deleting",
        )
    if live.power_state is not PowerState.STOPPED:
        result = await provider.wait(await provider.power(ref, PowerAction.STOP))
        if not result.ok:
            raise JobFailed("PROVIDER_TASK_FAILED", f"stop: {result.message}")
    op = await provider.delete_instance(ref)
    if op is not None:
        result = await provider.wait(op)
        if not result.ok:
            raise JobFailed("PROVIDER_TASK_FAILED", f"delete: {result.message}")


@handler("instance.delete")
async def instance_delete(ctx: JobContext) -> dict[str, Any]:
    db = await ctx.session()
    try:
        instance = await db.get(Instance, ctx.job.resource_id)
        if instance is None or instance.deleted_at is not None:
            return {"state": "deleted"}
        if "vmid" in instance.provider_ref:
            cluster = await db.get_one(ProviderCluster, instance.cluster_id)
            async with ctx.providers.open(db, cluster) as provider:
                await _destroy(provider, ProviderRef(instance.provider_ref), instance.provider_name)
        await _ipam_release(ctx, db, instance)
        await _lock_fresh(db, instance)
        instance.state, instance.deleted_at = "deleted", datetime.now(UTC)
        instance.power_state = PowerState.UNKNOWN.value
        await audit.record(
            db, "INSTANCE_DELETED", actor_user_id=ctx.job.requested_by,
            tenant_id=instance.tenant_id, resource_type="instance", resource_id=instance.id,
        )
        await db.commit()
        return {"state": "deleted"}
    finally:
        await db.close()


@on_failure("instance.delete")
async def instance_delete_failed(ctx: JobContext, code: str, message: str) -> None:
    # back to a state from which the user can retry the deletion
    db = await ctx.session()
    try:
        instance = await db.get(Instance, ctx.job.resource_id, with_for_update=True)
        if instance is not None and instance.state == "deleting":
            instance.state = "error"
            await db.commit()
    finally:
        await db.close()
