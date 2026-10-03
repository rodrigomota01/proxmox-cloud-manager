"""Real PostgreSQL 17 + Redis via testcontainers.

Postgres is initialised with deploy/docker/postgres/init/01-roles.sh (the same script
docker compose uses), migrated as cm_owner, and the app connects as cm_app — so RLS and
grants are exercised exactly as in deployment.
"""

import asyncio
import os
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import docker
import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.cli import ALEMBIC_INI
from app.core.config import Settings
from app.iam.catalog import sync_catalog
from app.infra.mailer import Mail
from app.infra.secrets import LocalKek
from app.main import create_app, lifespan
from app.providers.base import PowerState
from app.providers.fake import FakeProvider
from app.providers.registry import ProviderRegistry

INIT_DIR = Path(__file__).resolve().parents[3] / "deploy" / "docker" / "postgres" / "init"
OWNER_PW, APP_PW = "owner-test-pw", "app-test-pw"
# catalog tables are seeded once per session; everything else is truncated per test
CATALOG = {"permissions", "roles", "role_permissions", "alembic_version"}


def _docker_available() -> bool:
    try:
        return bool(docker.from_env().ping())
    except docker.errors.DockerException:
        return False


@pytest.fixture(scope="session")
def pg_urls() -> Iterator[dict[str, str]]:
    if not _docker_available():
        pytest.skip("Docker not available")
    from testcontainers.community.postgres import PostgresContainer

    container = (
        PostgresContainer("postgres:17-alpine", username="postgres", password="pg", dbname="cm")
        .with_env("CM_OWNER_PASSWORD", OWNER_PW)
        .with_env("CM_APP_PASSWORD", APP_PW)
        .with_volume_mapping(str(INIT_DIR), "/docker-entrypoint-initdb.d", "ro")
    )
    with container:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(5432)
        urls = {
            "owner": f"postgresql+asyncpg://cm_owner:{OWNER_PW}@{host}:{port}/cm",
            "app": f"postgresql://cm_app:{APP_PW}@{host}:{port}/cm",
        }
        cfg = Config(str(ALEMBIC_INI))
        cfg.attributes["url"] = urls["owner"]
        command.upgrade(cfg, "head")
        asyncio.run(_seed_catalog(urls["owner"]))
        yield urls


async def _seed_catalog(url: str) -> None:
    engine = create_async_engine(url)
    async with async_sessionmaker(engine)() as s, s.begin():
        await sync_catalog(s)
    await engine.dispose()


@pytest.fixture(scope="session")
def redis_url() -> Iterator[str]:
    if not _docker_available():
        pytest.skip("Docker not available")
    from testcontainers.community.redis import RedisContainer

    with RedisContainer("redis:7-alpine") as container:
        yield f"redis://{container.get_container_host_ip()}:{container.get_exposed_port(6379)}/0"


@pytest.fixture
def settings(pg_urls: dict[str, str], redis_url: str) -> Settings:
    return Settings(
        env="test",
        database_url=pg_urls["app"],
        migration_database_url=pg_urls["owner"].replace("+asyncpg", ""),
        redis_url=redis_url,
        cookie_secure=False,
        db_pool_size=2,
    )


@pytest.fixture
async def owner_db(pg_urls: dict[str, str]) -> AsyncIterator[AsyncSession]:
    """Session as cm_owner (bypasses RLS) for fixtures and assertions."""
    engine = create_async_engine(pg_urls["owner"])
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        tables = (
            await session.execute(
                text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
            )
        ).scalars().all()
        to_truncate = [t for t in tables if t not in CATALOG]
        await session.execute(text(f"TRUNCATE {', '.join(to_truncate)} CASCADE"))
        await session.commit()
        yield session
    await engine.dispose()


@pytest.fixture
async def app_db(settings: Settings) -> AsyncIterator[AsyncSession]:
    """Session as cm_app (RLS applies), outside of HTTP."""
    engine = create_async_engine(settings.sqlalchemy_url)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
    await engine.dispose()


@dataclass
class OutboxMailer:
    sent: list[Mail] = field(default_factory=list)

    async def send(self, mail: Mail) -> None:
        self.sent.append(mail)


@pytest.fixture
async def app(settings: Settings, owner_db: AsyncSession):  # owner_db: clean tables first
    application = create_app(settings)
    async with lifespan(application):
        await application.state.redis.flushdb()
        application.state.mailer = OutboxMailer()
        yield application


@pytest.fixture
async def client(app) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.10", 50000)),
        base_url="http://localhost",
    ) as c:
        yield c


# --- providers ---------------------------------------------------------------------------


@pytest.fixture
def fake() -> FakeProvider:
    f = FakeProvider()
    f.add_node("tagima")
    f.add_instance(10001, "cm-test-1", node="tagima")
    f.add_instance(10002, "cm-test-2", node="tagima", kind="container", power=PowerState.RUNNING)
    return f


@pytest.fixture
def registry(app, settings, fake) -> ProviderRegistry:
    received: dict[str, str] = {}

    def factory(cluster, token_id, secret):
        received.update(token_id=token_id, secret=secret)
        return fake

    reg = ProviderRegistry(settings, LocalKek(os.urandom(32)), factory=factory)
    reg.received = received  # type: ignore[attr-defined]
    app.state.providers = reg
    return reg
