"""instance.* job handlers."""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.compute.models import Instance
from app.images.models import Image
from app.inventory.models import ProviderCluster
from app.jobs.queue import JobContext, JobFailed, handler, on_failure
from app.providers.base import (
    CloudProvider,
    InstanceSpec,
    OperationHandle,
    PowerAction,
    PowerState,
    ProviderError,
    ProviderRef,
    StaticIPv4,
)


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
    )


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
        template = ProviderRef(image.provider_ref)
        spec = _spec(instance, ctx.job.payload)

        async with ctx.providers.open(db, cluster) as provider:
            # 1. guest id, committed before anything exists in the provider
            if "vmid" not in instance.provider_ref:
                ref = await _allocate_guest_id(db, cluster, provider, template.data["node"])
                instance.provider_ref = ref.data
                await ctx.checkpoint(db)
                await ctx.event("allocated", f"guest id {ref.key}")
            ref = ProviderRef(instance.provider_ref)

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
        instance = await db.get(Instance, ctx.job.resource_id)
        if instance is not None and instance.state == "deleting":
            instance.state = "error"
            await db.commit()
    finally:
        await db.close()
