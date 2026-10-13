"""Creating and deleting Kubernetes clusters on the platform's VMs (ADR-0018).

The request is validated and committed in one transaction: quota for every node at once,
the cluster and its pools, one Instance per node (each with its own instance.create job,
the same path as any VM) and the k8s.create job that installs Kubernetes on them.

k8s_clusters and k8s_node_pools are platform tables (RLS): after the caller has been
authorized, the rows are written with the platform scope switched on for those
statements only (`_platform`).
"""

import ipaddress
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import TenantContext
from app.audit import service as audit
from app.compute.models import Instance
from app.compute.service import ComputeService
from app.core.config import Settings
from app.core.errors import Conflict, NotFound, ValidationError
from app.core.ids import uuid7
from app.iam.authz import Scope, authorize
from app.iam.service import live_project
from app.images.models import Image
from app.infra.secrets import Sealed, SecretsBackend, unseal
from app.inventory.models import ProviderCluster
from app.jobs.models import Job
from app.jobs.queue import enqueue
from app.k8s.bundle import BUNDLE
from app.k8s.models import K8sCluster, K8sNodePool
from app.k8s.schemas import K8sIpamNetwork, K8sProvision, K8sStaticNetwork
from app.sshkeys.models import SshPublicKey
from app.tenancy import quota

DEFAULT_DNS = ["8.8.8.8", "1.1.1.1"]


@asynccontextmanager
async def _platform(db: AsyncSession) -> AsyncIterator[None]:
    """Platform scope for the statements inside, then back to what it was (an admin
    request is already platform-scoped; a tenant request is not)."""
    previous = await db.scalar(text("SELECT current_setting('app.platform_scope', true)"))
    await db.execute(text("SELECT set_config('app.platform_scope', 'on', true)"))
    try:
        yield
    finally:
        await db.execute(
            text("SELECT set_config('app.platform_scope', :v, true)"), {"v": previous or ""}
        )


def _invalid(field: str, message: str) -> ValidationError:
    return ValidationError(errors=[{"field": field, "message": message}])


class K8sProvisioner:
    def __init__(
        self, db: AsyncSession, ctx: TenantContext, settings: Settings, *, admin: bool = False
    ) -> None:
        """admin=True: a platform admin (cluster:manage) acting for the tenant."""
        self.db, self.ctx, self.settings, self.admin = db, ctx, settings, admin

    @property
    def actor(self) -> uuid.UUID:
        return self.ctx.principal.user_id

    async def _authorize(self, permission: str, project_id: uuid.UUID) -> None:
        if not self.admin:
            await authorize(self.db, self.actor, permission, Scope(self.ctx.tenant_id, project_id))

    # --- create --------------------------------------------------------------------------

    async def create(
        self, body: K8sProvision, idempotency_key: str | None
    ) -> tuple[K8sCluster, Job]:
        tenant_id = self.ctx.tenant_id
        await live_project(self.db, tenant_id, body.project_id)
        await self._authorize("k8s:create", body.project_id)

        image = await self.db.scalar(select(Image).where(
            Image.id == body.image_id, Image.active, Image.kubernetes_version.is_not(None),
            (Image.tenant_id.is_(None)) | (Image.tenant_id == tenant_id),
        ))
        if image is None:
            raise _invalid("image_id", "unknown Kubernetes image")
        sizes = [("control_plane", body.control_plane.disk_gb)] + [
            (f"workers.{p.name}", p.disk_gb) for p in body.workers
        ]
        for field, disk in sizes:
            if disk < image.min_disk_gb:
                raise _invalid(field, f"the image needs at least {image.min_disk_gb} GB")

        compute = ComputeService(self.db, self.ctx, self.settings)
        server, node_networks, lb = await self._networks(compute, body, image)

        keys = (await self.db.execute(select(SshPublicKey).where(
            SshPublicKey.id.in_(body.ssh_key_ids), SshPublicKey.user_id == self.actor,
        ))).scalars().all()
        if len(keys) != len(set(body.ssh_key_ids)):
            raise _invalid("ssh_key_ids", "unknown key")

        plan = [("cp", "control-plane", 1, body.control_plane)] + [
            (p.name, "worker", p.count, p) for p in body.workers
        ]
        await quota.reserve(self.db, tenant_id, self.settings, {
            "instances": sum(n for _, _, n, _ in plan),
            "vcpus": sum(n * s.vcpus for _, _, n, s in plan),
            "memory_mb": sum(n * s.memory_mb for _, _, n, s in plan),
            "storage_gb": sum(n * s.disk_gb for _, _, n, s in plan),
        })

        cluster = K8sCluster(
            id=uuid7(), name=body.name, source="managed", state="provisioning",
            state_message="queued", tenant_id=tenant_id, project_id=body.project_id,
            provider_cluster_id=server.id, image_id=image.id,
            kubernetes_version=image.kubernetes_version, created_by=self.actor,
            synced_at=datetime.now(UTC), nodes=[],
            spec={
                "api_endpoint": node_networks[0]["address"].split("/")[0],
                "lb": lb, "pod_cidr": BUNDLE.pod_cidr, "service_cidr": BUNDLE.service_cidr,
                "components": BUNDLE.versions(),
            },
        )
        pools: list[tuple[K8sNodePool, int]] = []
        async with _platform(self.db):
            if await self.db.scalar(select(K8sCluster.id).where(K8sCluster.name == body.name)):
                raise Conflict(f"A Kubernetes cluster named '{body.name}' already exists")
            self.db.add(cluster)
            for name, role, count, size in plan:
                pool = K8sNodePool(
                    id=uuid7(), k8s_cluster_id=cluster.id, name=name, role=role, count=count,
                    vcpus=size.vcpus, memory_mb=size.memory_mb, disk_gb=size.disk_gb,
                )
                self.db.add(pool)
                pools.append((pool, count))
            await self.db.flush()

        nodes: list[Instance] = []
        networks = iter(node_networks)
        for pool, count in pools:
            for i in range(1, count + 1):
                network = next(networks)
                node_name = f"{body.name}-{pool.name}-{i}"
                nodes.append(Instance(
                    tenant_id=tenant_id, project_id=body.project_id, cluster_id=server.id,
                    kind="vm", name=node_name, provider_name=node_name, state="provisioning",
                    power_state="stopped", vcpus=pool.vcpus, memory_mb=pool.memory_mb,
                    root_disk_gb=pool.disk_gb, tags=["k8s", f"k8s-{body.name}"], managed=True,
                    image_id=image.id, ipv4=network["address"].split("/")[0],
                    network=network, provider_ref={}, k8s_cluster_id=cluster.id,
                    k8s_pool_id=pool.id,
                ))
        try:
            async with self.db.begin_nested():
                self.db.add_all(nodes)
        except IntegrityError as exc:
            raise Conflict("One of the node IPs is already used by another instance") from exc

        payload = {"ssh_keys": [k.public_key for k in keys], "user": image.default_user}
        for node in nodes:
            await enqueue(
                self.db, "instance.create", tenant_id=tenant_id, project_id=body.project_id,
                requested_by=self.actor, resource_type="instance", resource_id=node.id,
                payload=payload,
            )
        job = await enqueue(
            self.db, "k8s.create", tenant_id=tenant_id, project_id=body.project_id,
            requested_by=self.actor, resource_type="k8s_cluster", resource_id=cluster.id,
            payload={"name": body.name}, idempotency_key=idempotency_key,
        )
        await audit.record(
            self.db, "K8S_CLUSTER_CREATE_REQUESTED", actor_user_id=self.actor,
            tenant_id=tenant_id, resource_type="k8s_cluster", resource_id=cluster.id,
            details={
                "name": body.name, "image_id": str(image.id),
                "kubernetes_version": image.kubernetes_version, "job_id": str(job.id),
                "pools": [{"name": p.name, "role": p.role, "count": n, "vcpus": p.vcpus,
                           "memory_mb": p.memory_mb, "disk_gb": p.disk_gb} for p, n in pools],
                "nodes": [n.network["address"] for n in nodes], "lb_ip": lb["ip"],
                "by_platform_admin": self.admin,
            },
        )
        return cluster, job

    async def _networks(
        self, compute: ComputeService, body: K8sProvision, image: Image
    ) -> tuple[ProviderCluster, list[dict[str, Any]], dict[str, Any]]:
        """The server, one network config per node (control plane first) and the load
        balancer address. Everything must sit in one subnet: MetalLB announces the
        address over L2 from the nodes."""
        net = body.network
        if isinstance(net, K8sIpamNetwork):
            ids = [*net.node_address_ids, net.lb_address_id]
            if len(set(ids)) != len(ids):
                raise _invalid("network", "the same address was chosen twice")
            offers = [await compute._ipam_offer(i, image, body.zone_id) for i in ids]
            servers = {o.address.cluster_id for o in offers}
            subnets = {ipaddress.ip_interface(o.cidr).network for o in offers}
            if len(servers) != 1 or len(subnets) != 1:
                raise _invalid("network", "all addresses must be in the same network and server")
            server = await self.db.get_one(ProviderCluster, servers.pop())
            dns = net.dns or DEFAULT_DNS
            lb_offer = offers[-1]
            lb = {"ip": str(lb_offer.address.address),
                  "ipam": {"external_id": lb_offer.address.external_id}}
            return server, [o.network(dns) for o in offers[:-1]], lb

        assert isinstance(net, K8sStaticNetwork)
        if (net.bridge or net.vlan) and not self.admin:
            raise _invalid("network", "only platform admins choose the bridge or VLAN")
        ifaces = [ipaddress.IPv4Interface(n.address) for n in net.node_ipv4]
        subnet = ifaces[0].network
        gateways = {n.gateway for n in net.node_ipv4}
        if any(i.network != subnet for i in ifaces) or len(gateways) != 1:
            raise _invalid("network", "all nodes must be in the same subnet with one gateway")
        try:
            lb_ip = ipaddress.IPv4Address(net.lb_ip)
        except ValueError:
            raise _invalid("network.lb_ip", "invalid IPv4") from None
        taken = {i.ip for i in ifaces} | {ipaddress.IPv4Address(gateways.copy().pop())}
        if (lb_ip not in subnet or lb_ip in taken
                or lb_ip in (subnet.network_address, subnet.broadcast_address)):
            raise _invalid("network.lb_ip", "must be a free address in the nodes' subnet")
        if len({i.ip for i in ifaces}) != len(ifaces):
            raise _invalid("network", "the same address was typed twice")
        server = await compute._place(image, body.zone_id)
        networks = [
            {"address": n.address, "gateway": n.gateway, "dns": n.dns or DEFAULT_DNS,
             "bridge": net.bridge, "vlan": net.vlan}
            for n in net.node_ipv4
        ]
        return server, networks, {"ip": str(lb_ip), "ipam": None}

    # --- delete / kubeconfig -------------------------------------------------------------

    async def _load(self, cluster_id: uuid.UUID) -> K8sCluster:
        async with _platform(self.db):
            cluster = await self.db.get(K8sCluster, cluster_id)
        if cluster is None or cluster.tenant_id != self.ctx.tenant_id:
            raise NotFound()
        if cluster.source != "managed" or cluster.project_id is None:
            raise Conflict("This cluster was not created by the platform")
        return cluster

    async def delete(self, cluster_id: uuid.UUID, confirm: str, idempotency_key: str | None) -> Job:
        cluster = await self._load(cluster_id)
        await self._authorize("k8s:delete", cluster.project_id)  # type: ignore[arg-type]
        if confirm != cluster.name:
            raise _invalid("confirm", "type the cluster name to confirm")
        if cluster.state not in ("active", "error"):
            raise Conflict(f"The cluster is {cluster.state}: wait for it to finish")
        async with _platform(self.db):
            cluster.state, cluster.state_message = "deleting", "queued"
            await self.db.flush()
        job = await enqueue(
            self.db, "k8s.delete", tenant_id=cluster.tenant_id, project_id=cluster.project_id,
            requested_by=self.actor, resource_type="k8s_cluster", resource_id=cluster.id,
            payload={"name": cluster.name}, idempotency_key=idempotency_key,
        )
        await audit.record(
            self.db, "K8S_CLUSTER_DELETE_REQUESTED", actor_user_id=self.actor,
            tenant_id=cluster.tenant_id, resource_type="k8s_cluster", resource_id=cluster.id,
            details={"name": cluster.name, "job_id": str(job.id),
                     "by_platform_admin": self.admin},
        )
        return job

    async def kubeconfig(self, cluster_id: uuid.UUID, secrets: SecretsBackend) -> tuple[str, str]:
        """(name, admin kubeconfig) for the client's own clusters; audited."""
        cluster = await self._load(cluster_id)
        await self._authorize("k8s:admin", cluster.project_id)  # type: ignore[arg-type]
        if cluster.kubeconfig_ciphertext is None or cluster.dek_wrapped is None:
            raise Conflict("The cluster has no kubeconfig yet")
        kubeconfig = unseal(
            secrets, Sealed(cluster.kubeconfig_ciphertext, cluster.dek_wrapped,
                            cluster.kek_ref or ""), aad=cluster.id.bytes,
        )
        await audit.record(
            self.db, "K8S_KUBECONFIG_DOWNLOAD", actor_user_id=self.actor,
            tenant_id=cluster.tenant_id, resource_type="k8s_cluster", resource_id=cluster.id,
            details={"name": cluster.name, "by_platform_admin": self.admin},
        )
        return cluster.name, kubeconfig
