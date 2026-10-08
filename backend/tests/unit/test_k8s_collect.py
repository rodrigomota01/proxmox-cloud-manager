import json
from datetime import UTC, datetime

import httpx
import pytest
import respx

from app.k8s.client import ALLOWED_PATHS, ForbiddenPath, K8sReader
from app.k8s.collect import collect, quantity
from tests.k8s_api import NOW, FakeReader, healthy_cluster, httproute, node, with_gateway_api
from tests.k8s_fixtures import kubeconfig_b64

pytestmark = pytest.mark.anyio


@pytest.mark.parametrize(("value", "expected"), [
    ("250m", 0.25), ("2", 2), ("1.5", 1.5), ("128Mi", 128 * 2**20), ("2Gi", 2 * 2**30),
    ("1000Ki", 1000 * 1024), ("1e3", 1000), ("129M", 129e6), ("100n", 1e-7), (None, 0),
    ("garbage", 0),
])
def test_quantity(value, expected):
    assert quantity(value) == pytest.approx(expected)


async def test_collect_health_load_and_namespaces():
    snap = await collect(FakeReader(healthy_cluster()), NOW)
    s = snap.summary
    assert snap.health == "warning" and snap.version == "v1.30.4"
    assert snap.reasons == ["2 pod(s) com problema",
                            "1 workload(s) sem todas as réplicas prontas"]
    assert (s["nodes"], s["nodes_ready"], s["namespaces"]) == (2, 2, 3)
    assert (s["pods"], s["pods_running"], s["pods_problem"]) == (6, 3, 2)
    assert s["metrics"] and s["cpu_usage"] == pytest.approx(2.0)
    assert s["mem_usage"] == 5 * 2**30 and s["cpu_allocatable"] == pytest.approx(7.6)
    # requests reserved on nodes: the 3 scheduled, unfinished pods (pending ones have no
    # node yet; the Succeeded one released its share)
    assert s["cpu_requests"] == pytest.approx(0.75)

    pods = {p["name"]: p for p in snap.data["pods"]}
    assert pods["worker-1"]["status"] == "CrashLoopBackOff" and pods["worker-1"]["problem"]
    assert pods["stuck"]["problem"] and not pods["new"]["problem"]  # 5 min of grace
    assert not pods["done"]["problem"]
    assert snap.data["pods"][0]["problem"]  # problems first
    assert "hunter2" not in json.dumps(snap.data)  # container env is never kept

    shop = next(n for n in snap.data["namespaces"] if n["name"] == "shop")
    assert (shop["pods"], shop["problems"], shop["workloads"], shop["services"],
            shop["ingresses"]) == (3, 1, 2, 1, 1)
    assert shop["cpu_usage"] == pytest.approx(0.3)
    [svc] = snap.data["services"]
    assert svc["external"] == ["203.0.113.7"] and svc["ports"] == ["80:30080/TCP → 8080"]
    [ing] = snap.data["ingresses"]
    assert ing["rules"] == [{"host": "shop.example", "path": "/", "service": "web:80",
                             "tls": True}]
    n1 = next(n for n in snap.data["nodes"] if n["name"] == "n1")
    assert n1["roles"] == ["control-plane"] and n1["pods"] == 1


async def test_node_down_is_critical_and_no_metrics_is_fine():
    api = healthy_cluster(metrics=False)
    api["/api/v1/nodes"] = {"items": [node("n1"), node("n2", ready=False, memory_pressure=True)]}
    api["/readyz"] = "ok"
    snap = await collect(FakeReader(api), NOW)
    assert snap.health == "critical"
    assert "nó(s) fora do ar: n2" in snap.reasons
    assert snap.summary["cpu_usage"] is None and not snap.summary["metrics"]
    assert all(n["cpu_usage"] is None for n in snap.data["namespaces"])


def test_reader_refuses_anything_but_allowed_gets():
    reader = K8sReader.__new__(K8sReader)
    assert not hasattr(reader, "post") and not hasattr(reader, "delete")
    assert not any(p.startswith("/api/v1/secrets") or "secrets" in p or "configmaps" in p
                   for p in ALLOWED_PATHS)


@respx.mock
async def test_reader_uses_the_kubeconfig_and_only_gets():
    text = __import__("base64").b64decode(
        kubeconfig_b64("https://k.example:6443", datetime(2027, 1, 1, tzinfo=UTC))
    ).decode()
    route = respx.get("https://k.example:6443/version").mock(
        return_value=httpx.Response(200, json={"gitVersion": "v1.31.0"})
    )
    async with K8sReader(text) as reader:
        assert (await reader.get("/version"))["gitVersion"] == "v1.31.0"
        with pytest.raises(ForbiddenPath):
            await reader.get("/api/v1/secrets")
        with pytest.raises(ForbiddenPath):
            await reader.get("/api/v1/namespaces/default/pods/x")
    assert route.called and route.calls.last.request.method == "GET"


async def test_httproutes_next_to_ingresses():
    snap = await collect(FakeReader(with_gateway_api(healthy_cluster())), NOW)
    assert snap.summary["gateway_api"] and snap.summary["httproutes"] == 1
    assert snap.summary["ingresses"] == 1  # both kinds, kept apart
    [route] = snap.data["httproutes"]
    assert route["hostnames"] == ["app.example"] and route["parents"] == ["infra/public:https"]
    assert route["tls"] and route["address"] == ["198.51.100.9"]  # from the Gateway
    assert route["rules"] == [{"path": "/api",
                               "backends": "api:8080 (90), api-canary:8080 (10)"}]
    assert route["problem"] is None
    shop = next(n for n in snap.data["namespaces"] if n["name"] == "shop")
    assert (shop["ingresses"], shop["httproutes"]) == (1, 1)


async def test_rejected_route_warns_and_v1beta1_is_read():
    api = with_gateway_api(healthy_cluster(), version="v1beta1", routes=[
        httproute("shop", "ok", section="http"),
        httproute("shop", "bad", accepted=False),
    ])
    snap = await collect(FakeReader(api), NOW)
    assert "1 HTTPRoute(s) não aceita(s) pelo gateway" in snap.reasons
    first, second = snap.data["httproutes"]
    assert first["name"] == "bad" and first["problem"] == "Accepted: NotAllowedByListeners"
    assert second["name"] == "ok" and not second["tls"]  # attached to the HTTP listener


async def test_cluster_without_gateway_api():
    snap = await collect(FakeReader(healthy_cluster()), NOW)
    assert not snap.summary["gateway_api"] and snap.data["httproutes"] == []
