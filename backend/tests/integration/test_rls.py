"""PostgreSQL RLS and grants as cm_app (ADR-0004, docs/architecture/03-tenancy-e-rbac.md)."""

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, ProgrammingError

from app.audit import service as audit
from app.audit.models import AuditLog
from app.db.session import set_platform_scope, set_tenant_scope, set_user_scope
from app.tenancy.models import Project, Tenant, TenantMembership
from tests.integration.factories import add_member, make_project, make_tenant, make_user

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


@pytest.fixture
async def two_tenants(owner_db):
    a, b = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    pa, pb = await make_project(owner_db, a, "web"), await make_project(owner_db, b, "web")
    return a, b, pa, pb


async def _count(db, model) -> int:
    return (await db.execute(select(func.count()).select_from(model))).scalar_one()


async def test_no_scope_sees_nothing(app_db, two_tenants):
    async with app_db.begin():
        assert await _count(app_db, Project) == 0
        assert await _count(app_db, Tenant) == 0


async def test_tenant_scope_sees_only_own_rows(app_db, two_tenants):
    a, _, pa, _ = two_tenants
    async with app_db.begin():
        await set_tenant_scope(app_db, [a.id])
        rows = (await app_db.execute(select(Project))).scalars().all()
        assert [p.id for p in rows] == [pa.id]
        assert [t.id for t in (await app_db.execute(select(Tenant))).scalars()] == [a.id]


async def test_scope_does_not_leak_to_next_transaction(app_db, two_tenants):
    a, *_ = two_tenants
    async with app_db.begin():
        await set_tenant_scope(app_db, [a.id])
        assert await _count(app_db, Project) == 1
    async with app_db.begin():  # same pooled connection, new transaction
        assert await _count(app_db, Project) == 0


async def test_cannot_insert_into_other_tenant(app_db, two_tenants):
    a, b, _, _ = two_tenants
    with pytest.raises(ProgrammingError, match="row-level security"):
        async with app_db.begin():
            await set_tenant_scope(app_db, [a.id])
            app_db.add(Project(tenant_id=b.id, slug="evil", name="evil"))
            await app_db.flush()


async def test_cannot_move_row_to_other_tenant(app_db, two_tenants):
    a, b, pa, _ = two_tenants
    with pytest.raises(ProgrammingError, match="row-level security"):
        async with app_db.begin():
            await set_tenant_scope(app_db, [a.id])
            await app_db.execute(
                text("UPDATE projects SET tenant_id = :b WHERE id = :p"), {"b": b.id, "p": pa.id}
            )


async def test_update_delete_of_other_tenant_affect_nothing(app_db, two_tenants):
    a, _, _, pb = two_tenants
    async with app_db.begin():
        await set_tenant_scope(app_db, [a.id])
        upd = await app_db.execute(
            text("UPDATE projects SET name = 'pwned' WHERE id = :p"), {"p": pb.id}
        )
        dele = await app_db.execute(text("DELETE FROM projects WHERE id = :p"), {"p": pb.id})
        assert upd.rowcount == 0
        assert dele.rowcount == 0


async def test_platform_scope_sees_all(app_db, two_tenants):
    async with app_db.begin():
        await set_platform_scope(app_db)
        assert await _count(app_db, Project) == 2


async def test_user_scope_sees_own_memberships_and_tenants_only(app_db, owner_db, two_tenants):
    a, b, _, _ = two_tenants
    alice = await make_user(owner_db, "alice@example.com")
    bob = await make_user(owner_db, "bob@example.com")
    await add_member(owner_db, a, alice)
    await add_member(owner_db, b, bob)
    async with app_db.begin():
        await set_user_scope(app_db, alice.id)
        memberships = (await app_db.execute(select(TenantMembership))).scalars().all()
        assert {m.tenant_id for m in memberships} == {a.id}
        assert [t.id for t in (await app_db.execute(select(Tenant))).scalars()] == [a.id]
        assert await _count(app_db, Project) == 0  # user scope alone grants no tenant data


async def test_audit_is_append_only(app_db, two_tenants):
    a, *_ = two_tenants
    async with app_db.begin():
        await audit.record(app_db, "TEST_EVENT", tenant_id=a.id)
    for stmt in ("UPDATE audit_logs SET action = 'x'", "DELETE FROM audit_logs"):
        with pytest.raises(ProgrammingError, match="permission denied"):
            async with app_db.begin():
                await set_platform_scope(app_db)
                await app_db.execute(text(stmt))


async def test_audit_read_is_tenant_scoped(app_db, two_tenants):
    a, b, _, _ = two_tenants
    async with app_db.begin():
        await audit.record(app_db, "EVENT_A", tenant_id=a.id)
        await audit.record(app_db, "EVENT_B", tenant_id=b.id)
        await audit.record(app_db, "EVENT_GLOBAL")
    async with app_db.begin():
        await set_tenant_scope(app_db, [a.id])
        actions = (await app_db.execute(select(AuditLog.action))).scalars().all()
        assert actions == ["EVENT_A"]


@pytest.mark.parametrize(
    "stmt",
    [
        "INSERT INTO permissions (name) VALUES ('evil:grant')",
        "UPDATE roles SET name = 'X' WHERE name = 'READ_ONLY'",
        "DELETE FROM role_permissions",
        "UPDATE alembic_version SET version_num = '0'",
        "CREATE TABLE evil (id int)",
        "ALTER TABLE projects DISABLE ROW LEVEL SECURITY",
    ],
)
async def test_app_role_cannot_change_catalog_or_schema(app_db, stmt):
    with pytest.raises((ProgrammingError, DBAPIError)):
        async with app_db.begin():
            await app_db.execute(text(stmt))
