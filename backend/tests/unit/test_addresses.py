from app.compute.addresses import primary_ipv4
from app.compute.models import Instance

NIC = {"name": "net0", "mac": "bc:24:11:aa:00:01", "bridge": "vmbr0", "vlan": None,
       "ip": None, "gateway": None}


def _vm(**kw) -> Instance:
    return Instance(**{"network": {}, "nics": None, "guest_addresses": None, **kw})


def test_platform_address_wins():
    i = _vm(network={"address": "203.0.113.10/28", "gateway": "203.0.113.1"},
            nics=[{**NIC, "ip": "10.9.9.9/24"}])
    ip = primary_ipv4(i, {})
    assert (ip.address, ip.gateway, ip.source) == ("203.0.113.10/28", "203.0.113.1", "platform")


def test_agent_only_on_the_guests_own_nics():
    i = _vm(nics=[NIC], guest_addresses=[
        {"mac": "02:42:00:00:00:01", "address": "172.17.0.1/16"},  # docker0 inside
        {"mac": NIC["mac"], "address": "10.0.0.5/24"},
    ])
    assert primary_ipv4(i, {}).address == "10.0.0.5/24"
    i.guest_addresses = [{"mac": "02:42:00:00:00:01", "address": "172.17.0.1/16"}]
    assert primary_ipv4(i, {}) is None


def test_config_then_ipam_by_mac():
    i = _vm(nics=[{**NIC, "ip": "177.54.151.188/24", "gateway": "177.54.151.1"}])
    ip = primary_ipv4(i, {NIC["mac"]: "177.54.151.99"})
    assert (ip.address, ip.gateway, ip.source) == ("177.54.151.188/24", "177.54.151.1", "config")

    i.nics = [NIC]  # DHCP / set inside the guest: only the IPAM knows
    ip = primary_ipv4(i, {NIC["mac"]: "177.54.151.99/31"})
    assert (ip.address, ip.source) == ("177.54.151.99/31", "ipam")
    assert primary_ipv4(i, {}) is None
