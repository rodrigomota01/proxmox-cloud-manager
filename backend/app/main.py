"""FastAPI application factory.

All HTTP routes live under /api so the edge (Traefik / Ingress / Route) can serve the
frontend and the API from the same origin without path rewriting.
"""

from fastapi import APIRouter, FastAPI

from app.api import health
from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.core.request_id import RequestIdMiddleware

API_PREFIX = "/api"
API_V1_PREFIX = f"{API_PREFIX}/v1"


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
    )
    app.add_middleware(RequestIdMiddleware)

    app.include_router(health.router, prefix=API_PREFIX)

    v1 = APIRouter(prefix=API_V1_PREFIX)
    # Phase 1 routers (auth, iam, tenancy, compute, admin, jobs) are included here.
    app.include_router(v1)

    return app


app = create_app()
