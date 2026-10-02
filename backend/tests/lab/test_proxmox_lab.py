"""Against a real Proxmox (roadmap Phase 1 exit criterion). Skipped unless configured:

  CM_LAB_PVE_URL        https://host:8006
  CM_LAB_PVE_TOKEN_ID   cloudmgr@pve!cm
  CM_LAB_PVE_SECRET     (token secret)
  CM_LAB_PVE_POOL       pool the token is restricted to (default cm-lab)
  CM_LAB_POWER_VMID     optional: a disposable guest to start and stop

  pytest -m lab -v
"""

import os

import pytest

from app.providers.base import PowerAction, PowerState
from app.providers.proxmox.client import ProxmoxClient, build_ssl_context
from app.providers.proxmox.provider import ProxmoxProvider

pytestmark = [pytest.mark.anyio, pytest.mark.lab]

URL = os.environ.get("CM_LAB_PVE_URL")
TOKEN_ID = os.environ.get("CM_LAB_PVE_TOKEN_ID")
SECRET = os.environ.get("CM_LAB_PVE_SECRET")
POOL = os.environ.get("CM_LAB_PVE_POOL", "cm-lab")
POWER_VMID = os.environ.get("CM_LAB_POWER_VMID")

if not (URL and TOKEN_ID and SECRET):
    pytest.skip("CM_LAB_PVE_* not set", allow_module_level=True)


@pytest.fixture
async def provider():
    client = ProxmoxClient(URL, TOKEN_ID, SECRET, verify=build_ssl_context(None, False))
    p = ProxmoxProvider(client)
    yield p
    await p.aclose()


async def test_health(provider):
    health = await provider.health()
    print(f"\nPVE {health.version}: {health.nodes_online}/{health.nodes_total} nodes online")
    assert health.nodes_total >= 1 and health.nodes_online >= 1


async def test_inventory_is_limited_to_the_pool(provider):
    inv = await provider.inventory()
    for i in inv.instances:
        print(f"  {i.ref.data['vmid']:>6} {i.kind:<9} {i.power_state:<8} {i.name} (pool={i.pool})")
    assert inv.instances, "token sees no guests: check the pool ACL"
    # least privilege: everything visible is inside the pool
    assert {i.pool for i in inv.instances} == {POOL}


@pytest.mark.skipif(not POWER_VMID, reason="CM_LAB_POWER_VMID not set")
async def test_power_cycle(provider):
    async def state() -> PowerState:
        inv = await provider.inventory()
        return next(i.power_state for i in inv.instances if str(i.ref.data["vmid"]) == POWER_VMID)

    inv = await provider.inventory()
    guest = next(i for i in inv.instances if str(i.ref.data["vmid"]) == POWER_VMID)
    assert guest.pool == POOL, "refusing to touch a guest outside the lab pool"

    if guest.power_state is not PowerState.RUNNING:
        result = await provider.wait(await provider.power(guest.ref, PowerAction.START))
        assert result.ok, result.message
        assert await state() is PowerState.RUNNING
    result = await provider.wait(await provider.power(guest.ref, PowerAction.STOP))
    assert result.ok, result.message
    assert await state() is PowerState.STOPPED
