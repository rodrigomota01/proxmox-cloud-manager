"""PostgreSQL job queue (ADR-0006).

- enqueue(): INSERT in the caller's transaction (atomic with audit/quota) + pg_notify,
  which Postgres delivers only on commit.
- claim(): one job via FOR UPDATE SKIP LOCKED; a running job whose lease expired
  (worker died) is claimable again — handlers resume from their recorded events.
- run_one(): executes the handler; transient provider errors are retried with backoff,
  anything else fails the job with a stable error code.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import Conflict
from app.db.session import set_platform_scope
from app.jobs.models import Job, JobEvent
from app.providers.base import ProviderError, ProviderUnavailable
from app.providers.registry import ProviderRegistry

logger = logging.getLogger(__name__)

CHANNEL = "cm_jobs"
LEASE = timedelta(minutes=10)


class JobFailed(Exception):
    """Raised by handlers for a final, user-visible failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


@dataclass
class JobContext:
    job: Job
    sessionmaker: async_sessionmaker[AsyncSession]
    providers: ProviderRegistry

    async def session(self) -> AsyncSession:
        """A new platform-scoped session; caller manages the transaction."""
        db = self.sessionmaker()
        await db.begin()
        await set_platform_scope(db)
        return db

    @staticmethod
    async def checkpoint(db: AsyncSession) -> None:
        """Commit progress (e.g. an allocated id) and keep working in a new transaction
        with the platform scope re-applied (SET LOCAL does not survive a commit)."""
        await db.commit()
        await db.begin()
        await set_platform_scope(db)

    async def provider_task(self, step: str) -> dict[str, Any] | None:
        """The provider operation recorded for `step` by a previous attempt, if any."""
        for event in reversed(await self.events("provider_task")):
            if event.data.get("step") == step:
                return event.data["operation"]
        return None

    async def event(self, kind: str, message: str = "", **data: Any) -> None:
        db = await self.session()
        try:
            db.add(JobEvent(
                job_id=self.job.id, tenant_id=self.job.tenant_id, kind=kind,
                message=message, data=data,
            ))
            await db.commit()
        finally:
            await db.close()

    async def events(self, kind: str) -> list[JobEvent]:
        db = await self.session()
        try:
            rows = await db.execute(
                select(JobEvent)
                .where(JobEvent.job_id == self.job.id, JobEvent.kind == kind)
                .order_by(JobEvent.id)
            )
            return list(rows.scalars())
        finally:
            await db.close()


Handler = Callable[[JobContext], Awaitable[dict[str, Any]]]
# Runs once when a job fails for good (not between retries): undo partial work.
FailureHook = Callable[[JobContext, str, str], Awaitable[None]]
HANDLERS: dict[str, Handler] = {}
FAILURE_HOOKS: dict[str, FailureHook] = {}


def handler(job_type: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        HANDLERS[job_type] = fn
        return fn

    return register


def on_failure(job_type: str) -> Callable[[FailureHook], FailureHook]:
    def register(fn: FailureHook) -> FailureHook:
        FAILURE_HOOKS[job_type] = fn
        return fn

    return register


async def enqueue(
    db: AsyncSession,
    job_type: str,
    *,
    tenant_id: uuid.UUID | None,
    project_id: uuid.UUID | None = None,
    requested_by: uuid.UUID | None,
    resource_type: str | None = None,
    resource_id: uuid.UUID | None = None,
    payload: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> Job:
    if idempotency_key and requested_by:
        existing = await db.scalar(
            select(Job).where(
                Job.requested_by == requested_by, Job.idempotency_key == idempotency_key
            )
        )
        if existing is not None:
            if existing.type != job_type or existing.resource_id != resource_id:
                raise Conflict("Idempotency-Key already used for a different request")
            return existing
    job = Job(
        tenant_id=tenant_id, project_id=project_id, requested_by=requested_by,
        type=job_type, resource_type=resource_type, resource_id=resource_id,
        payload=payload or {}, idempotency_key=idempotency_key,
    )
    try:
        async with db.begin_nested():
            db.add(job)
    except IntegrityError as exc:
        raise Conflict("Another operation is already running on this resource") from exc
    await db.execute(
        text("SELECT pg_notify(:channel, :id)"), {"channel": CHANNEL, "id": str(job.id)}
    )
    return job


_CLAIM = text(
    """
    UPDATE jobs SET status = 'running', attempts = attempts + 1,
           locked_until = now() + make_interval(secs => :lease), locked_by = :worker,
           started_at = coalesce(started_at, now())
     WHERE id = (
        SELECT id FROM jobs
         WHERE (status = 'pending' AND run_after <= now())
            OR (status = 'running' AND locked_until < now())
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
    RETURNING id
    """
)


async def claim(
    sessionmaker: async_sessionmaker[AsyncSession], worker: str
) -> uuid.UUID | None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        return await db.scalar(
            _CLAIM, {"lease": LEASE.total_seconds(), "worker": worker}
        )


async def _finish(
    sessionmaker: async_sessionmaker[AsyncSession], job_id: uuid.UUID, **values: Any
) -> None:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        job = await db.get_one(Job, job_id)
        for key, value in values.items():
            setattr(job, key, value)
        job.locked_until = job.locked_by = None


async def run_one(
    sessionmaker: async_sessionmaker[AsyncSession], providers: ProviderRegistry, worker: str
) -> bool:
    """Claims and runs one job. Returns False when the queue is empty."""
    job_id = await claim(sessionmaker, worker)
    if job_id is None:
        return False
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        job = await db.get_one(Job, job_id)
        db.expunge(job)
    ctx = JobContext(job, sessionmaker, providers)
    fn = HANDLERS.get(job.type)
    now = datetime.now(UTC)
    try:
        if fn is None:
            raise JobFailed("UNKNOWN_JOB_TYPE", f"no handler for {job.type}")
        await ctx.event("started", attempt=job.attempts)
        result = await fn(ctx)
    except ProviderUnavailable as exc:
        if job.attempts < job.max_attempts:
            delay = timedelta(seconds=min(5 * 2 ** (job.attempts - 1), 120))
            await ctx.event("retry", str(exc), delay_seconds=delay.total_seconds())
            await _finish(sessionmaker, job.id, status="pending", run_after=now + delay)
        else:
            await _fail(ctx, sessionmaker, "PROVIDER_UNAVAILABLE", str(exc))
    except JobFailed as exc:
        await _fail(ctx, sessionmaker, exc.code, exc.message)
    except ProviderError as exc:
        await _fail(ctx, sessionmaker, "PROVIDER_ERROR", str(exc))
    except Exception as exc:
        logger.exception("job crashed", extra={"job_id": str(job.id), "type": job.type})
        await _fail(ctx, sessionmaker, "INTERNAL_ERROR", type(exc).__name__)
    else:
        await ctx.event("succeeded")
        await _finish(
            sessionmaker, job.id, status="succeeded", result=result,
            finished_at=datetime.now(UTC),
        )
    return True


async def _fail(
    ctx: JobContext, sessionmaker: async_sessionmaker[AsyncSession], code: str, message: str
) -> None:
    hook = FAILURE_HOOKS.get(ctx.job.type)
    if hook is not None:
        try:
            await hook(ctx, code, message)
        except Exception as exc:  # the job still fails; leave a trace for operators
            logger.exception("job failure hook crashed", extra={"job_id": str(ctx.job.id)})
            await ctx.event("compensation_failed", type(exc).__name__)
    await ctx.event("failed", message, code=code)
    await _finish(
        sessionmaker, ctx.job.id, status="failed", error_code=code,
        error_message=message[:1000], finished_at=datetime.now(UTC),
    )
