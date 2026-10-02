"""Tenants, members, role bindings, projects: RBAC, anti-escalation and cross-tenant
isolation (docs/architecture/03-tenancy-e-rbac.md, roadmap Phase 1 exit criteria)."""

import uuid
from dataclasses import dataclass

import pytest
from sqlalchemy import select

from app.audit.models import AuditLog
from app.iam.models import RoleBinding
from tests.integration.factories import (
    PASSWORD,
    add_member,
    grant_platform,
    make_project,
    make_tenant,
    make_user,
)

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


@dataclass
class World:
    acme: object
    globex: object
    web: object  # acme projects
    db: object
    api: object  # globex project
    users: dict
    _client: object
    _tokens: dict

    async def h(self, who: str, tenant=None) -> dict[str, str]:
        """Auth headers for a user (logs in once), optionally with X-Tenant-Id."""
        if who not in self._tokens:
            r = await self._client.post(
                "/api/v1/auth/login",
                json={"email": f"{who}@example.com", "password": PASSWORD},
            )
            assert r.status_code == 200, r.text
            self._tokens[who] = r.json()["access_token"]
        headers = {"Authorization": f"Bearer {self._tokens[who]}"}
        if tenant is not None:
            headers["X-Tenant-Id"] = str(tenant.id)
        return headers


@pytest.fixture
async def world(owner_db, client, app) -> World:
    # many logins from one test IP
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    acme, globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    web, db = await make_project(owner_db, acme, "web"), await make_project(owner_db, acme, "db")
    api = await make_project(owner_db, globex, "api")
    users = {
        name: await make_user(owner_db, f"{name}@example.com")
        for name in ("root", "alice", "olga", "frank", "carol", "dave", "eve", "nomad")
    }
    await grant_platform(owner_db, users["root"], "PLATFORM_ADMIN")
    await add_member(owner_db, acme, users["alice"], "TENANT_ADMIN")
    await add_member(owner_db, acme, users["olga"], "OPERATOR")
    await add_member(owner_db, acme, users["frank"], "PROJECT_ADMIN", web)
    await add_member(owner_db, acme, users["carol"], "USER", web)
    await add_member(owner_db, acme, users["dave"], "READ_ONLY", db)
    await add_member(owner_db, globex, users["eve"], "TENANT_ADMIN")
    return World(acme, globex, web, db, api, users, client, {})


# --- tenants ---------------------------------------------------------------------------


async def test_list_tenants_only_memberships(client, world):
    r = await client.get("/api/v1/tenants", headers=await world.h("alice"))
    assert [t["slug"] for t in r.json()["items"]] == ["acme"]
    r = await client.get("/api/v1/tenants", headers=await world.h("nomad"))
    assert r.json()["items"] == []


async def test_platform_admin_creates_tenant_with_invited_admin(client, app, world, owner_db):
    body = {"slug": "initech", "name": "Initech", "admin_email": "Peter@Initech.com"}
    r = await client.post("/api/v1/tenants", json=body, headers=await world.h("root"))
    assert r.status_code == 201, r.text
    tenant_id = r.json()["id"]
    assert r.headers["location"] == f"/api/v1/tenants/{tenant_id}"
    [mail] = app.state.mailer.sent
    assert mail.to == "peter@initech.com" and "Initech" in mail.subject
    actions = (await owner_db.execute(select(AuditLog.action))).scalars().all()
    assert {"TENANT_CREATE", "USER_INVITE", "MEMBER_ADD", "ROLE_BINDING_CREATE"} <= set(actions)
    # invited user has no password yet: cannot log in
    r = await client.post(
        "/api/v1/auth/login", json={"email": "peter@initech.com", "password": PASSWORD}
    )
    assert r.status_code == 401

    dup = await client.post("/api/v1/tenants", json=body, headers=await world.h("root"))
    assert dup.status_code == 409


async def test_tenant_admin_cannot_create_tenant(client, world):
    r = await client.post(
        "/api/v1/tenants", json={"slug": "x", "name": "X"}, headers=await world.h("alice")
    )
    assert r.status_code == 403


@pytest.mark.parametrize(("who", "expected"), [("alice", 200), ("carol", 403), ("eve", 404)])
async def test_rename_tenant(client, world, who, expected):
    r = await client.patch(
        f"/api/v1/tenants/{world.acme.id}", json={"name": "ACME Corp"},
        headers=await world.h(who),
    )
    assert r.status_code == expected


async def test_delete_tenant_rules(client, world):
    url = f"/api/v1/tenants/{world.acme.id}"
    alice, root = await world.h("alice"), await world.h("root")

    async def delete(confirm: str, headers: dict) -> int:
        r = await client.request("DELETE", url, json={"confirm": confirm}, headers=headers)
        return r.status_code

    assert await delete("acme", alice) == 403
    assert await delete("nope", root) == 422
    assert await delete("acme", root) == 409  # still has projects
    for p in (world.web, world.db):
        await client.request(
            "DELETE", f"/api/v1/projects/{p.id}", json={"confirm": p.slug},
            headers=await world.h("root", world.acme),
        )
    assert await delete("acme", root) == 204
    assert (await client.get(url, headers=root)).status_code == 404


# --- members and bindings --------------------------------------------------------------


async def test_list_members(client, world):
    url = f"/api/v1/tenants/{world.acme.id}/members"
    r = await client.get(url, headers=await world.h("alice"))
    assert r.status_code == 200
    members = {m["email"]: m for m in r.json()}
    names = ("alice", "olga", "frank", "carol", "dave")
    assert set(members) == {f"{n}@example.com" for n in names}
    assert members["frank@example.com"]["bindings"][0]["scope_type"] == "project"


async def test_invite_new_member(client, app, world):
    r = await client.post(
        f"/api/v1/tenants/{world.acme.id}/members",
        json={"email": "new@example.com", "display_name": "Newbie", "role": "OPERATOR"},
        headers=await world.h("alice"),
    )
    assert r.status_code == 201 and r.json()["invited"] is True
    assert app.state.mailer.sent[0].to == "new@example.com"


async def test_operator_cannot_manage_members(client, world):
    r = await client.post(
        f"/api/v1/tenants/{world.acme.id}/members",
        json={"email": "x@example.com", "role": "READ_ONLY"},
        headers=await world.h("olga"),
    )
    assert r.status_code == 403


async def test_project_admin_manages_only_own_project(client, world):
    frank = await world.h("frank", world.acme)
    url = f"/api/v1/tenants/{world.acme.id}/members"
    ok = await client.post(
        url, json={"email": "nomad@example.com", "role": "USER", "project_id": str(world.web.id)},
        headers=frank,
    )
    assert ok.status_code == 201
    other_project = await client.post(
        url, json={"email": "nomad@example.com", "role": "USER", "project_id": str(world.db.id)},
        headers=frank,
    )
    assert other_project.status_code == 403
    tenant_level = await client.post(
        url, json={"email": "nomad@example.com", "role": "OPERATOR"}, headers=frank
    )
    assert tenant_level.status_code == 403


async def test_cannot_grant_role_above_own(client, world, owner_db):
    # PROJECT_ADMIN at project scope cannot hand out TENANT_ADMIN (wrong scope and more perms)
    r = await client.post(
        "/api/v1/role-bindings",
        json={"user_id": str(world.users["carol"].id), "role": "TENANT_ADMIN"},
        headers=await world.h("frank", world.acme),
    )
    assert r.status_code == 403


async def test_role_scope_must_be_allowed(client, world):
    r = await client.post(
        "/api/v1/role-bindings",
        json={"user_id": str(world.users["carol"].id), "role": "USER"},  # USER: project only
        headers=await world.h("alice", world.acme),
    )
    assert r.status_code == 422


async def test_cannot_change_own_bindings(client, world, owner_db):
    alice = await world.h("alice", world.acme)
    r = await client.post(
        "/api/v1/role-bindings",
        json={"user_id": str(world.users["alice"].id), "role": "OPERATOR"},
        headers=alice,
    )
    assert r.status_code == 403
    own = await owner_db.scalar(
        select(RoleBinding.id).where(RoleBinding.user_id == world.users["alice"].id)
    )
    assert (await client.delete(f"/api/v1/role-bindings/{own}", headers=alice)).status_code == 403


async def test_last_tenant_admin_cannot_be_removed(client, world, owner_db):
    binding = await owner_db.scalar(
        select(RoleBinding.id).where(RoleBinding.user_id == world.users["alice"].id)
    )
    r = await client.delete(
        f"/api/v1/role-bindings/{binding}", headers=await world.h("root", world.acme)
    )
    assert r.status_code == 409


async def test_remove_member_revokes_access_immediately(client, world):
    carol = await world.h("carol", world.acme)
    assert (await client.get("/api/v1/projects", headers=carol)).status_code == 200
    r = await client.delete(
        f"/api/v1/tenants/{world.acme.id}/members/{world.users['carol'].id}",
        headers=await world.h("alice"),
    )
    assert r.status_code == 204
    # same access token, access gone right away (roles are not in the token)
    assert (await client.get("/api/v1/projects", headers=carol)).status_code == 404
    r = await client.get("/api/v1/tenants", headers=carol)
    assert r.json()["items"] == []


async def test_list_and_delete_bindings(client, world):
    alice = await world.h("alice", world.acme)
    r = await client.get(
        "/api/v1/role-bindings", params={"project_id": str(world.web.id)}, headers=alice
    )
    assert {b["role"] for b in r.json()} == {"PROJECT_ADMIN", "USER"}
    carol_binding = next(b for b in r.json() if b["role"] == "USER")
    r = await client.delete(f"/api/v1/role-bindings/{carol_binding['id']}", headers=alice)
    assert r.status_code == 204


# --- projects --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("who", "visible"),
    [("alice", {"web", "db"}), ("olga", {"web", "db"}), ("carol", {"web"}), ("dave", {"db"})],
)
async def test_project_visibility(client, world, who, visible):
    r = await client.get("/api/v1/projects", headers=await world.h(who, world.acme))
    assert {p["slug"] for p in r.json()["items"]} == visible


@pytest.mark.parametrize(
    ("who", "get", "create", "update", "delete"),
    [
        ("alice", 200, 201, 200, 204),
        ("olga", 200, 403, 403, 403),
        ("frank", 200, 403, 403, 403),
        ("carol", 200, 403, 403, 403),
        ("dave", 403, 403, 403, 403),  # READ_ONLY on db only
    ],
)
async def test_project_rbac_matrix(client, world, who, get, create, update, delete):
    h = await world.h(who, world.acme)
    url = f"/api/v1/projects/{world.web.id}"
    assert (await client.get(url, headers=h)).status_code == get
    r = await client.post("/api/v1/projects", json={"slug": f"new-{who}", "name": "n"}, headers=h)
    assert r.status_code == create
    assert (await client.patch(url, json={"name": "Web 2"}, headers=h)).status_code == update
    r = await client.request("DELETE", url, json={"confirm": "web"}, headers=h)
    assert r.status_code == delete


async def test_project_validation_and_conflict(client, world):
    h = await world.h("alice", world.acme)
    for slug in ("UPPER", "-dash", "a" * 40, "sp ace"):
        r = await client.post("/api/v1/projects", json={"slug": slug, "name": "x"}, headers=h)
        assert r.status_code == 422, slug
    r = await client.post("/api/v1/projects", json={"slug": "web", "name": "x"}, headers=h)
    assert r.status_code == 409


async def test_deleted_project_disappears_and_slug_is_reusable(client, world):
    h = await world.h("alice", world.acme)
    url = f"/api/v1/projects/{world.web.id}"
    r = await client.request("DELETE", url, json={"confirm": "web"}, headers=h)
    assert r.status_code == 204
    assert (await client.get(url, headers=h)).status_code == 404
    carol = await world.h("carol", world.acme)
    assert (await client.get("/api/v1/projects", headers=carol)).json()["items"] == []
    r = await client.post("/api/v1/projects", json={"slug": "web", "name": "again"}, headers=h)
    assert r.status_code == 201


async def test_pagination(client, world):
    h = await world.h("alice", world.acme)
    for i in range(3):
        await client.post("/api/v1/projects", json={"slug": f"p{i}", "name": "x"}, headers=h)
    slugs, cursor, pages = [], None, 0
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = (await client.get("/api/v1/projects", params=params, headers=h)).json()
        slugs += [p["slug"] for p in page["items"]]
        pages += 1
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert pages == 3
    assert sorted(slugs) == ["db", "p0", "p1", "p2", "web"]
    bad = await client.get("/api/v1/projects", params={"cursor": "!!"}, headers=h)
    assert bad.status_code == 422


# --- permissions for the UI ------------------------------------------------------------


async def test_me_permissions(client, world):
    carol = await world.h("carol", world.acme)
    r = await client.get(
        "/api/v1/me/permissions", params={"scope": f"project:{world.web.id}"}, headers=carol
    )
    assert "vm:create" in r.json()["permissions"]
    r = await client.get(
        "/api/v1/me/permissions", params={"scope": f"tenant:{world.acme.id}"}, headers=carol
    )
    assert r.json()["permissions"] == []
    r = await client.get(
        "/api/v1/me/permissions", params={"scope": "platform"}, headers=await world.h("root")
    )
    assert "cluster:manage" in r.json()["permissions"]
    r = await client.get(
        "/api/v1/me/permissions", params={"scope": f"tenant:{world.acme.id}"},
        headers=await world.h("eve"),
    )
    assert r.status_code == 404


async def test_platform_admin_access_to_tenant_is_audited(client, world, owner_db):
    r = await client.get("/api/v1/projects", headers=await world.h("root", world.acme))
    assert r.status_code == 200 and len(r.json()["items"]) == 2
    actions = (await owner_db.execute(select(AuditLog.action))).scalars().all()
    assert "PLATFORM_SCOPE_ACCESS" in actions


# --- cross-tenant matrix ---------------------------------------------------------------
# eve is TENANT_ADMIN of globex. Every attempt at acme resources must answer 404 —
# whether she names acme in X-Tenant-Id/path or smuggles acme ids under her own tenant.


def _cross_tenant_cases(w: World) -> list[tuple[str, str, object, dict | None]]:
    acme, web = w.acme, w.web
    carol = w.users["carol"].id
    any_binding = uuid.uuid4()
    return [
        # (header tenant, method, path, json)
        (acme, "GET", "/api/v1/projects", None),
        (acme, "POST", "/api/v1/projects", {"slug": "evil", "name": "evil"}),
        (acme, "GET", f"/api/v1/projects/{web.id}", None),
        (acme, "PATCH", f"/api/v1/projects/{web.id}", {"name": "pwned"}),
        (acme, "DELETE", f"/api/v1/projects/{web.id}", {"confirm": "web"}),
        (acme, "GET", "/api/v1/role-bindings", None),
        (acme, "POST", "/api/v1/role-bindings", {"user_id": str(carol), "role": "OPERATOR"}),
        (acme, "DELETE", f"/api/v1/role-bindings/{any_binding}", None),
        (None, "GET", f"/api/v1/tenants/{acme.id}", None),
        (None, "PATCH", f"/api/v1/tenants/{acme.id}", {"name": "pwned"}),
        (None, "DELETE", f"/api/v1/tenants/{acme.id}", {"confirm": "acme"}),
        (None, "GET", f"/api/v1/tenants/{acme.id}/members", None),
        (None, "POST", f"/api/v1/tenants/{acme.id}/members",
         {"email": "e@x.io", "role": "OPERATOR"}),
        (None, "DELETE", f"/api/v1/tenants/{acme.id}/members/{carol}", None),
        # own tenant in the header, acme ids in the request
        (w.globex, "GET", f"/api/v1/projects/{web.id}", None),
        (w.globex, "PATCH", f"/api/v1/projects/{web.id}", {"name": "pwned"}),
        (w.globex, "DELETE", f"/api/v1/projects/{web.id}", {"confirm": "web"}),
        (w.globex, "POST", "/api/v1/role-bindings",
         {"user_id": str(carol), "role": "USER", "project_id": str(web.id)}),
        (None, "POST", f"/api/v1/tenants/{w.globex.id}/members",
         {"email": "carol@example.com", "role": "USER", "project_id": str(web.id)}),
    ]


async def test_cross_tenant_matrix(client, world, owner_db):
    failures = []
    for tenant, method, path, body in _cross_tenant_cases(world):
        headers = await world.h("eve", tenant)
        r = await client.request(method, path, json=body, headers=headers)
        if r.status_code != 404:
            tenant_slug = tenant.slug if tenant else None
            failures.append(f"{method} {path} (X-Tenant-Id={tenant_slug}): {r.status_code}")
    assert failures == []
    # nothing in acme changed
    owner_db.expire_all()
    await owner_db.refresh(world.web)
    await owner_db.refresh(world.acme)
    assert world.web.name == "web" and world.web.deleted_at is None
    assert world.acme.name == "Acme"
