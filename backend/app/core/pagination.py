"""Cursor pagination over UUIDv7 primary keys (time-ordered): ?limit=50&cursor=..."""

import base64
import binascii
import uuid
from typing import Annotated

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.core.errors import ValidationError


class PageParams(BaseModel):
    limit: int = 50
    cursor: str | None = None


def page_params(
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: Annotated[str | None, Query(max_length=64)] = None,
) -> PageParams:
    return PageParams(limit=limit, cursor=cursor)


def encode_cursor(last_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(last_id.bytes).rstrip(b"=").decode()


def decode_cursor(cursor: str) -> uuid.UUID:
    try:
        return uuid.UUID(bytes=base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except (ValueError, binascii.Error) as exc:
        raise ValidationError(errors=[{"field": "cursor", "message": "invalid cursor"}]) from exc


async def paginate[T](
    db: AsyncSession, stmt: Select[tuple[T]], id_column: InstrumentedAttribute, params: PageParams
) -> tuple[list[T], str | None]:
    if params.cursor:
        stmt = stmt.where(id_column > decode_cursor(params.cursor))
    rows = list((await db.execute(stmt.order_by(id_column).limit(params.limit + 1))).scalars())
    if len(rows) <= params.limit:
        return rows, None
    rows = rows[: params.limit]
    return rows, encode_cursor(rows[-1].id)
