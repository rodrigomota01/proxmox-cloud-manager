"""Alert rules -> evaluation -> notifications, and who sees what."""

import hashlib
import hmac
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.alerts import notify
from app.alerts.evaluator import evaluate, run_alerts
from app.alerts.models import Alert
from app.compute.models import Instance
from app.db.session import set_platform_scope
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.queue import run_one
from tests.integration.conftest import OutboxMailer
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
class FakeWebhook:
    calls: list[tuple[str, bytes, dict[str, str]]] = field(default_factory=list)

    async def post(self, url: str, body: bytes, headers: dict[str, str]) -> None:
        self.calls.append((url, body, headers))


class Env:
    def __init__(self, client, app):
        self.client, self.app = client, app
        self.tokens: dict[str, str] = {}

    async def h(self, who: str, tenant=None) -> dict[str, str]:
        if who not in self.tokens:
            r = await self.client.post(
                "/api/v1/auth/login", json={"email": f"{who}@example.com", "password": PASSWORD}
            )
            self.tokens[who] = r.json()["access_token"]
        headers = {"Authorization": f"Bearer {self.tokens[who]}"}
        if tenant is not None:
            headers["X-Tenant-Id"] = str(tenant.id)
        return headers

    async def drain(self) -> None:
        state = self.app.state
        while await run_one(state.sessionmaker, state.providers, "test-worker"):
            pass


@pytest.fixture
async def env(owner_db, client, app, registry, settings):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    e = Env(client, app)
    e.mailer, e.webhook = OutboxMailer(), FakeWebhook()
    notify.configure(notify.Notifier(app.state.settings, e.mailer, e.webhook, registry.secrets))
    e.acme, e.globex = await make_tenant(owner_db, "acme"), await make_tenant(owner_db, "globex")
    e.web = await make_project(owner_db, e.acme, "web")
    e.db = await make_project(owner_db, e.acme, "db")
    for name in ("root", "alice", "carol", "dave", "eve"):
        setattr(e, name, await make_user(owner_db, f"{name}@example.com"))
    await grant_platform(owner_db, e.root, "PLATFORM_ADMIN")
    await add_member(owner_db, e.acme, e.alice, "TENANT_ADMIN")
    await add_member(owner_db, e.acme, e.carol, "USER", e.web)
    await add_member(owner_db, e.acme, e.dave, "READ_ONLY", e.db)
    await add_member(owner_db, e.globex, e.eve, "TENANT_ADMIN")
    root = await e.h("root")
    r = await client.post(
        "/api/v1/admin/clusters",
        json={"name": "lab", "api_url": "https://pve.test:8006", "pool": "cm-lab"}, headers=root,
    )
    cid = r.json()["id"]
    await client.put(
        f"/api/v1/admin/clusters/{cid}/credentials",
        json={"token_id": "cloudmgr@pve!cm", "secret": "0e5c6a3e-1b2d-4f6a-9c8b-7d6e5f4a3b2c"},
        headers=root,
    )
    await client.post(f"/api/v1/admin/clusters/{cid}/sync", headers=root)
    await e.drain()
    listed = (await client.get("/api/v1/admin/instances", headers=root)).json()
    found = {i["vmid"]: i["id"] for i in listed}
    for vmid, project in ((10001, e.web), (10002, e.db)):
        await client.post(
            f"/api/v1/admin/instances/{found[vmid]}/adopt",
            json={"tenant_id": str(e.acme.id), "project_id": str(project.id)}, headers=root,
        )
    e.vm, e.ct = found[10001], found[10002]
    yield e
    notify.configure(None)


async def _usage(owner_db, instance_id, **values):
    await owner_db.execute(
        Instance.__table__.update().where(Instance.id == instance_id)
        .values(power_state="running", **values)
    )
    await owner_db.commit()


async def _rule(client, headers, path="/api/v1/admin/alert-rules", **body):
    body = {"name": "cpu", "metric": "cpu", "threshold": 0.8, "duration_seconds": 0, **body}
    r = await client.post(path, json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


async def _evaluate(app, now):
    async with app.state.sessionmaker() as db, db.begin():  # cm_app, like the worker
        await set_platform_scope(db)
        return await evaluate(db, now)


async def test_pending_firing_resolved_with_hysteresis(client, env, app, owner_db):
    await _rule(client, await env.h("root"), duration_seconds=60)
    t0 = datetime.now(UTC)
    await _usage(owner_db, env.vm, cpu_usage=0.9)

    assert await _evaluate(app, t0) == []  # pending: not long enough yet
    assert await _evaluate(app, t0 + timedelta(seconds=30)) == []
    [fired] = await _evaluate(app, t0 + timedelta(seconds=61))
    assert fired.event == "firing"

    await _usage(owner_db, env.vm, cpu_usage=0.78)  # below 80%, above the 76% clear line
    assert await _evaluate(app, t0 + timedelta(seconds=90)) == []
    await _usage(owner_db, env.vm, cpu_usage=0.5)
    [resolved] = await _evaluate(app, t0 + timedelta(seconds=120))
    assert resolved.event == "resolved" and resolved.alert_id == fired.alert_id
    alert = await owner_db.get(Alert, fired.alert_id)
    assert alert.state == "resolved" and alert.peak == 0.9

    # a spike shorter than the duration never fires and leaves nothing behind
    await _usage(owner_db, env.vm, cpu_usage=0.95)
    await _evaluate(app, t0 + timedelta(seconds=200))
    await _usage(owner_db, env.vm, cpu_usage=0.1)
    assert await _evaluate(app, t0 + timedelta(seconds=210)) == []
    open_alerts = await owner_db.scalar(
        select(Alert.id).where(Alert.state.in_(("pending", "firing")))
    )
    assert open_alerts is None


async def test_stopped_guest_resolves_and_disabled_rule_resolves(client, env, app, owner_db):
    rule = await _rule(client, await env.h("root"))
    await _usage(owner_db, env.vm, cpu_usage=0.9)
    assert [c.event for c in await _evaluate(app, datetime.now(UTC))] == ["firing"]
    r = await client.patch(f"/api/v1/admin/alert-rules/{rule['id']}", json={"enabled": False},
                           headers=await env.h("root"))
    assert r.status_code == 200
    assert [c.event for c in await _evaluate(app, datetime.now(UTC))] == ["resolved"]


async def test_notifications_reach_rule_owner_and_resource_owner(client, env, app, owner_db):
    root, alice = await env.h("root"), await env.h("alice", env.acme)
    eve = await env.h("eve", env.globex)
    for headers, path, to in (
        (root, "/api/v1/admin/notification-channels", "ops@example.com"),
        (alice, "/api/v1/notification-channels", "acme-ops@example.com"),
        (eve, "/api/v1/notification-channels", "globex@example.com"),
    ):
        r = await client.post(path, json={"name": to, "type": "email", "to": [to]}, headers=headers)
        assert r.status_code == 201, r.text
    await _rule(client, root, name="VM com CPU alta")  # platform rule
    await _rule(client, alice, path="/api/v1/alert-rules", name="memória", metric="memory",
                threshold=0.5)  # acme's own rule
    await _usage(owner_db, env.vm, cpu_usage=0.9, memory_used_mb=1536)  # 1.5 of 2 GiB

    changes = await run_alerts(app.state.sessionmaker)
    assert len(changes) == 2
    await env.drain()
    sent = sorted((m.to, m.subject) for m in env.mailer.sent)
    assert [to for to, _ in sent] == ["acme-ops@example.com", "acme-ops@example.com",
                                      "ops@example.com"]
    assert any("CPU 90%" in subject for _, subject in sent)
    assert not any(to == "globex@example.com" for to, _ in sent)


async def test_tenant_rule_ignores_other_tenants_and_hosts(client, env, app, owner_db):
    eve = await env.h("eve", env.globex)
    await _rule(client, eve, path="/api/v1/alert-rules")  # globex watches its (no) VMs
    await _usage(owner_db, env.vm, cpu_usage=0.99)  # acme's VM
    assert await _evaluate(app, datetime.now(UTC)) == []

    r = await client.post("/api/v1/alert-rules", headers=eve, json={
        "name": "host", "target": "node", "metric": "cpu", "threshold": 0.5,
    })
    assert r.status_code == 422  # clients watch instances only


async def test_who_sees_which_alerts(client, env, app, owner_db):
    root = await env.h("root")
    await _rule(client, root)
    await _rule(client, root, name="host cpu", target="node", threshold=0.05)  # node at 10%
    await _usage(owner_db, env.vm, cpu_usage=0.9)
    await _usage(owner_db, env.ct, cpu_usage=0.9)
    await _evaluate(app, datetime.now(UTC))

    async def names(who, tenant):
        r = await client.get("/api/v1/alerts", headers=await env.h(who, tenant))
        assert r.status_code == 200, r.text
        return sorted(a["resource_name"] for a in r.json())

    assert await names("alice", env.acme) == ["cm-test-1", "cm-test-2"]  # no host alerts
    assert await names("carol", env.acme) == ["cm-test-1"]  # project web only
    assert await names("dave", env.acme) == ["cm-test-2"]  # project db only
    assert await names("eve", env.globex) == []
    r = await client.get("/api/v1/alerts", headers=await env.h("eve", env.acme))
    assert r.status_code == 404

    admin = (await client.get("/api/v1/admin/alerts", headers=root)).json()
    assert sorted(a["resource_type"] for a in admin) == ["instance", "instance", "node"]
    assert {a["tenant_name"] for a in admin} == {"Acme", None}
    summary = (await client.get("/api/v1/alerts/summary", headers=await env.h("carol", env.acme)))
    assert summary.json() == {"firing": 1, "critical": 0}


async def test_rule_and_channel_validation_and_permissions(client, env):
    alice, carol = await env.h("alice", env.acme), await env.h("carol", env.acme)
    assert (await client.get("/api/v1/alert-rules", headers=carol)).status_code == 403
    bad = [
        {"name": "x", "metric": "cpu", "threshold": 90},  # percent, not fraction
        {"name": "x", "target": "storage", "metric": "cpu", "threshold": 0.5},
        {"name": "x", "metric": "cpu", "threshold": 0},
    ]
    for body in bad:
        r = await client.post("/api/v1/admin/alert-rules", json=body, headers=await env.h("root"))
        assert r.status_code == 422, body
    for body in (
        {"name": "w", "type": "webhook", "url": "http://hooks.example.com/x"},  # not https
        {"name": "w", "type": "webhook", "url": "https://user:pw@hooks.example.com/x"},
        {"name": "e", "type": "email", "to": []},
        {"name": "e", "type": "email", "to": ["not-an-email"]},
    ):
        r = await client.post("/api/v1/notification-channels", json=body, headers=alice)
        assert r.status_code == 422, body


async def test_webhook_is_signed_and_secret_shown_once(client, env, app, owner_db):
    alice = await env.h("alice", env.acme)
    r = await client.post("/api/v1/notification-channels", headers=alice, json={
        "name": "chat", "type": "webhook", "url": "https://hooks.example.com/cm",
    })
    assert r.status_code == 201, r.text
    created = r.json()
    secret, channel_id = created["signing_secret"], created["id"]
    assert secret and created["signed"]
    listed = (await client.get("/api/v1/notification-channels", headers=alice)).json()
    assert "signing_secret" not in listed[0]

    r = await client.post(f"/api/v1/notification-channels/{channel_id}/test", headers=alice)
    assert r.status_code == 202
    await env.drain()
    job = (await client.get(f"/api/v1/jobs/{r.json()['job']['id']}", headers=alice)).json()
    assert job["status"] == "succeeded", job
    [(url, body, headers)] = env.webhook.calls
    assert url == "https://hooks.example.com/cm" and json.loads(body)["event"] == "test"
    expected = hmac.new(secret.encode(), headers["X-CM-Timestamp"].encode() + b"." + body,
                        hashlib.sha256).hexdigest()
    assert headers["X-CM-Signature"] == f"sha256={expected}"


async def test_webhook_refuses_internal_targets(settings):
    sender = notify.HttpWebhookSender(settings)
    for url in ("https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/x",
                "https://10.0.0.5/x", "http://example.com/x"):
        with pytest.raises(notify.WebhookRejected):
            await sender.post(url, b"{}", {})


async def test_failed_receiver_is_retried(client, env, app, owner_db, monkeypatch):
    root = await env.h("root")
    r = await client.post("/api/v1/admin/notification-channels", headers=root, json={
        "name": "ops", "type": "email", "to": ["ops@example.com"],
    })
    calls = {"n": 0}

    async def flaky(mail):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("smtp down")
        env.mailer.sent.append(mail)

    monkeypatch.setattr(env.mailer, "send", flaky)
    await _rule(client, root)
    await _usage(owner_db, env.vm, cpu_usage=0.9)
    await run_alerts(app.state.sessionmaker)
    await env.drain()  # first attempt fails and is rescheduled
    from app.jobs.models import Job

    await owner_db.execute(Job.__table__.update().values(run_after=datetime.now(UTC)))
    await owner_db.commit()
    await env.drain()
    assert calls["n"] == 2 and len(env.mailer.sent) == 1
    assert r.status_code == 201
