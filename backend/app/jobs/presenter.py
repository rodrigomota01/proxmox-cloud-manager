"""Jobs as the activity history users read: who did what, to which resource.

Names are resolved in batch (one query per kind, never per row) under the caller's RLS
scope; instances keep their row after deletion, so history still names them.
"""

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.compute.models import Instance
from app.compute.schemas import JobOut
from app.iam.models import User
from app.inventory.models import ProviderCluster
from app.jobs.models import Job


async def jobs_out(db: AsyncSession, jobs: Sequence[Job]) -> list[JobOut]:
    ids = {
        kind: {j.resource_id for j in jobs if j.resource_type == kind and j.resource_id}
        for kind in ("instance", "cluster")
    }
    names: dict[object, str] = {}
    if ids["instance"]:
        rows = await db.execute(
            select(Instance.id, Instance.name).where(Instance.id.in_(ids["instance"]))
        )
        names.update(dict(rows.all()))
    if ids["cluster"]:
        rows = await db.execute(
            select(ProviderCluster.id, ProviderCluster.name).where(
                ProviderCluster.id.in_(ids["cluster"])
            )
        )
        names.update(dict(rows.all()))
    requesters = {j.requested_by for j in jobs if j.requested_by}
    people: dict[object, str] = {}
    if requesters:
        rows = await db.execute(select(User.id, User.display_name).where(User.id.in_(requesters)))
        people = dict(rows.all())
    return [
        JobOut.model_validate(j, from_attributes=True).model_copy(
            update={
                "resource_name": names.get(j.resource_id),
                "requested_by_name": people.get(j.requested_by),
            }
        )
        for j in jobs
    ]


async def job_out(db: AsyncSession, job: Job) -> JobOut:
    return (await jobs_out(db, [job]))[0]
