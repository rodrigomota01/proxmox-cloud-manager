"""instance.* job handlers."""

from datetime import UTC, datetime
from typing import Any

from app.compute.models import Instance
from app.inventory.models import ProviderCluster
from app.jobs.queue import JobContext, JobFailed, handler
from app.providers.base import OperationHandle, PowerAction, ProviderRef


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
            tasks = await ctx.events("provider_task")
            if tasks:
                op = OperationHandle(tasks[-1].data["operation"])
            else:
                op = await provider.power(ref, action)
                await ctx.event("provider_task", f"{action.value} submitted", operation=op.data)
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
