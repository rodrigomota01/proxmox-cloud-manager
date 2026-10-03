"""Instances and jobs as seen by tenant users.

Visibility: a {kind}:view grant at tenant (or platform) level covers every project;
otherwise only projects with a project-level binding granting it. Power actions are
authorized against the instance loaded from the database and run as jobs.
"""

import uuid

from sqlalchemy import ColumnElement, Select, and_, false, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import TenantContext
from app.audit import service as audit
from app.compute.models import Instance
from app.compute.schemas import InstanceCreate
from app.core.config import Settings
from app.core.errors import Conflict, NotFound, ValidationError
from app.core.pagination import PageParams, paginate
from app.iam.authz import Scope, authorize, effective_permissions, projects_with_permission
from app.iam.service import live_project
from app.images.models import Image
from app.inventory.models import ProviderCluster
from app.jobs.models import ACTIVE, Job, JobEvent
from app.jobs.queue import enqueue
from app.providers.base import PowerAction
from app.sshkeys.models import SshPublicKey
from app.tenancy import quota
from app.tenancy.models import Project

KINDS = ("vm", "container")
# route action -> (provider action, permission verb)
POWER_ACTIONS = {
    "start": (PowerAction.START, "start"),
    "stop": (PowerAction.STOP, "stop"),
    "shutdown": (PowerAction.SHUTDOWN, "stop"),
    "restart": (PowerAction.REBOOT, "restart"),
}


class ComputeService:
    def __init__(
        self, db: AsyncSession, ctx: TenantContext, settings: Settings | None = None
    ) -> None:
        self.db, self.ctx, self.settings = db, ctx, settings
        self._tenant_perms: set[str] | None = None

    @property
    def actor(self) -> uuid.UUID:
        return self.ctx.principal.user_id

    async def _viewable(self, kind: str) -> set[uuid.UUID] | None:
        """Projects where the actor may view instances of `kind`; None = every project
        (granted at tenant or platform level)."""
        if self._tenant_perms is None:
            self._tenant_perms = await effective_permissions(
                self.db, self.actor, Scope(self.ctx.tenant_id)
            )
        if f"{kind}:view" in self._tenant_perms:
            return None
        return await projects_with_permission(
            self.db, self.actor, self.ctx.tenant_id, f"{kind}:view"
        )

    async def _visible(self) -> ColumnElement[bool]:
        """SQL condition on Instance: rows the actor may view."""
        conditions = []
        for kind in KINDS:
            projects = await self._viewable(kind)
            if projects is None:
                conditions.append(Instance.kind == kind)
            elif projects:
                conditions.append(and_(Instance.kind == kind, Instance.project_id.in_(projects)))
        return or_(*conditions) if conditions else false()

    def _live_conditions(self) -> tuple[ColumnElement[bool], ...]:
        # RLS already limits rows to the active tenant; managed = adopted/created by us
        return (
            Instance.tenant_id == self.ctx.tenant_id,
            Instance.managed,
            Instance.deleted_at.is_(None),
        )

    def _live(self) -> Select[tuple[Instance]]:
        return select(Instance).where(*self._live_conditions())

    async def list_instances(
        self, params: PageParams, *, project_id: uuid.UUID | None = None,
        kind: str | None = None, power_state: str | None = None,
    ) -> tuple[list[Instance], str | None]:
        stmt = self._live().where(await self._visible())
        if project_id:
            stmt = stmt.where(Instance.project_id == project_id)
        if kind:
            stmt = stmt.where(Instance.kind == kind)
        if power_state:
            stmt = stmt.where(Instance.power_state == power_state)
        return await paginate(self.db, stmt, Instance.id, params)

    async def _load(self, instance_id: uuid.UUID) -> Instance:
        instance = await self.db.scalar(self._live().where(Instance.id == instance_id))
        if instance is None:
            raise NotFound()
        return instance

    async def get(self, instance_id: uuid.UUID) -> Instance:
        instance = await self._load(instance_id)
        await authorize(
            self.db, self.actor, f"{instance.kind}:view",
            Scope(self.ctx.tenant_id, instance.project_id),
        )
        return instance

    async def power(
        self, instance_id: uuid.UUID, action: str, idempotency_key: str | None
    ) -> Job:
        provider_action, verb = POWER_ACTIONS[action]
        instance = await self._load(instance_id)
        await authorize(
            self.db, self.actor, f"{instance.kind}:{verb}",
            Scope(self.ctx.tenant_id, instance.project_id),
        )
        if instance.state != "active":
            raise Conflict(f"Instance is {instance.state}")
        job = await enqueue(
            self.db, "instance.power", tenant_id=self.ctx.tenant_id,
            project_id=instance.project_id, requested_by=self.actor,
            resource_type="instance", resource_id=instance.id,
            payload={"action": provider_action.value}, idempotency_key=idempotency_key,
        )
        await audit.record(
            self.db, "INSTANCE_POWER_REQUESTED", actor_user_id=self.actor,
            tenant_id=self.ctx.tenant_id, resource_type="instance", resource_id=instance.id,
            details={"action": action, "job_id": str(job.id)},
        )
        return job

    # --- create / delete -------------------------------------------------------------------

    async def create(
        self, body: InstanceCreate, idempotency_key: str | None
    ) -> tuple[Instance, Job]:
        if self.settings is None:  # wiring error, not input
            raise RuntimeError("ComputeService.create needs settings")
        scope = Scope(self.ctx.tenant_id, body.project_id)
        await live_project(self.db, self.ctx.tenant_id, body.project_id)
        await authorize(self.db, self.actor, "vm:create", scope)

        # RLS: only public images and this tenant's are visible
        image = await self.db.scalar(
            select(Image).where(
                Image.id == body.image_id, Image.active,
                (Image.tenant_id.is_(None)) | (Image.tenant_id == self.ctx.tenant_id),
            )
        )
        if image is None:
            raise ValidationError(errors=[{"field": "image_id", "message": "unknown image"}])
        if body.root_disk_gb < image.min_disk_gb:
            raise ValidationError(errors=[{
                "field": "root_disk_gb",
                "message": f"the image needs at least {image.min_disk_gb} GB",
            }])
        cluster = await self.db.get(ProviderCluster, image.cluster_id)
        if cluster is None or not cluster.settings.get("pool"):
            raise Conflict("The image's cluster is not ready for new instances (no target pool)")

        keys = (
            await self.db.execute(
                select(SshPublicKey).where(
                    SshPublicKey.id.in_(body.ssh_key_ids),
                    SshPublicKey.user_id == self.actor,
                )
            )
        ).scalars().all()
        if len(keys) != len(set(body.ssh_key_ids)):
            raise ValidationError(errors=[{"field": "ssh_key_ids", "message": "unknown key"}])

        await quota.reserve(self.db, self.ctx.tenant_id, self.settings, {
            "instances": 1, "vcpus": body.vcpus, "memory_mb": body.memory_mb,
            "storage_gb": body.root_disk_gb,
        })
        instance = Instance(
            tenant_id=self.ctx.tenant_id, project_id=body.project_id, cluster_id=cluster.id,
            kind="vm", name=body.name, provider_name=body.name, state="provisioning",
            power_state="stopped", vcpus=body.vcpus, memory_mb=body.memory_mb,
            root_disk_gb=body.root_disk_gb, tags=body.tags, managed=True, image_id=image.id,
            ipv4=body.ipv4.address.split("/")[0], network=body.ipv4.model_dump(),
            provider_ref={},  # the job allocates the guest id
        )
        try:
            async with self.db.begin_nested():
                self.db.add(instance)
        except IntegrityError as exc:
            raise Conflict(
                f"IP {instance.ipv4} is already used by another instance on this server"
            ) from exc
        job = await enqueue(
            self.db, "instance.create", tenant_id=self.ctx.tenant_id,
            project_id=body.project_id, requested_by=self.actor,
            resource_type="instance", resource_id=instance.id,
            # public keys are copied: deleting a key later must not break the job
            payload={"ssh_keys": [k.public_key for k in keys], "user": image.default_user},
            idempotency_key=idempotency_key,
        )
        await audit.record(
            self.db, "INSTANCE_CREATE_REQUESTED", actor_user_id=self.actor,
            tenant_id=self.ctx.tenant_id, resource_type="instance", resource_id=instance.id,
            details={
                "name": body.name, "image_id": str(image.id), "vcpus": body.vcpus,
                "memory_mb": body.memory_mb, "root_disk_gb": body.root_disk_gb,
                "ipv4": body.ipv4.address, "job_id": str(job.id),
                "ssh_keys": [k.fingerprint for k in keys],
            },
        )
        return instance, job

    async def delete(
        self, instance_id: uuid.UUID, confirm: str, idempotency_key: str | None
    ) -> Job:
        instance = await self._load(instance_id)
        await authorize(
            self.db, self.actor, f"{instance.kind}:delete",
            Scope(self.ctx.tenant_id, instance.project_id),
        )
        if confirm != instance.name:
            raise ValidationError(
                f"Type '{instance.name}' to confirm",
                errors=[{"field": "confirm", "message": "does not match the instance name"}],
            )
        if instance.state not in ("active", "error"):
            raise Conflict(f"Instance is {instance.state}")
        instance.state = "deleting"
        job = await enqueue(
            self.db, "instance.delete", tenant_id=self.ctx.tenant_id,
            project_id=instance.project_id, requested_by=self.actor,
            resource_type="instance", resource_id=instance.id,
            idempotency_key=idempotency_key,
        )
        await audit.record(
            self.db, "INSTANCE_DELETE_REQUESTED", actor_user_id=self.actor,
            tenant_id=self.ctx.tenant_id, resource_type="instance", resource_id=instance.id,
            details={"name": instance.name, "job_id": str(job.id)},
        )
        return job

    # --- jobs ----------------------------------------------------------------------------

    async def _viewable_projects(self) -> set[uuid.UUID] | None:
        """Projects where the actor may view any instance kind; None = all."""
        projects: set[uuid.UUID] = set()
        for kind in KINDS:
            viewable = await self._viewable(kind)
            if viewable is None:
                return None
            projects |= viewable
        return projects

    async def _jobs_visible(self) -> ColumnElement[bool]:
        """Own jobs, plus jobs of projects where the actor can view instances."""
        projects = await self._viewable_projects()
        if projects is None:
            return Job.tenant_id == self.ctx.tenant_id
        return or_(Job.requested_by == self.actor, Job.project_id.in_(projects))

    async def list_jobs(
        self, params: PageParams, *, status: str | None = None,
        resource_id: uuid.UUID | None = None, job_type: str | None = None,
    ) -> tuple[list[Job], str | None]:
        stmt = select(Job).where(Job.tenant_id == self.ctx.tenant_id, await self._jobs_visible())
        if status:
            stmt = stmt.where(Job.status == status)
        if job_type:
            stmt = stmt.where(Job.type == job_type)
        if resource_id:
            stmt = stmt.where(Job.resource_id == resource_id)
        # newest first: UUIDv7 ids are time-ordered, so paginate on id descending
        return await paginate(self.db, stmt, Job.id, params, descending=True)

    async def get_job(self, job_id: uuid.UUID) -> tuple[Job, list[JobEvent]]:
        job = await self.db.scalar(
            select(Job).where(
                Job.id == job_id, Job.tenant_id == self.ctx.tenant_id,
                await self._jobs_visible(),
            )
        )
        if job is None:
            raise NotFound()
        events = await self.db.execute(
            select(JobEvent).where(JobEvent.job_id == job.id).order_by(JobEvent.id)
        )
        return job, list(events.scalars())

    # --- dashboard -------------------------------------------------------------------------

    async def summary(self) -> tuple[int, dict[str, dict[str, int]], int, list[Job]]:
        rows = await self.db.execute(
            select(Instance.kind, Instance.power_state, func.count())
            .where(*self._live_conditions(), await self._visible())
            .group_by(Instance.kind, Instance.power_state)
        )
        instances: dict[str, dict[str, int]] = {}
        for kind, power, count in rows:
            instances.setdefault(kind, {})[power] = count

        projects_stmt = select(func.count()).select_from(Project).where(
            Project.tenant_id == self.ctx.tenant_id, Project.deleted_at.is_(None)
        )
        viewable = await self._viewable_projects()
        if viewable is not None:
            projects_stmt = projects_stmt.where(Project.id.in_(viewable))
        projects = await self.db.scalar(projects_stmt) or 0

        jobs_visible = (Job.tenant_id == self.ctx.tenant_id, await self._jobs_visible())
        active = await self.db.scalar(
            select(func.count()).select_from(Job).where(*jobs_visible, Job.status.in_(ACTIVE))
        ) or 0
        recent = await self.db.execute(
            select(Job).where(*jobs_visible).order_by(Job.id.desc()).limit(5)
        )
        return projects, instances, active, list(recent.scalars())
