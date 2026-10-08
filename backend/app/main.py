"""FastAPI application factory.

All HTTP routes live under /api so the edge (Traefik / Ingress / Route) can serve the
frontend and the API from the same origin without path rewriting.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from redis.asyncio import Redis

from app.admin import router as admin
from app.alerts import router as alerts
from app.api import health
from app.auth import router as auth
from app.billing import router as billing
from app.compute import router as compute
from app.core.config import Settings, get_settings
from app.core.errors import install_error_handlers, problem
from app.core.logging import configure_logging
from app.core.request_id import RequestIdMiddleware
from app.core.security import signing_key
from app.db.session import create_engine, create_sessionmaker
from app.iam import router as iam
from app.images import router as images
from app.infra.mailer import build_mailer
from app.infra.secrets import SecretsError, build_secrets_backend
from app.ipam import router as ipam
from app.k8s import router as k8s
from app.providers.registry import ProviderRegistry
from app.regions import router as regions
from app.sshkeys import router as sshkeys
from app.tenancy import router as tenancy
from app.users import router as users

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
    app.state.providers = ProviderRegistry(settings, build_secrets_backend(settings))
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
        description=(
            "Tenant-scoped routes (projects, instances, jobs, role bindings, dashboard) "
            "require the header `X-Tenant-Id: <tenant uuid>`; it is validated against the "
            "caller's memberships. It is omitted from each operation so generated clients "
            "can inject it once."
        ),
        docs_url=f"{API_PREFIX}/docs" if docs_enabled else None,
        redoc_url=None,
        openapi_url=f"{API_V1_PREFIX}/openapi.json" if docs_enabled else None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.add_middleware(RequestIdMiddleware)
    install_error_handlers(app)

    @app.exception_handler(SecretsError)
    async def _secrets_error(_: object, exc: SecretsError) -> object:
        # e.g. CM_KEK missing: an operator problem, not the client's
        return problem(503, "SECRETS_UNAVAILABLE", "Secrets backend unavailable", str(exc))

    app.include_router(health.router, prefix=API_PREFIX)

    v1 = APIRouter(prefix=API_V1_PREFIX)
    v1.include_router(auth.router)
    v1.include_router(tenancy.router)
    v1.include_router(iam.router)
    v1.include_router(compute.router)
    v1.include_router(images.router)
    v1.include_router(regions.router)
    v1.include_router(sshkeys.router)
    v1.include_router(users.router)
    v1.include_router(admin.router)
    v1.include_router(alerts.router)
    v1.include_router(alerts.admin_router)
    v1.include_router(ipam.router)
    v1.include_router(billing.router)
    v1.include_router(billing.admin_router)
    v1.include_router(k8s.router)
    app.include_router(v1)

    return app


app = create_app()
