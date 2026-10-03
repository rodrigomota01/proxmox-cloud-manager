"""Legacy IPAM (awf_ip_pool) copy, matching against guest NICs, network profiles."""

from dataclasses import dataclass, field

import pytest

from app.ipam import service as ipam_service
from app.ipam.source import PoolRow
from app.ipam.sync import parse_address
from app.jobs import handlers  # noqa: F401 - registers job handlers
from app.jobs.queue import run_one
from app.providers.base import GuestNic
from tests.integration.factories import PASSWORD, grant_platform, make_user

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


def row(id_, ip, *, assigned=False, mac=None, host=None, node="tagima"):
    return PoolRow(id=id_, ip_addr=ip, assigned=assigned, mac=mac, host_owner=None,
                   hostname=host, hypervisor="hv08.sp02.atena.io", node=node, ip_block=None)


@dataclass
class FakeSource:
    rows: list[PoolRow] = field(default_factory=list)
    reserved: list[tuple[int, str, str | None]] = field(default_factory=list)

    async def fetch(self):
        return list(self.rows)

    async def reserve(self, row_id, *, hostname, mac):
        self.reserved.append((row_id, hostname, mac))
        return True

    async def release(self, row_id, *, hostname, clear_mac):
        return True


@pytest.fixture
async def env(owner_db, client, app, registry, fake):
    app.state.settings.login_rate_limit_ip_per_minute = 1000
    root = await make_user(owner_db, "root@example.com")
    await grant_platform(owner_db, root, "PLATFORM_ADMIN")
    await make_user(owner_db, "nobody@example.com")
    r = await client.post("/api/v1/auth/login",
                          json={"email": "root@example.com", "password": PASSWORD})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = await client.post("/api/v1/admin/clusters", headers=h,
                          json={"name": "hv08", "api_url": "https://pve.test:8006"})
    cid = r.json()["id"]
    await client.put(f"/api/v1/admin/clusters/{cid}/credentials", headers=h,
                     json={"token_id": "cloudmgr@pve!cm",
                           "secret": "8c1b7f2e-5a4d-4e8b-9f3c-2d6a1b0e7c55"})
    source = FakeSource()
    ipam_service.configure(source)

    async def drain():
        while await run_one(app.state.sessionmaker, app.state.providers, "t"):
            pass

    await client.post(f"/api/v1/admin/clusters/{cid}/sync", headers=h)
    await drain()
    yield {"h": h, "cid": cid, "source": source, "drain": drain}
    ipam_service.configure(None)


def test_parse_address():
    assert parse_address("152.236.18.11/31") == ("152.236.18.11", 31)
    assert parse_address("177.54.151.42") == ("177.54.151.42", None)
    assert parse_address("not-an-ip") is None


async def test_report_matches_ipam_with_guest_nics(client, env, fake):
    h, cid, source = env["h"], env["cid"], env["source"]
    # 10001 (vm): cloud-init IP .13 although the IPAM says free -> conflict
    fake.nics["10001"] = [GuestNic("net0", "bc:24:11:00:00:01", "vmbr0", None,
                                   "152.236.18.13/31", "152.236.18.12")]
    # 10002 (ct): only the MAC is registered (no IP in config) -> in use by MAC
    fake.nics["10002"] = [GuestNic("net0", "be:80:46:72:1e:a2", "vmbr0", 151,
                                   "177.54.151.188/24", "177.54.151.1")]
    source.rows = [
        row(1, "152.236.18.11/31", assigned=True, host="old-vm"),       # nobody -> stale
        row(8, "152.236.18.15/31", assigned=True, host="cm-test-2"),    # guest w/o it
        row(2, "152.236.18.13/31", mac="bc:24:11:8a:5c:fd"),            # used -> conflict
        row(3, "152.236.18.25/31"),                                      # free
        row(4, "177.54.151.188", assigned=True, mac="be:80:46:72:1e:a2"),  # in use
        row(5, "177.54.151.133", mac="66:84:60:b8:38:61"),              # free (vMAC ready)
        row(6, "177.54.144.198", node="ferrari"),                        # other server
        row(7, "garbage"),
    ]
    r = await client.post("/api/v1/admin/ipam/sync", headers=h)
    assert r.status_code == 202
    await env["drain"]()

    status = (await client.get("/api/v1/admin/ipam", headers=h)).json()
    assert status["configured"] and status["addresses"] == 7 and status["integrated"] == 6

    rep = (await client.get(f"/api/v1/admin/clusters/{cid}/ipam", headers=h)).json()
    by_ip = {a["address"]: a for a in rep["addresses"]}
    assert {ip: a["status"] for ip, a in by_ip.items()} == {
        "152.236.18.11": "stale", "152.236.18.13": "conflict", "152.236.18.25": "free",
        "152.236.18.15": "detached",
        "177.54.151.133": "free", "177.54.151.188": "in_use",
    }
    assert by_ip["152.236.18.13"]["guest"]["name"] == "cm-test-1"
    assert by_ip["152.236.18.13"]["mac_mismatch"] == "bc:24:11:00:00:01"
    assert by_ip["152.236.18.15"]["guest"]["name"] == "cm-test-2"
    assert rep["counts"] == {"stale": 1, "conflict": 1, "free": 2, "in_use": 1, "detached": 1}
    # the /24 used by guests and holding IPAM addresses is offered as a network profile
    assert [(s["cidr"], s["gateway"], s["vlan"]) for s in rep["suggestions"]] == [
        ("177.54.151.0/24", "177.54.151.1", 151)
    ]


async def test_unregistered_public_ips(client, env, fake):
    fake.nics["10001"] = [GuestNic("net0", "aa:aa:aa:aa:aa:aa", "vmbr0", None,
                                   "203.0.113.50/24", "203.0.113.1")]
    fake.nics["10002"] = [GuestNic("net0", None, "vmbr1", None, "10.0.0.5/24", "10.0.0.1")]
    env["source"].rows = [row(1, "152.236.18.25/31")]
    await client.post("/api/v1/admin/ipam/sync", headers=env["h"])
    await env["drain"]()
    rep = (await client.get(f"/api/v1/admin/clusters/{env['cid']}/ipam", headers=env["h"])).json()
    # 203.0.113.0/24 is documentation space, so not "global": nothing public unregistered
    assert rep["unregistered"] == []
    fake.nics["10001"] = [GuestNic("net0", "aa:aa:aa:aa:aa:aa", "vmbr0", None,
                                   "8.8.4.4/24", "8.8.4.1")]
    await client.post("/api/v1/admin/ipam/sync", headers=env["h"])
    await env["drain"]()
    rep = (await client.get(f"/api/v1/admin/clusters/{env['cid']}/ipam", headers=env["h"])).json()
    found = [(u["ip"], u["guest"]["name"]) for u in rep["unregistered"]]
    assert found == [("8.8.4.4", "cm-test-1")]


async def test_network_profiles(client, env):
    h, cid = env["h"], env["cid"]
    path = f"/api/v1/admin/clusters/{cid}/ipam/networks"
    bad = await client.post(path, headers=h,
                            json={"cidr": "177.54.151.0/24", "gateway": "10.0.0.1"})
    assert bad.status_code == 422
    ok = await client.post(path, headers=h, json={"cidr": "177.54.151.7/24",
                                                  "gateway": "177.54.151.1", "vlan": 151})
    assert ok.status_code == 201 and ok.json()["cidr"] == "177.54.151.0/24"
    dup = await client.post(path, headers=h, json={"cidr": "177.54.151.0/24",
                                                   "gateway": "177.54.151.1"})
    assert dup.status_code == 409
    r = await client.delete(f"/api/v1/admin/ipam/networks/{ok.json()['id']}", headers=h)
    assert r.status_code == 204


async def test_sync_without_configuration_fails_clearly(client, env):
    ipam_service.configure(None)
    r = await client.post("/api/v1/admin/ipam/sync", headers=env["h"])
    await env["drain"]()
    job = (await client.get(f"/api/v1/admin/jobs/{r.json()['job']['id']}", headers=env["h"])).json()
    assert job["status"] == "failed" and job["error_code"] == "IPAM_NOT_CONFIGURED"


async def test_ipam_is_admin_only(client, env):
    r = await client.post("/api/v1/auth/login",
                          json={"email": "nobody@example.com", "password": PASSWORD})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    for path in ("/api/v1/admin/ipam", f"/api/v1/admin/clusters/{env['cid']}/ipam"):
        assert (await client.get(path, headers=h)).status_code == 403
