import pytest
from httpx import ASGITransport, AsyncClient

from app.api.health import get_checks
from app.core.config import Settings
from app.main import create_app


async def _ok(_: Settings) -> None:
    return None


async def _fail(_: Settings) -> None:
    raise ConnectionError("down")


@pytest.fixture
def app():
    return create_app(Settings(env="test"))


async def _client(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_healthz(app):
    async with await _client(app) as c:
        r = await c.get("/api/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_readyz_ok(app):
    app.dependency_overrides[get_checks] = lambda: {"postgres": _ok, "redis": _ok}
    async with await _client(app) as c:
        r = await c.get("/api/readyz")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


@pytest.mark.anyio
async def test_readyz_degraded_returns_503(app):
    app.dependency_overrides[get_checks] = lambda: {"postgres": _ok, "redis": _fail}
    async with await _client(app) as c:
        r = await c.get("/api/readyz")
    assert r.status_code == 503
    assert r.json()["checks"] == {"postgres": "ok", "redis": "unavailable"}


@pytest.mark.anyio
async def test_request_id_is_echoed_or_generated(app):
    async with await _client(app) as c:
        echoed = await c.get("/api/healthz", headers={"X-Request-Id": "abc12345-req"})
        generated = await c.get("/api/healthz", headers={"X-Request-Id": "bad id!"})
    assert echoed.headers["x-request-id"] == "abc12345-req"
    assert generated.headers["x-request-id"] != "bad id!"
    assert len(generated.headers["x-request-id"]) == 32


@pytest.mark.anyio
async def test_docs_disabled_in_production():
    app = create_app(Settings(env="production"))
    async with await _client(app) as c:
        assert (await c.get("/api/docs")).status_code == 404
        assert (await c.get("/api/v1/openapi.json")).status_code == 404
