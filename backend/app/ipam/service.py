"""Wiring: the configured IPAM source, the job that refreshes the local copy, and the
jobs that edit the registry for admins (the API has no route to MySQL)."""

from typing import Any

import aiomysql

from app.core.config import Settings
from app.ipam.source import IpamSource, MysqlIpamSource, PoolFields
from app.ipam.sync import poll_guest_config, sync_ipam
from app.jobs.queue import JobContext, JobFailed, handler

_override: IpamSource | None = None


def configure(source: IpamSource | None) -> None:
    """Tests install a fake source; production builds one from the settings."""
    global _override
    _override = source


def source_for(settings: Settings) -> IpamSource | None:
    if _override is not None:
        return _override
    if settings.ipam_mysql_url is None:
        return None
    return MysqlIpamSource(settings.ipam_mysql_url.get_secret_value())


def _source(ctx: JobContext) -> IpamSource:
    source = source_for(ctx.providers.settings)
    if source is None:
        raise JobFailed("IPAM_NOT_CONFIGURED", "CM_IPAM_MYSQL_URL is not set")
    return source


@handler("ipam.sync")
async def ipam_sync(ctx: JobContext) -> dict[str, Any]:
    source = _source(ctx)
    try:
        stats = await sync_ipam(ctx.sessionmaker, source)
    except (aiomysql.Error, OSError) as exc:
        raise JobFailed("IPAM_UNAVAILABLE", f"MySQL: {exc}") from exc
    await poll_guest_config(ctx.sessionmaker, ctx.providers)
    return stats


# --- registry edits (ADR-0014) -----------------------------------------------------------
# The API validates and queues; the worker writes to MySQL and refreshes the local copy
# right away, so the screen shows the result when the job ends. A write recorded as an
# event is not repeated when a run is resumed (worker died between the write and the end).


def _fields(payload: dict[str, Any]) -> PoolFields:
    return PoolFields(
        ip_addr=str(payload["address"]), assigned=bool(payload.get("assigned")),
        mac=payload.get("mac"), host_owner=payload.get("host_owner"),
        hostname=payload.get("hostname"), hypervisor=payload.get("hypervisor"),
        node=payload.get("node_name"), ip_block=payload.get("ip_block"),
    )


async def _refresh(ctx: JobContext, source: IpamSource) -> dict[str, int]:
    try:
        return await sync_ipam(ctx.sessionmaker, source)
    except (aiomysql.Error, OSError) as exc:
        raise JobFailed(
            "IPAM_UNAVAILABLE", f"written, but the copy was not refreshed: {exc}"
        ) from exc


@handler("ipam.address.create")
async def ipam_address_create(ctx: JobContext) -> dict[str, Any]:
    source = _source(ctx)
    done = await ctx.events("ip_inserted")
    if done:
        external_id = int(done[-1].data["external_id"])
    else:
        try:
            external_id = await source.insert(_fields(ctx.job.payload))
        except (aiomysql.Error, OSError) as exc:
            raise JobFailed("IPAM_UNAVAILABLE", f"MySQL: {exc}") from exc
        await ctx.event("ip_inserted", f"IP {ctx.job.payload['address']} registered",
                        external_id=external_id)
    return {"external_id": external_id, **await _refresh(ctx, source)}


@handler("ipam.address.update")
async def ipam_address_update(ctx: JobContext) -> dict[str, Any]:
    source = _source(ctx)
    external_id = int(ctx.job.payload["external_id"])
    if not await ctx.events("ip_updated"):
        try:
            found = await source.update(external_id, _fields(ctx.job.payload))
        except (aiomysql.Error, OSError) as exc:
            raise JobFailed("IPAM_UNAVAILABLE", f"MySQL: {exc}") from exc
        if not found:
            await _refresh(ctx, source)  # drop the local copy of a row that is gone
            raise JobFailed("IP_NOT_FOUND", "the registry no longer has this address")
        await ctx.event("ip_updated", f"IP {ctx.job.payload['address']} updated")
    return {"external_id": external_id, **await _refresh(ctx, source)}


@handler("ipam.address.delete")
async def ipam_address_delete(ctx: JobContext) -> dict[str, Any]:
    source = _source(ctx)
    external_id = int(ctx.job.payload["external_id"])
    if not await ctx.events("ip_deleted"):
        try:
            deleted = await source.delete(external_id)
        except (aiomysql.Error, OSError) as exc:
            raise JobFailed("IPAM_UNAVAILABLE", f"MySQL: {exc}") from exc
        # already gone counts as done: the copy is refreshed below either way
        await ctx.event("ip_deleted", f"IP {ctx.job.payload.get('address', external_id)} removed",
                        deleted=deleted)
    return {"external_id": external_id, **await _refresh(ctx, source)}
