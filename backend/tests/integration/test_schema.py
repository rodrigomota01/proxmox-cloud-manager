"""The migrated schema matches the ORM models (no forgotten migration)."""

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.ext.asyncio import create_async_engine

from app.db.models import Base
from app.iam.catalog import PERMISSIONS, ROLES

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


async def test_models_match_migrations(pg_urls):
    engine = create_async_engine(pg_urls["owner"])
    async with engine.connect() as conn:
        diff = await conn.run_sync(
            lambda sync: compare_metadata(MigrationContext.configure(sync), Base.metadata)
        )
    await engine.dispose()
    assert diff == []


async def test_catalog_is_seeded(owner_db):
    from sqlalchemy import text

    perms = (await owner_db.execute(text("SELECT count(*) FROM permissions"))).scalar_one()
    roles = (
        await owner_db.execute(text("SELECT name FROM roles WHERE is_system ORDER BY name"))
    ).scalars().all()
    assert perms == len(PERMISSIONS)
    assert roles == sorted(ROLES)
