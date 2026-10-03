"""cluster.* job handlers."""

from typing import Any

from app.inventory.models import ProviderCluster
from app.inventory.reconciler import reconcile
from app.jobs.queue import JobContext, JobFailed, handler


@handler("cluster.sync")
async def cluster_sync(ctx: JobContext) -> dict[str, Any]:
    db = await ctx.session()
    try:
        cluster = await db.get(ProviderCluster, ctx.job.resource_id)
        if cluster is None:
            raise JobFailed("NOT_FOUND", "cluster no longer exists")
        async with ctx.providers.open(db, cluster) as provider:
            run = await reconcile(db, cluster, provider, trigger="manual")
        await db.commit()
    finally:
        await db.close()
    if run.status != "succeeded":
        raise JobFailed("PROVIDER_UNAVAILABLE", run.error or "sync failed")
    return {"sync_run_id": str(run.id), "stats": run.stats}
