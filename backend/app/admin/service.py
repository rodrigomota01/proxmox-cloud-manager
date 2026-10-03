"""Platform administration: clusters, credentials, sync, discovered instances.
Runs in platform scope (set by require_platform)."""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.schemas import (
    AdoptRequest,
    ClusterCreate,
    ClusterUpdate,
    ConnectionTest,
    CredentialsPut,
)
from app.audit import service as audit
from app.compute.models import Instance
from app.core.config import Settings
from app.core.errors import Conflict, NotFound, ValidationError
from app.core.ids import uuid7
from app.infra.secrets import seal
from app.inventory.models import ProviderCluster, ProviderCredential
from app.jobs.models import Job
from app.jobs.queue import enqueue
from app.providers.base import ProviderAuthError, ProviderError
from app.providers.registry import ProviderRegistry
from app.regions.models import Zone
from app.tenancy.models import Project


def _confirm(given: str, expected: str) -> None:
    if given != expected:
        raise ValidationError(
            f"Type '{expected}' to confirm",
            errors=[{"field": "confirm", "message": "does not match the resource name"}],
        )


class AdminService:
    def __init__(
        self, db: AsyncSession, actor: uuid.UUID, settings: Settings, registry: ProviderRegistry
    ) -> None:
        self.db, self.actor, self.settings, self.registry = db, actor, settings, registry

    async def _audit(self, action: str, **kwargs: Any) -> None:
        await audit.record(self.db, action, actor_user_id=self.actor, **kwargs)

    def _check_tls(self, insecure: bool, api_url: str) -> None:
        if self.settings.env == "dev":
            return
        if insecure or not api_url.startswith("https://"):
            raise ValidationError(
                "Plain HTTP and skipping TLS verification are allowed only in dev",
                errors=[{"field": "api_url", "message": "https with verified TLS required"}],
            )

    # --- clusters ----------------------------------------------------------------------

    async def get_cluster(self, cluster_id: uuid.UUID) -> ProviderCluster:
        cluster = await self.db.get(ProviderCluster, cluster_id)
        if cluster is None:
            raise NotFound()
        return cluster

    async def _check_zone(self, zone_id: uuid.UUID | None) -> None:
        if zone_id is not None and await self.db.get(Zone, zone_id) is None:
            raise ValidationError(errors=[{"field": "zone_id", "message": "unknown zone"}])

    async def create_cluster(self, body: ClusterCreate) -> ProviderCluster:
        self._check_tls(body.insecure_skip_verify, body.api_url)
        await self._check_zone(body.zone_id)
        cluster = ProviderCluster(
            id=uuid7(), name=body.name, provider="proxmox", api_url=body.api_url,
            ca_pem=body.ca_pem, insecure_skip_verify=body.insecure_skip_verify,
            zone_id=body.zone_id,
            settings={
                "vmid_range": body.vmid_range.model_dump(),
                **({"pool": body.pool} if body.pool else {}),
            },
            status="unknown",
        )
        try:
            async with self.db.begin_nested():
                self.db.add(cluster)
        except IntegrityError as exc:
            raise Conflict("A cluster with this name already exists") from exc
        await self._audit(
            "CLUSTER_CREATE", resource_type="cluster", resource_id=cluster.id,
            details={"name": cluster.name, "api_url": cluster.api_url},
        )
        return cluster

    async def update_cluster(self, cluster_id: uuid.UUID, body: ClusterUpdate) -> ProviderCluster:
        cluster = await self.get_cluster(cluster_id)
        changes = body.model_dump(exclude_unset=True)
        if "zone_id" in changes:
            await self._check_zone(changes["zone_id"])
        for key in ("vmid_range", "pool"):  # these live in settings
            if key in changes:
                cluster.settings = {**cluster.settings, key: changes.pop(key)}
        for field, value in changes.items():
            setattr(cluster, field, value)
        self._check_tls(cluster.insecure_skip_verify, cluster.api_url)
        try:
            async with self.db.begin_nested():
                await self.db.flush()
        except IntegrityError as exc:
            raise Conflict("A cluster with this name already exists") from exc
        await self._audit(
            "CLUSTER_UPDATE", resource_type="cluster", resource_id=cluster.id,
            details={"fields": sorted(body.model_dump(exclude_unset=True))},
        )
        return cluster

    async def delete_cluster(self, cluster_id: uuid.UUID, confirm: str) -> None:
        cluster = await self.get_cluster(cluster_id)
        _confirm(confirm, cluster.name)
        has_managed = await self.db.scalar(
            select(
                exists().where(
                    Instance.cluster_id == cluster.id, Instance.managed,
                    Instance.deleted_at.is_(None),
                )
            )
        )
        if has_managed:
            raise Conflict("The cluster still has managed instances")
        for instance in (
            await self.db.execute(select(Instance).where(Instance.cluster_id == cluster.id))
        ).scalars():
            await self.db.delete(instance)
        await self.db.flush()
        await self._audit(
            "CLUSTER_DELETE", resource_type="cluster", resource_id=cluster.id,
            details={"name": cluster.name},
        )
        await self.db.delete(cluster)

    async def put_credentials(
        self, cluster_id: uuid.UUID, body: CredentialsPut
    ) -> ProviderCredential:
        cluster = await self.get_cluster(cluster_id)
        sealed = seal(
            self.registry.require_secrets(), body.secret.get_secret_value(),
            aad=cluster.id.bytes,
        )
        cred = await self.db.get(ProviderCredential, cluster.id)
        rotated = cred is not None
        if cred is None:
            cred = ProviderCredential(cluster_id=cluster.id)
            self.db.add(cred)
        cred.token_id = body.token_id
        cred.secret_ciphertext, cred.dek_wrapped = sealed.ciphertext, sealed.dek_wrapped
        cred.kek_ref, cred.rotated_at = sealed.kek_ref, datetime.now(UTC)
        if cluster.status == "auth_error":  # let the scheduled sync try the new token
            cluster.status, cluster.last_error = "unknown", None
        await self.db.flush()
        await self._audit(
            "CLUSTER_CREDENTIALS_ROTATE" if rotated else "CLUSTER_CREDENTIALS_SET",
            resource_type="cluster", resource_id=cluster.id,
            details={"token_id": body.token_id},
        )
        return cred

    async def test_connection(self, cluster_id: uuid.UUID) -> ConnectionTest:
        cluster = await self.get_cluster(cluster_id)
        try:
            async with self.registry.open(self.db, cluster) as provider:
                health = await provider.health()
                inv = await provider.inventory()
        except ProviderError as exc:
            cluster.last_error = str(exc)
            if isinstance(exc, ProviderAuthError):
                cluster.status = "auth_error"
            return ConnectionTest(ok=False, error=str(exc))
        cluster.version, cluster.last_error = health.version, None
        if cluster.status == "auth_error":
            cluster.status = "unknown"
        return ConnectionTest(
            ok=True, version=health.version, nodes_online=health.nodes_online,
            nodes_total=health.nodes_total, guests_visible=len(inv.instances),
        )

    async def sync(self, cluster_id: uuid.UUID) -> Job:
        cluster = await self.get_cluster(cluster_id)
        job = await enqueue(
            self.db, "cluster.sync", tenant_id=None, requested_by=self.actor,
            resource_type="cluster", resource_id=cluster.id,
        )
        await self._audit(
            "CLUSTER_SYNC_REQUESTED", resource_type="cluster", resource_id=cluster.id,
            details={"job_id": str(job.id)},
        )
        return job

    # --- instances ---------------------------------------------------------------------

    async def adopt_many(
        self, instance_ids: list[uuid.UUID], tenant_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[Instance]:
        """All or nothing: one invalid id (gone, already managed) fails the whole request."""
        body = AdoptRequest(tenant_id=tenant_id, project_id=project_id)
        return [await self.adopt(i, body) for i in dict.fromkeys(instance_ids)]

    async def adopt(self, instance_id: uuid.UUID, body: AdoptRequest) -> Instance:
        instance = await self.db.get(Instance, instance_id)
        if instance is None or instance.deleted_at is not None:
            raise NotFound()
        if instance.managed:
            raise Conflict("Instance is already managed")
        project = await self.db.scalar(
            select(Project).where(
                Project.id == body.project_id, Project.tenant_id == body.tenant_id,
                Project.deleted_at.is_(None),
            )
        )
        if project is None:
            raise ValidationError(
                errors=[{"field": "project_id", "message": "not a live project of the tenant"}]
            )
        instance.tenant_id, instance.project_id = body.tenant_id, body.project_id
        instance.managed, instance.state = True, "active"
        if body.name:
            instance.name = body.name
        await self.db.flush()
        await self._audit(
            "INSTANCE_ADOPT", tenant_id=body.tenant_id, resource_type="instance",
            resource_id=instance.id,
            details={"project_id": str(body.project_id), "vmid": instance.provider_ref["vmid"]},
        )
        return instance
