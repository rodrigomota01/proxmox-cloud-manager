"""Proxmox client/provider/mapper against a mocked PVE API (respx) and real fixtures."""

import json
from pathlib import Path

import httpx
import pytest
import respx

from app.providers.base import (
    InstanceKind,
    OperationHandle,
    PowerAction,
    PowerState,
    ProviderAuthError,
    ProviderError,
    ProviderUnavailable,
    ProviderValidationError,
)
from app.providers.proxmox import mapper
from app.providers.proxmox.client import CircuitBreaker, ProxmoxClient
from app.providers.proxmox.provider import ProxmoxProvider

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "proxmox" / "pve8"
URL = "https://pve.test:8006"
API = f"{URL}/api2/json"
SECRET = "0bd5b4b6-aaaa-bbbb-cccc-1234567890ab"

pytestmark = pytest.mark.anyio


def _client(**kw) -> ProxmoxClient:
    kw.setdefault("retries", 2)
    return ProxmoxClient(URL, "cloudmgr@pve!cm", SECRET, **kw)


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    async def instant(_):
        return None

    monkeypatch.setattr("app.providers.proxmox.client.asyncio.sleep", instant)
    monkeypatch.setattr("app.providers.proxmox.provider.asyncio.sleep", instant)


# --- mapper ----------------------------------------------------------------------------


def test_mapper_real_pve8_fixture():
    data = json.loads((FIXTURES / "cluster_resources_vm.json").read_text())["data"]
    inv = mapper.inventory(data)
    assert [i.name for i in inv.instances] == ["cm-test-1", "cm-test-2"]
    vm = inv.instances[0]
    assert vm.kind is InstanceKind.VM and vm.power_state is PowerState.STOPPED
    assert (vm.vcpus, vm.memory_mb, vm.disk_gb) == (2, 4096, 32)
    assert vm.node == "tagima" and vm.pool == "cm-lab"
    assert vm.ref.data == {"vmid": 10001, "node": "tagima", "type": "qemu"}


def test_mapper_nodes_storage_lxc_and_templates():
    inv = mapper.inventory([
        {"type": "node", "node": "tagima", "status": "online", "maxcpu": 16,
         "maxmem": 68719476736, "cpu": 0.12, "mem": 1073741824, "uptime": 99},
        {"type": "lxc", "vmid": 300, "node": "tagima", "name": "ct", "status": "running",
         "maxcpu": 1, "maxmem": 536870912, "maxdisk": 8589934592, "tags": "web;prod"},
        {"type": "qemu", "vmid": 9998, "node": "tagima", "name": "debian13-base",
         "template": 1, "status": "stopped"},
        {"type": "storage", "node": "tagima", "storage": "storage-vz", "plugintype": "dir",
         "content": "images,iso,vztmpl", "shared": 0, "status": "available",
         "maxdisk": 1000, "disk": 400},
        {"type": "sdn", "sdn": "localnetwork", "node": "tagima"},
    ])
    assert inv.nodes[0].online and inv.nodes[0].cpu_count == 16
    [ct] = inv.instances  # template excluded
    assert ct.kind is InstanceKind.CONTAINER and ct.tags == ("web", "prod")
    assert ct.power_state is PowerState.RUNNING
    assert inv.storage[0].content == ("images", "iso", "vztmpl") and inv.storage[0].active


# --- client ----------------------------------------------------------------------------


@respx.mock
async def test_client_sends_token_and_unwraps_data():
    route = respx.get(f"{API}/version").respond(json={"data": {"version": "8.4.19"}})
    client = _client()
    assert await client.get("/version") == {"version": "8.4.19"}
    assert route.calls[0].request.headers["authorization"] == (
        f"PVEAPIToken=cloudmgr@pve!cm={SECRET}"
    )
    await client.aclose()


@respx.mock
async def test_get_retries_transient_errors():
    route = respx.get(f"{API}/version")
    route.side_effect = [
        httpx.ConnectError("boom"),
        httpx.Response(503),
        httpx.Response(200, json={"data": {"version": "8"}}),
    ]
    assert await _client().get("/version") == {"version": "8"}
    assert route.call_count == 3


@respx.mock
async def test_post_is_not_retried():
    route = respx.post(f"{API}/nodes/n/qemu/1/status/start").respond(503)
    with pytest.raises(ProviderUnavailable):
        await _client().post("/nodes/n/qemu/1/status/start")
    assert route.call_count == 1


@respx.mock
@pytest.mark.parametrize(
    ("status", "exc"),
    [(401, ProviderAuthError), (403, ProviderAuthError), (400, ProviderValidationError),
     (500, ProviderError)],
)
async def test_error_mapping(status, exc):
    respx.get(f"{API}/version").respond(status, json={"errors": {"vmid": "bad"}})
    with pytest.raises(exc):
        await _client().get("/version")


@respx.mock
async def test_circuit_breaker_opens_after_failures():
    route = respx.get(f"{API}/version").mock(side_effect=httpx.ConnectTimeout("t"))
    client = _client(retries=0, breaker=CircuitBreaker(threshold=2, reset_seconds=60))
    for _ in range(2):
        with pytest.raises(ProviderUnavailable):
            await client.get("/version")
    calls = route.call_count
    with pytest.raises(ProviderUnavailable, match="circuit breaker"):
        await client.get("/version")
    assert route.call_count == calls  # short-circuited, no request sent


@respx.mock
async def test_secret_never_in_repr_or_errors():
    respx.get(f"{API}/version").respond(401)
    client = _client()
    assert SECRET not in repr(client)
    with pytest.raises(ProviderAuthError) as info:
        await client.get("/version")
    assert SECRET not in str(info.value)


# --- provider --------------------------------------------------------------------------


@respx.mock
async def test_power_and_wait():
    upid = "UPID:tagima:0002A1B3:0001:66:qmstart:10001:cloudmgr@pve!cm:"
    start = respx.post(f"{API}/nodes/tagima/qemu/10001/status/start").respond(json={"data": upid})
    status = respx.get(url__regex=rf"{API}/nodes/tagima/tasks/.+/status").mock(
        side_effect=[
            httpx.Response(200, json={"data": {"status": "running"}}),
            httpx.Response(200, json={"data": {"status": "stopped", "exitstatus": "OK"}}),
        ]
    )
    provider = ProxmoxProvider(_client())
    ref = mapper.instance_ref(10001, "tagima", "qemu")
    op = await provider.power(ref, PowerAction.START)
    result = await provider.wait(op)
    assert start.called and status.call_count == 2 and result.ok


@respx.mock
async def test_wait_reports_task_failure():
    respx.get(url__regex=rf"{API}/nodes/tagima/tasks/.+/status").respond(
        json={"data": {"status": "stopped", "exitstatus": "VM is locked (backup)"}}
    )
    op = OperationHandle({"node": "tagima", "upid": "UPID:x"})
    result = await ProxmoxProvider(_client()).wait(op)
    assert not result.ok and "locked" in result.message


async def test_container_suspend_rejected():
    provider = ProxmoxProvider(_client())
    with pytest.raises(ProviderError):
        await provider.power(mapper.instance_ref(300, "tagima", "lxc"), PowerAction.SUSPEND)


@respx.mock
@pytest.mark.parametrize(
    ("status", "qmp", "expected"),
    [("running", "running", PowerState.RUNNING), ("running", "paused", PowerState.PAUSED),
     ("stopped", None, PowerState.STOPPED)],
)
async def test_get_instance_reads_live_status(status, qmp, expected):
    route = respx.get(f"{API}/nodes/tagima/qemu/10001/status/current").respond(
        json={"data": {"status": status, "qmpstatus": qmp, "name": "cm-test-1", "cpus": 2,
                       "maxmem": 4294967296, "maxdisk": 34359738368, "uptime": 5}}
    )
    ref = mapper.instance_ref(10001, "tagima", "qemu")
    obs = await ProxmoxProvider(_client()).get_instance(ref)
    assert route.called
    assert obs.power_state is expected and obs.vcpus == 2 and obs.memory_mb == 4096
    assert obs.node == "tagima" and obs.name == "cm-test-1"
