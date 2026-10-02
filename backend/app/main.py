"""FastAPI application factory.

All HTTP routes live under /api so the edge (Traefik / Ingress / Route) can serve the
frontend and the API from the same origin without path rewriting.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from redis.asyncio import Redis

from app.api import health
from app.auth import router as auth
from app.core.config import Settings, get_settings
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging
from app.core.request_id import RequestIdMiddleware
from app.core.security import signing_key
from app.db.session import create_engine, create_sessionmaker
from app.iam import router as iam
from app.infra.mailer import build_mailer
from app.tenancy import router as tenancy

API_PREFIX = "/api"
API_V1_PREFIX = f"{API_PREFIX}/v1"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    signing_key(settings)  # fail fast on a missing/invalid key outside dev
    engine = create_engine(settings)
    app.state.sessionmaker = create_sessionmaker(engine)
    app.state.redis = Redis.from_url(str(settings.redis_url))
    app.state.mailer = build_mailer(settings)
    try:
        yield
    finally:
        await app.state.redis.aclose()
        await engine.dispose()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.service_name, settings.log_level)

    docs_enabled = not settings.is_production
    app = FastAPI(
        title="Cloud Manager API",
        version="0.0.1",
        docs_url=f"{API_PREFIX}/docs" if docs_enabled else None,
        redoc_url=None,
        openapi_url=f"{API_V1_PREFIX}/openapi.json" if docs_enabled else None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.add_middleware(RequestIdMiddleware)
    install_error_handlers(app)

    app.include_router(health.router, prefix=API_PREFIX)

    v1 = APIRouter(prefix=API_V1_PREFIX)
    v1.include_router(auth.router)
    v1.include_router(tenancy.router)
    v1.include_router(iam.router)
    app.include_router(v1)

    return app


app = create_app()
