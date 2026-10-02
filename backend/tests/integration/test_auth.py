"""Auth flows against real Postgres/Redis (docs/architecture/06-autenticacao.md)."""

import logging
import re

import pytest
from sqlalchemy import select

from app.audit.models import AuditLog
from app.auth.models import Session
from app.iam.models import User
from tests.integration.factories import (
    PASSWORD,
    add_member,
    grant_platform,
    make_tenant,
    make_user,
)

pytestmark = [pytest.mark.anyio, pytest.mark.integration]

CSRF = {"X-Requested-With": "cloud-manager"}
EMAIL = "alice@example.com"


@pytest.fixture
async def alice(owner_db):
    return await make_user(owner_db, EMAIL)


async def _login(client, email=EMAIL, password=PASSWORD):
    return await client.post("/api/v1/auth/login", json={"email": email, "password": password})


def _bearer(resp) -> dict[str, str]:
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _actions(owner_db) -> list[str]:
    owner_db.expire_all()
    return list(
        (await owner_db.execute(select(AuditLog.action).order_by(AuditLog.id))).scalars()
    )


# --- login -----------------------------------------------------------------------------


async def test_login_success_sets_cookie_and_returns_token(client, alice, owner_db):
    r = await _login(client, email="  Alice@Example.COM ")
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "Bearer" and body["expires_in"] == 600
    assert body["user"]["email"] == EMAIL
    cookie = r.headers["set-cookie"]
    assert "cm_rt=" in cookie and "HttpOnly" in cookie
    assert "Path=/api/v1/auth" in cookie and "SameSite=strict" in cookie
    assert r.headers["cache-control"] == "no-store"
    assert await _actions(owner_db) == ["LOGIN_SUCCESS"]


@pytest.mark.parametrize("email", [EMAIL, "nobody@example.com"])
async def test_login_failure_is_generic_and_audited(client, alice, owner_db, email):
    r = await _login(client, email=email, password="wrong password!!")
    assert r.status_code == 401
    assert r.headers["content-type"] == "application/problem+json"
    assert r.json()["detail"] == "Invalid credentials"
    assert await _actions(owner_db) == ["LOGIN_FAILED"]


async def test_lock_after_five_failures(client, alice, owner_db, app):
    app.state.settings.login_rate_limit_email_per_minute = 100
    for _ in range(5):
        assert (await _login(client, password="wrong password!!")).status_code == 401
    # right password, but the account is locked: same generic answer
    r = await _login(client)
    assert r.status_code == 401
    owner_db.expire_all()
    user = (await owner_db.execute(select(User).where(User.email == EMAIL))).scalar_one()
    assert user.failed_login_count == 5 and user.locked_until is not None
    reasons = (
        await owner_db.execute(select(AuditLog.details).where(AuditLog.action == "LOGIN_FAILED"))
    ).scalars().all()
    assert reasons[-1] == {"reason": "locked"}


async def test_inactive_user_cannot_login(client, owner_db):
    await make_user(owner_db, "gone@example.com", active=False)
    assert (await _login(client, email="gone@example.com")).status_code == 401


async def test_rate_limit_per_email(client, alice):
    for _ in range(5):
        await _login(client, password="wrong password!!")
    r = await _login(client)
    assert r.status_code == 429
    assert r.json()["code"] == "RATE_LIMITED"
    assert int(r.headers["retry-after"]) >= 1


async def test_validation_error_is_problem_json(client):
    r = await client.post("/api/v1/auth/login", json={"email": "x", "password": "y", "z": 1})
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "VALIDATION_ERROR"
    assert {e["field"] for e in body["errors"]} >= {"email", "z"}


# --- /me and bearer --------------------------------------------------------------------


async def test_me_lists_only_own_tenants(client, alice, owner_db):
    acme, globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    bob = await make_user(owner_db, "bob@example.com")
    await add_member(owner_db, acme, alice)
    await add_member(owner_db, globex, bob)
    await grant_platform(owner_db, alice, "READ_ONLY")

    r = await client.get("/api/v1/me", headers=_bearer(await _login(client)))
    assert r.status_code == 200
    body = r.json()
    assert [t["slug"] for t in body["tenants"]] == ["acme"]
    assert body["platform_roles"] == ["READ_ONLY"]


@pytest.mark.parametrize(
    "header",
    ["", "Bearer", "Bearer not-a-jwt", "Basic Zm9vOmJhcg==",
     "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."],
)
async def test_me_rejects_bad_tokens(client, header):
    r = await client.get("/api/v1/me", headers={"Authorization": header} if header else {})
    assert r.status_code == 401
    assert r.json()["code"] == "UNAUTHENTICATED"


# --- refresh ---------------------------------------------------------------------------


async def test_refresh_rotates_token(client, alice):
    await _login(client)
    first = client.cookies.get("cm_rt")
    r = await client.post("/api/v1/auth/refresh", headers=CSRF)
    assert r.status_code == 200
    assert r.json()["access_token"]
    assert client.cookies.get("cm_rt") not in (None, first)


async def test_refresh_reuse_revokes_family(client, alice, owner_db):
    login = await _login(client)
    stolen = client.cookies.get("cm_rt")
    assert (await client.post("/api/v1/auth/refresh", headers=CSRF)).status_code == 200
    legit = client.cookies.get("cm_rt")

    client.cookies.set("cm_rt", stolen, path="/api/v1/auth")
    assert (await client.post("/api/v1/auth/refresh", headers=CSRF)).status_code == 401
    # the legitimate holder is logged out too, and the access token dies immediately
    client.cookies.set("cm_rt", legit, path="/api/v1/auth")
    assert (await client.post("/api/v1/auth/refresh", headers=CSRF)).status_code == 401
    assert (await client.get("/api/v1/me", headers=_bearer(login))).status_code == 401
    assert "REFRESH_TOKEN_REUSE" in await _actions(owner_db)


async def test_refresh_requires_csrf_header_and_allowed_origin(client, alice):
    await _login(client)
    assert (await client.post("/api/v1/auth/refresh")).status_code == 403
    r = await client.post(
        "/api/v1/auth/refresh", headers={**CSRF, "Origin": "https://evil.example"}
    )
    assert r.status_code == 403
    r = await client.post("/api/v1/auth/refresh", headers={**CSRF, "Origin": "http://localhost"})
    assert r.status_code == 200


async def test_refresh_without_cookie(client):
    assert (await client.post("/api/v1/auth/refresh", headers=CSRF)).status_code == 401


# --- logout ----------------------------------------------------------------------------


async def test_logout_revokes_session_and_access_token(client, alice, owner_db):
    login = await _login(client)
    r = await client.post("/api/v1/auth/logout", headers=CSRF)
    assert r.status_code == 204
    assert (await client.get("/api/v1/me", headers=_bearer(login))).status_code == 401
    assert (await client.post("/api/v1/auth/refresh", headers=CSRF)).status_code == 401
    assert "LOGOUT" in await _actions(owner_db)


async def test_logout_all(client, alice, owner_db):
    first = await _login(client)
    second = await _login(client)
    r = await client.post("/api/v1/auth/logout-all", headers=_bearer(second))
    assert r.status_code == 204
    for login in (first, second):
        assert (await client.get("/api/v1/me", headers=_bearer(login))).status_code == 401
    owner_db.expire_all()
    sessions = (await owner_db.execute(select(Session))).scalars().all()
    assert len(sessions) == 2 and all(s.revoked_at for s in sessions)


# --- password reset --------------------------------------------------------------------


def _token_from(mail) -> str:
    match = re.search(r"#token=([A-Za-z0-9_-]+)", mail.body)
    assert match
    return match.group(1)


async def test_password_reset_flow(client, app, alice, owner_db):
    old = await _login(client)
    r = await client.post("/api/v1/auth/password/forgot", json={"email": EMAIL})
    assert r.status_code == 202
    [mail] = app.state.mailer.sent
    assert mail.to == EMAIL
    token = _token_from(mail)

    new_password = "a brand new password"
    r = await client.post(
        "/api/v1/auth/password/reset", json={"token": token, "new_password": new_password}
    )
    assert r.status_code == 204
    # old sessions are revoked, old password no longer works, new one does
    assert (await client.get("/api/v1/me", headers=_bearer(old))).status_code == 401
    assert (await _login(client)).status_code == 401
    assert (await _login(client, password=new_password)).status_code == 200
    # single use
    r = await client.post(
        "/api/v1/auth/password/reset", json={"token": token, "new_password": "yet another one!"}
    )
    assert r.status_code == 401
    actions = await _actions(owner_db)
    assert "PASSWORD_RESET_REQUESTED" in actions and "PASSWORD_RESET" in actions


async def test_forgot_password_unknown_email_is_indistinguishable(client, app):
    r = await client.post("/api/v1/auth/password/forgot", json={"email": "nobody@example.com"})
    assert r.status_code == 202
    assert app.state.mailer.sent == []


async def test_reset_rejects_short_password(client):
    r = await client.post(
        "/api/v1/auth/password/reset", json={"token": "x" * 43, "new_password": "short"}
    )
    assert r.status_code == 422


# --- secrets never leak ----------------------------------------------------------------


async def test_secrets_not_logged(client, app, alice, caplog):
    caplog.set_level(logging.DEBUG)
    login = await _login(client)
    await client.post("/api/v1/auth/refresh", headers=CSRF)
    await client.post("/api/v1/auth/password/forgot", json={"email": EMAIL})
    token = _token_from(app.state.mailer.sent[0])
    logs = "\n".join(r.getMessage() + str(r.__dict__) for r in caplog.records)
    for secret in (PASSWORD, login.json()["access_token"], token):
        assert secret not in logs


async def test_jwks_exposes_only_public_key(client):
    r = await client.get("/api/v1/auth/.well-known/jwks.json")
    [key] = r.json()["keys"]
    assert key["kty"] == "OKP" and key["alg"] == "EdDSA"
    assert "d" not in key
