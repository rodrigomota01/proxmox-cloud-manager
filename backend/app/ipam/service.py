"""Wiring: the configured IPAM source, and the job that refreshes the local copy."""

from typing import Any

import aiomysql

from app.core.config import Settings
from app.ipam.source import IpamSource, MysqlIpamSource
from app.ipam.sync import poll_guest_nics, sync_ipam
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


@handler("ipam.sync")
async def ipam_sync(ctx: JobContext) -> dict[str, Any]:
    source = source_for(ctx.providers.settings)
    if source is None:
        raise JobFailed("IPAM_NOT_CONFIGURED", "CM_IPAM_MYSQL_URL is not set")
    try:
        stats = await sync_ipam(ctx.sessionmaker, source)
    except (aiomysql.Error, OSError) as exc:
        raise JobFailed("IPAM_UNAVAILABLE", f"MySQL: {exc}") from exc
    await poll_guest_nics(ctx.sessionmaker, ctx.providers)
    return stats
