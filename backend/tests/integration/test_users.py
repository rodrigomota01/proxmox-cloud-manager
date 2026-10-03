"""Profile (/me) and user administration (/admin/users)."""

import pytest
from sqlalchemy import select

from app.audit.models import AuditLog
from app.iam.models import User
from tests.integration.factories import PASSWORD, add_member, grant_platform, make_tenant, make_user

pytestmark = [pytest.mark.anyio, pytest.mark.integration]
NEW_PASSWORD = "a completely new passphrase"


async def _login(client, email, password=PASSWORD):
    return await client.post("/api/v1/auth/login", json={"email": email, "password": password})


def _h(resp) -> dict[str, str]:
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture
async def people(owner_db, app):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    app.state.settings.login_rate_limit_email_per_minute = 1000
    users = {n: await make_user(owner_db, f"{n}@example.com")
             for n in ("sa", "sb", "root", "alice", "bob")}
    await grant_platform(owner_db, users["sa"], "SUPER_ADMIN")
    await grant_platform(owner_db, users["sb"], "SUPER_ADMIN")
    await grant_platform(owner_db, users["root"], "PLATFORM_ADMIN")
    acme = await make_tenant(owner_db, "acme")
    await add_member(owner_db, acme, users["alice"], "TENANT_ADMIN")
    return users


# --- profile ---------------------------------------------------------------------------


async def test_update_display_name(client, people):
    h = _h(await _login(client, "alice@example.com"))
    r = await client.patch("/api/v1/me", json={"display_name": "Alice Doe"}, headers=h)
    assert r.status_code == 200
    assert (await client.get("/api/v1/me", headers=h)).json()["display_name"] == "Alice Doe"
    bad = await client.patch("/api/v1/me", json={"display_name": "x", "email": "a@b.co"}, headers=h)
    assert bad.status_code == 422  # e-mail is not self-service


async def test_change_password_keeps_this_session_and_ends_others(client, people, owner_db):
    other = _h(await _login(client, "alice@example.com"))
    this = _h(await _login(client, "alice@example.com"))
    wrong = await client.post(
        "/api/v1/me/password",
        json={"current_password": "nope", "new_password": NEW_PASSWORD}, headers=this,
    )
    assert wrong.status_code == 403
    r = await client.post(
        "/api/v1/me/password",
        json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}, headers=this,
    )
    assert r.status_code == 204
    assert (await client.get("/api/v1/me", headers=this)).status_code == 200
    assert (await client.get("/api/v1/me", headers=other)).status_code == 401
    assert (await _login(client, "alice@example.com")).status_code == 401
    assert (await _login(client, "alice@example.com", NEW_PASSWORD)).status_code == 200
    outcomes = (await owner_db.execute(
        select(AuditLog.outcome).where(AuditLog.action == "PASSWORD_CHANGE")
    )).scalars().all()
    assert sorted(outcomes) == ["failure", "success"]


async def test_sessions_list_and_revoke(client, people):
    first = _h(await _login(client, "alice@example.com"))
    second = _h(await _login(client, "alice@example.com"))
    sessions = (await client.get("/api/v1/me/sessions", headers=second)).json()
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    other_id = next(s["id"] for s in sessions if not s["current"])
    r = await client.delete(f"/api/v1/me/sessions/{other_id}", headers=second)
    assert r.status_code == 204
    assert (await client.get("/api/v1/me", headers=first)).status_code == 401
    # someone else's session: not found
    bob = _h(await _login(client, "bob@example.com"))
    current = (await client.get("/api/v1/me/sessions", headers=second)).json()[0]["id"]
    assert (await client.delete(f"/api/v1/me/sessions/{current}", headers=bob)).status_code == 404


# --- admin -----------------------------------------------------------------------------


async def test_only_platform_admins_manage_users(client, people):
    alice = _h(await _login(client, "alice@example.com"))
    assert (await client.get("/api/v1/admin/users", headers=alice)).status_code == 403
    root = _h(await _login(client, "root@example.com"))
    r = await client.get("/api/v1/admin/users", params={"q": "ALI"}, headers=root)
    assert [u["email"] for u in r.json()["items"]] == ["alice@example.com"]


async def test_create_edit_deactivate_reactivate(client, app, people, owner_db):
    root = _h(await _login(client, "root@example.com"))
    r = await client.post(
        "/api/v1/admin/users", json={"email": "New@Example.com", "display_name": "Newbie"},
        headers=root,
    )
    assert r.status_code == 201 and r.json()["invited"] is True
    assert app.state.mailer.sent[-1].to == "new@example.com"
    dup = await client.post(
        "/api/v1/admin/users", json={"email": "new@example.com", "display_name": "x"},
        headers=root,
    )
    assert dup.status_code == 409

    bob_id = str(people["bob"].id)
    bob = _h(await _login(client, "bob@example.com"))
    r = await client.patch(f"/api/v1/admin/users/{bob_id}",
                           json={"display_name": "Robert", "email": "robert@example.com"},
                           headers=root)
    assert r.json()["email"] == "robert@example.com" and r.json()["display_name"] == "Robert"
    taken = await client.patch(f"/api/v1/admin/users/{bob_id}",
                               json={"email": "alice@example.com"}, headers=root)
    assert taken.status_code == 409

    r = await client.patch(f"/api/v1/admin/users/{bob_id}", json={"is_active": False},
                           headers=root)
    assert r.json()["is_active"] is False and r.json()["active_sessions"] == 0
    assert (await client.get("/api/v1/me", headers=bob)).status_code == 401  # signed out now
    assert (await _login(client, "robert@example.com")).status_code == 401
    reset = await client.post(f"/api/v1/admin/users/{bob_id}/password-reset", headers=root)
    assert reset.status_code == 409  # inactive

    await client.patch(f"/api/v1/admin/users/{bob_id}", json={"is_active": True}, headers=root)
    assert (await _login(client, "robert@example.com")).status_code == 200
    reset = await client.post(f"/api/v1/admin/users/{bob_id}/password-reset", headers=root)
    assert reset.status_code == 202 and app.state.mailer.sent[-1].to == "robert@example.com"


async def test_unlock_and_revoke_sessions(client, people, owner_db):
    bob_id = people["bob"].id
    for _ in range(5):
        await _login(client, "bob@example.com", "wrong password!!")
    bob = await owner_db.get(User, bob_id, populate_existing=True)
    assert bob.locked_until is not None
    root = _h(await _login(client, "root@example.com"))
    r = await client.post(f"/api/v1/admin/users/{bob_id}/unlock", headers=root)
    assert r.json()["locked"] is False
    session = _h(await _login(client, "bob@example.com"))
    r = await client.post(f"/api/v1/admin/users/{bob_id}/sessions/revoke", headers=root)
    assert r.json() == {"sessions_revoked": 1}
    assert (await client.get("/api/v1/me", headers=session)).status_code == 401


async def test_guards(client, people):
    root = _h(await _login(client, "root@example.com"))
    sa = _h(await _login(client, "sa@example.com"))
    # a PLATFORM_ADMIN cannot touch a SUPER_ADMIN account
    r = await client.patch(f"/api/v1/admin/users/{people['sa'].id}",
                           json={"is_active": False}, headers=root)
    assert r.status_code == 403
    # nobody edits themselves here (profile page instead)
    r = await client.patch(f"/api/v1/admin/users/{people['root'].id}",
                           json={"display_name": "me"}, headers=root)
    assert r.status_code == 403
    # platform roles need platform:admin (SUPER_ADMIN only)
    url = f"/api/v1/admin/users/{people['alice'].id}/platform-roles"
    denied = await client.put(url, json={"roles": ["PLATFORM_ADMIN"]}, headers=root)
    assert denied.status_code == 403
    r = await client.put(url, json={"roles": ["PLATFORM_ADMIN"]}, headers=sa)
    assert r.json() == {"platform_roles": ["PLATFORM_ADMIN"]}
    for bad in (["TENANT_ADMIN"], ["NOPE"]):
        assert (await client.put(url, json={"roles": bad}, headers=sa)).status_code == 422
    r = await client.put(url, json={"roles": []}, headers=sa)
    assert r.json() == {"platform_roles": []}
    # cannot change one's own platform roles
    own = f"/api/v1/admin/users/{people['sa'].id}/platform-roles"
    assert (await client.put(own, json={"roles": []}, headers=sa)).status_code == 403
    # another SUPER_ADMIN can (sb remains as active SUPER_ADMIN)
    sb = _h(await _login(client, "sb@example.com"))
    r = await client.put(own, json={"roles": ["PLATFORM_ADMIN"]}, headers=sb)
    assert r.json() == {"platform_roles": ["PLATFORM_ADMIN"]}
