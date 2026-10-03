"""Proxmox client/provider/mapper against a mocked PVE API (respx) and real fixtures."""

import json
from pathlib import Path

import httpx
import pytest
import respx

from app.providers.base import (
    GuestAgentUnavailable,
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


def test_mapper_usage_and_rrd_points():
    [vm] = mapper.inventory([{
        "type": "qemu", "vmid": 10001, "node": "tagima", "name": "web", "status": "running",
        "maxcpu": 2, "maxmem": 4294967296, "mem": 1073741824, "cpu": 0.37, "uptime": 120,
    }]).instances
    assert vm.cpu_usage == 0.37 and vm.memory_used_mb == 1024 and vm.uptime_seconds == 120

    rows = [
        {"time": 1700000060, "cpu": 0.5, "mem": 2147483648, "maxmem": 4294967296,
         "netin": 1000.5, "netout": 10, "diskread": 0, "diskwrite": 4096},
        {"time": 1700000000},  # stopped guest: PVE returns timestamps without values
    ]
    points = [p for p in map(mapper.metric_point, rows) if p]
    assert len(points) == 1
    assert points[0].memory_used_mb == 2048 and points[0].net_in_bps == 1000.5


@respx.mock
async def test_metrics_asks_rrd_and_sorts():
    route = respx.get(f"{API}/nodes/tagima/qemu/10001/rrddata").respond(json={"data": [
        {"time": 20, "cpu": 0.2, "mem": 0, "maxmem": 0},
        {"time": 10, "cpu": 0.1, "mem": 0, "maxmem": 0},
    ]})
    points = await ProxmoxProvider(_client()).metrics(
        mapper.instance_ref(10001, "tagima", "qemu"), "day"
    )
    assert [p.time for p in points] == [10, 20]
    assert route.calls[0].request.url.params["timeframe"] == "day"


def test_mapper_counters_and_container_disk():
    vm, ct = mapper.inventory([
        {"type": "qemu", "vmid": 1, "node": "n", "status": "running", "maxdisk": 32 * 1024**3,
         "disk": 0, "netin": 5000, "netout": 700},
        {"type": "lxc", "vmid": 2, "node": "n", "status": "running", "maxdisk": 8 * 1024**3,
         "disk": 2 * 1024**3},
    ]).instances
    assert (vm.net_in_bytes, vm.net_out_bytes) == (5000, 700)
    assert vm.disk_used_bytes is None  # a VM disk is opaque to the host
    assert ct.disk_used_bytes == 2 * 1024**3


def test_filesystems_skip_pseudo_and_bind_mounts():
    fs = mapper.filesystems([
        {"mountpoint": "/", "type": "ext4", "used-bytes": 9, "total-bytes": 10},
        {"mountpoint": "/var/lib/docker/x", "type": "ext4", "used-bytes": 9, "total-bytes": 10},
        {"mountpoint": "/snap/core", "type": "squashfs", "used-bytes": 5, "total-bytes": 5},
        {"mountpoint": "/boot/efi", "type": "vfat", "used-bytes": 1, "total-bytes": 4},
        {"mountpoint": "/mnt/cd", "type": "ext4"},  # no size reported
    ])
    assert [(f.mountpoint, f.used_bytes, f.total_bytes) for f in fs] == [
        ("/", 9, 10), ("/boot/efi", 1, 4),
    ]


@respx.mock
async def test_guest_filesystems_reads_agent_and_maps_missing_agent():
    ref = mapper.instance_ref(10001, "tagima", "qemu")
    route = respx.get(f"{API}/nodes/tagima/qemu/10001/agent/get-fsinfo")
    route.respond(json={"data": {"result": [
        {"mountpoint": "/", "type": "xfs", "used-bytes": 3, "total-bytes": 4},
    ]}})
    [root] = await ProxmoxProvider(_client()).guest_filesystems(ref)
    assert root.mountpoint == "/" and root.used_bytes == 3

    route.mock(return_value=httpx.Response(
        500, extensions={"reason_phrase": b"QEMU guest agent is not running"}
    ))
    with pytest.raises(GuestAgentUnavailable):
        await ProxmoxProvider(_client()).guest_filesystems(ref)

    route.respond(403)
    with pytest.raises(ProviderAuthError):
        await ProxmoxProvider(_client()).guest_filesystems(ref)


def test_nics_from_vm_and_container_config():
    vm = mapper.nics({
        "net0": "virtio=BE:80:46:72:1E:A2,bridge=vmbr0,firewall=1,tag=151",
        "ipconfig0": "ip=177.54.151.188/24,gw=177.54.151.1",
        "net1": "virtio=BC:24:11:20:05:FF,bridge=vnet100",
        "ipconfig1": "ip=dhcp",
        "netmask": "ignored",
    }, "qemu")
    assert [(n.name, n.mac, n.bridge, n.vlan, n.ip, n.gateway) for n in vm] == [
        ("net0", "be:80:46:72:1e:a2", "vmbr0", 151, "177.54.151.188/24", "177.54.151.1"),
        ("net1", "bc:24:11:20:05:ff", "vnet100", None, None, None),
    ]
    [ct] = mapper.nics({
        "net0": "name=eth0,bridge=vmbr0,hwaddr=AA:BB:CC:00:11:22,"
                "ip=152.236.18.21/31,gw=152.236.18.20",
    }, "lxc")
    assert (ct.mac, ct.ip) == ("aa:bb:cc:00:11:22", "152.236.18.21/31")
    assert ct.gateway == "152.236.18.20"
