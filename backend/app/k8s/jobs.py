"""k8s.create / k8s.delete (ADR-0018).

k8s.create advances through PHASES, recording `phase_done` events; each run does what it
can within its time budget and reschedules itself (Reschedule: no attempt spent), so a
cluster that takes 15 minutes never holds a job past the queue lease. Waiting for the
node VMs, which have their own instance.create jobs, works the same way.

On a final failure the cluster goes to `error` with the reason and the VMs stay for
diagnosis; deleting the cluster removes them.
"""

import asyncio
import base64
from collections.abc import Awaitable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.compute.jobs import _ipam_call, _ipam_source, _mirror
from app.compute.models import Instance
from app.inventory.models import ProviderCluster
from app.jobs.models import Job
from app.jobs.queue import JobContext, JobFailed, Reschedule, enqueue, handler, on_failure
from app.k8s.agent import StepRunner
from app.k8s.bundle import command
from app.k8s.models import K8sCluster, K8sNodePool
from app.k8s.sync import apply_kubeconfig
from app.providers.base import CloudProvider, GuestAgentUnavailable, ProviderRef

CREATE_DEADLINE = timedelta(minutes=90)
PHASES = ("lb_ip", "vms", "agent", "prepare", "init", "join", "addons", "kubeconfig")


async def _cluster(db: AsyncSession, ctx: JobContext) -> K8sCluster:
    cluster = await db.get(K8sCluster, ctx.job.resource_id, populate_existing=True)
    if cluster is None:
        raise JobFailed("NOT_FOUND", "the cluster no longer exists")
    return cluster


async def _nodes(db: AsyncSession, cluster: K8sCluster) -> tuple[Instance, list[Instance]]:
    """(first control plane, workers), live nodes only, in name order."""
    rows = (await db.execute(
        select(Instance, K8sNodePool.role)
        .join(K8sNodePool, K8sNodePool.id == Instance.k8s_pool_id)
        .where(Instance.k8s_cluster_id == cluster.id, Instance.deleted_at.is_(None))
        .order_by(Instance.name)
    )).all()
    cps = [i for i, role in rows if role == "control-plane"]
    if not cps:
        raise JobFailed("K8S_NO_CONTROL_PLANE", "the control-plane VM is gone")
    return cps[0], [i for i, role in rows if role == "worker"]


async def _gather(*aws: Awaitable[Any]) -> None:
    """Runs steps on several nodes at once; all of them finish (or reschedule) before the
    first failure is raised, so no started command is left unrecorded."""
    results = await asyncio.gather(*aws, return_exceptions=True)
    errors = [r for r in results if isinstance(r, BaseException)]
    for kind in (JobFailed, Reschedule):
        for err in errors:
            if isinstance(err, kind):
                raise err
    if errors:
        raise errors[0]


# --- k8s.create --------------------------------------------------------------------------


@handler("k8s.create")
async def create_cluster(ctx: JobContext) -> dict[str, Any]:
    db = await ctx.session()
    try:
        cluster = await _cluster(db, ctx)
        if cluster.state != "provisioning":
            raise JobFailed("K8S_STATE", f"the cluster is {cluster.state}")
        if datetime.now(UTC) - cluster.created_at > CREATE_DEADLINE:
            raise JobFailed("K8S_TIMEOUT", "the cluster took too long to be created")
        done = {e.data.get("phase") for e in await ctx.events("phase_done")}
        server = await db.get_one(ProviderCluster, cluster.provider_cluster_id)
        async with ctx.providers.open(db, server) as provider:
            steps = _Create(ctx, db, cluster, provider)
            for phase in PHASES:
                if phase in done:
                    continue
                if cluster.state_message != phase:
                    cluster.state_message = phase
                    await ctx.checkpoint(db)
                    cluster = await _cluster(db, ctx)
                    steps.cluster = cluster
                await getattr(steps, phase)()
                await ctx.event("phase_done", phase, phase=phase)
        cluster.state, cluster.state_message = "active", None
        await audit.record(
            db, "K8S_CLUSTER_CREATED", actor_user_id=ctx.job.requested_by,
            tenant_id=cluster.tenant_id, resource_type="k8s_cluster", resource_id=cluster.id,
            details={"name": cluster.name, "kubernetes_version": cluster.kubernetes_version,
                     "job_id": str(ctx.job.id)},
        )
        await db.commit()
        return {"cluster_id": str(cluster.id), "server": cluster.server_url}
    finally:
        await db.close()


class _Create:
    def __init__(
        self, ctx: JobContext, db: AsyncSession, cluster: K8sCluster, provider: CloudProvider
    ) -> None:
        self.ctx, self.db, self.cluster, self.provider = ctx, db, cluster, provider
        self.runner = StepRunner(ctx, provider)

    async def lb_ip(self) -> None:
        ipam = (self.cluster.spec.get("lb") or {}).get("ipam")
        if not ipam:
            return
        ok = await _ipam_call(_ipam_source(self.ctx).reserve(
            ipam["external_id"], hostname=f"{self.cluster.name}-lb", mac=None
        ))
        if not ok:
            raise JobFailed("IP_TAKEN", "the load balancer IP was taken in the IPAM meanwhile")
        await _mirror(self.db, ipam["external_id"], assigned=True,
                      hostname=f"{self.cluster.name}-lb")
        await self.ctx.checkpoint(self.db)

    async def vms(self) -> None:
        """Each node VM has its own instance.create job; wait for all of them."""
        rows = (await self.db.execute(
            select(Instance).where(Instance.k8s_cluster_id == self.cluster.id)
        )).scalars().all()
        failed = [i.name for i in rows if i.state == "error" or i.deleted_at is not None]
        if failed:
            raise JobFailed("K8S_NODE_FAILED", f"node VM failed: {', '.join(sorted(failed))}")
        if any(i.state != "active" for i in rows):
            raise Reschedule(15, "waiting for the node VMs")

    async def agent(self) -> None:
        cp, workers = await _nodes(self.db, self.cluster)
        for node in (cp, *workers):
            try:
                await self.provider.guest_ping(ProviderRef(node.provider_ref))
            except GuestAgentUnavailable:
                raise Reschedule(10, f"waiting for the guest agent of {node.name}") from None

    async def prepare(self) -> None:
        cp, workers = await _nodes(self.db, self.cluster)
        argv = command("prepare-node", {
            "K8S_VERSION": self.cluster.kubernetes_version or "", "PULL_IMAGES": "0",
        })
        await _gather(*(self.runner.run("prepare", n, argv) for n in (cp, *workers)))

    async def init(self) -> None:
        cp, _ = await _nodes(self.db, self.cluster)
        spec = self.cluster.spec
        await self.runner.run("init", cp, command("init-control-plane", {
            "NODE_NAME": cp.name, "NODE_IP": str(cp.ipv4), "ENDPOINT": spec["api_endpoint"],
            "CLUSTER_NAME": self.cluster.name,
            "K8S_VERSION": self.cluster.kubernetes_version or "",
            "POD_CIDR": spec["pod_cidr"], "SERVICE_CIDR": spec["service_cidr"],
        }))

    async def join(self) -> None:
        cp, workers = await _nodes(self.db, self.cluster)
        pending = [w for w in workers if not await self.runner.done("join", w)]
        if not pending:
            return
        # a secret: fetched only when some join still has to start, never recorded
        join_command = None
        started = {w.id: await self.runner.pid("join", w) is not None for w in pending}
        if not all(started.values()):
            join_command = (await self.runner.output(cp, command("join-command"))).strip()

        async def one(node: Instance) -> None:
            fresh = not started[node.id]
            await self.runner.run(
                "join", node, command("join-node", {"NODE_NAME": node.name}),
                stdin=f"{join_command}\n" if fresh and join_command else None, secret=True,
            )

        await _gather(*(one(w) for w in pending))

    async def addons(self) -> None:
        cp, _ = await _nodes(self.db, self.cluster)
        spec, versions = self.cluster.spec, self.cluster.spec["components"]
        settings = self.ctx.providers.settings
        await self.runner.run("addons", cp, command("install-addons", {
            "API_HOST": spec["api_endpoint"], "POD_CIDR": spec["pod_cidr"],
            "LB_IP": spec["lb"]["ip"],
            "ACME_EMAIL": settings.k8s_acme_email,
            "GATEWAY_API_VERSION": versions["gateway_api"], "CILIUM_VERSION": versions["cilium"],
            "METALLB_VERSION": versions["metallb"],
            "CERT_MANAGER_VERSION": versions["cert_manager"],
            "LOCAL_PATH_VERSION": versions["local_path"],
        }))

    async def kubeconfig(self) -> None:
        cp, _ = await _nodes(self.db, self.cluster)
        text = await self.runner.output(cp, ["cat", "/etc/kubernetes/admin.conf"])
        apply_kubeconfig(self.cluster, base64.b64encode(text.encode()).decode(),
                         self.ctx.providers.secrets)
        if self.cluster.kubeconfig_error:
            raise JobFailed("K8S_KUBECONFIG", self.cluster.kubeconfig_error)
        self.cluster.api_server = self.cluster.server_url
        self.cluster.synced_at = datetime.now(UTC)
        await self.ctx.checkpoint(self.db)


@on_failure("k8s.create")
async def create_failed(ctx: JobContext, code: str, message: str) -> None:
    db = await ctx.session()
    try:
        cluster = await db.get(K8sCluster, ctx.job.resource_id)
        if cluster is not None and cluster.state == "provisioning":
            cluster.state, cluster.state_message = "error", f"{code}: {message}"[:1000]
            await audit.record(
                db, "K8S_CLUSTER_CREATED", outcome="failure",
                actor_user_id=ctx.job.requested_by, tenant_id=cluster.tenant_id,
                resource_type="k8s_cluster", resource_id=cluster.id,
                details={"name": cluster.name, "error_code": code, "job_id": str(ctx.job.id)},
            )
        await db.commit()
    finally:
        await db.close()


# --- k8s.delete --------------------------------------------------------------------------


@handler("k8s.delete")
async def delete_cluster(ctx: JobContext) -> dict[str, Any]:
    db = await ctx.session()
    try:
        cluster = await _cluster(db, ctx)
        nodes = (await db.execute(
            select(Instance).where(
                Instance.k8s_cluster_id == cluster.id, Instance.deleted_at.is_(None)
            )
        )).scalars().all()
        waiting = False
        for node in nodes:
            jobs = (await db.execute(
                select(Job).where(Job.resource_id == node.id).order_by(Job.created_at)
            )).scalars().all()
            if any(j.status in ("pending", "running") for j in jobs):
                waiting = True  # its create (or our delete) is still running
                continue
            failed = [j for j in jobs if j.type == "instance.delete" and j.status == "failed"]
            if len(failed) >= 2:
                raise JobFailed("K8S_NODE_DELETE_FAILED", f"could not delete {node.name}")
            if node.state in ("active", "error", "deleting"):
                node.state = "deleting"
                await enqueue(
                    db, "instance.delete", tenant_id=node.tenant_id, project_id=node.project_id,
                    requested_by=ctx.job.requested_by, resource_type="instance",
                    resource_id=node.id, payload={"k8s_cluster": cluster.name},
                )
            waiting = True
        if waiting:
            await ctx.checkpoint(db)
            raise Reschedule(10, "waiting for the node VMs to be deleted")

        ipam = (cluster.spec.get("lb") or {}).get("ipam")
        if ipam and not await ctx.events("lb_released"):
            await _ipam_call(_ipam_source(ctx).release(
                ipam["external_id"], hostname=f"{cluster.name}-lb", clear_mac=False,
            ))
            await _mirror(db, ipam["external_id"], assigned=False, hostname=None)
            await ctx.event("lb_released", "load balancer IP released in the IPAM")
        await audit.record(
            db, "K8S_CLUSTER_DELETED", actor_user_id=ctx.job.requested_by,
            tenant_id=cluster.tenant_id, resource_type="k8s_cluster", resource_id=cluster.id,
            details={"name": cluster.name, "job_id": str(ctx.job.id)},
        )
        await db.delete(cluster)
        await db.commit()
        return {"deleted": cluster.name}
    finally:
        await db.close()


@on_failure("k8s.delete")
async def delete_failed(ctx: JobContext, code: str, message: str) -> None:
    db = await ctx.session()
    try:
        cluster = await db.get(K8sCluster, ctx.job.resource_id)
        if cluster is not None:
            cluster.state, cluster.state_message = "error", f"{code}: {message}"[:1000]
        await db.commit()
    finally:
        await db.close()

