"""Audit trail writer. Records are inserted in the caller's transaction, so the trail
commits (or rolls back) together with the action it describes.

Explicit SQL instead of the ORM: SQLAlchemy fetches the identity PK with RETURNING, and
under RLS RETURNING also requires the SELECT policy — writers may log events they are not
allowed to read back (e.g. LOGIN_FAILED has no tenant).
"""

import json
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.request_id import current_request_id

_INSERT = text(
    "INSERT INTO audit_logs (action, outcome, actor_user_id, tenant_id, resource_type,"
    " resource_id, source_ip, request_id, details)"
    " VALUES (:action, :outcome, :actor, :tenant, :rtype, :rid, CAST(:ip AS inet),"
    " :request_id, CAST(:details AS jsonb))"
)


async def record(
    session: AsyncSession,
    action: str,
    *,
    outcome: str = "success",
    actor_user_id: uuid.UUID | None = None,
    tenant_id: uuid.UUID | None = None,
    resource_type: str | None = None,
    resource_id: str | uuid.UUID | None = None,
    source_ip: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    await session.execute(
        _INSERT,
        {
            "action": action,
            "outcome": outcome,
            "actor": actor_user_id,
            "tenant": tenant_id,
            "rtype": resource_type,
            "rid": str(resource_id) if resource_id is not None else None,
            "ip": source_ip,
            "request_id": current_request_id(),
            "details": json.dumps(details or {}, default=str),
        },
    )
