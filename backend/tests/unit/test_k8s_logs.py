import base64
from datetime import UTC, datetime

import httpx
import pytest
import respx

from app.k8s.client import ForbiddenPath, K8sApiError, K8sReader
from app.k8s.collect import collect, pod_workload
from app.k8s.logs import LogQuery, read_logs
from tests.k8s_api import NOW, FakeReader, healthy_cluster, pod
from tests.k8s_fixtures import kubeconfig_b64

pytestmark = pytest.mark.anyio


def shop(logs=None):
    api = healthy_cluster()
    api["/api/v1/pods"] = {"items": [
        pod("shop", "web-7d9f-a", "n1", deployment="web"),
        pod("shop", "web-7d9f-b", "n2", deployment="web"),
        pod("shop", "worker-1", "n2"),
        pod("jobs", "web-7d9f-c", "n1", deployment="web"),  # same name, other namespace
    ]}
    api["logs"] = logs or {}
    return api


def test_pod_workload():
    assert pod_workload(pod("s", "p", "n", deployment="web")["metadata"]) == "Deployment/web"
    assert pod_workload(pod("s", "p", "n")["metadata"]) == "ReplicaSet/p-rs"
    sts = {"ownerReferences": [{"kind": "StatefulSet", "name": "db", "controller": True}],
           "labels": {"controller-revision-hash": "db-5c"}}
    assert pod_workload(sts) == "StatefulSet/db"
    assert pod_workload({}) is None


async def test_snapshot_pods_carry_workload_and_containers():
    api = shop()
    api["/api/v1/pods"]["items"].append(pod("shop", "multi", "n1", containers=("app", "proxy")))
    snap = await collect(FakeReader(api), NOW)
    by_name = {p["name"]: p for p in snap.data["pods"]}
    assert by_name["web-7d9f-a"]["workload"] == "Deployment/web"
    assert by_name["multi"]["containers"] == ["app", "proxy"]


async def test_workload_logs_are_merged_in_time_order():
    reader = FakeReader(shop({
        ("shop", "web-7d9f-a", "app"): "2026-10-16T10:00:00.5Z a1\n"
                                       "2026-10-16T10:00:02Z \x1b[32ma2\x1b[0m\n",
        ("shop", "web-7d9f-b", "app"): "2026-10-16T10:00:00.123456789Z b1\n"
                                       "2026-10-16T10:00:01Z b2\n",
    }))
    out = await read_logs(reader, LogQuery("shop", workload="Deployment/web"))
    assert [p["name"] for p in out["pods"]] == ["web-7d9f-a", "web-7d9f-b"]  # not worker, not jobs
    assert [(x["pod"], x["text"]) for x in out["lines"]] == [
        ("web-7d9f-b", "b1"), ("web-7d9f-a", "a1"), ("web-7d9f-b", "b2"), ("web-7d9f-a", "a2"),
    ]  # .123456789 < .5, and the colour codes are gone
    assert out["lines"][0]["ts"] == "2026-10-16T10:00:00.123456789Z"
    assert all(p["lines"] == 2 and p["error"] is None for p in out["pods"])
    assert not out["pods_truncated"]


async def test_tail_is_the_latest_lines_across_pods():
    a = "".join(f"2026-10-16T10:00:{s:02d}Z a{s}\n" for s in range(0, 60, 2))
    b = "".join(f"2026-10-16T10:00:{s:02d}Z b{s}\n" for s in range(1, 60, 2))
    reader = FakeReader(shop({("shop", "web-7d9f-a", "app"): a,
                                ("shop", "web-7d9f-b", "app"): b}))
    out = await read_logs(reader, LogQuery("shop", workload="Deployment/web", tail_lines=5))
    assert [x["text"] for x in out["lines"]] == ["b55", "a56", "b57", "a58", "b59"]
    assert {c[3]["tailLines"] for c in reader.calls if c[0] == "log"} == {"5"}


async def test_one_pod_and_per_pod_errors():
    reader = FakeReader(shop({
        ("shop", "web-7d9f-a", "app"): "2026-10-16T10:00:00Z ok\n",
        ("shop", "worker-1", "app"): K8sApiError("previous terminated container not found"),
    }))
    out = await read_logs(reader, LogQuery(
        "shop", pods=("web-7d9f-a", "web-7d9f-b", "worker-1", "gone"), previous=True,
        since_seconds=600,
    ))
    pods = {p["name"]: p for p in out["pods"]}
    assert pods["web-7d9f-a"]["lines"] == 1 and pods["web-7d9f-a"]["status"] == "Running"
    assert "waiting to start" in pods["web-7d9f-b"]["error"]
    assert pods["worker-1"]["error"] == "previous terminated container not found"
    assert pods["gone"]["error"] == "o pod não existe mais"
    assert [x["text"] for x in out["lines"]] == ["ok"]
    params = next(c[3] for c in reader.calls if c[0] == "log")
    assert params["previous"] == "true" and params["sinceSeconds"] == "600"


async def test_container_choice():
    api = shop()
    api["/api/v1/pods"]["items"] = [
        pod("shop", "multi", "n1", containers=("istio-proxy", "app"),
            annotations={"kubectl.kubernetes.io/default-container": "app"}),
        pod("shop", "plain", "n1", containers=("first", "second")),
    ]
    api["logs"] = {("shop", "multi", "app"): "", ("shop", "plain", "first"): "",
                   ("shop", "multi", "istio-proxy"): ""}
    out = await read_logs(FakeReader(api), LogQuery("shop", pods=("multi", "plain")))
    assert {p["name"]: p["container"] for p in out["pods"]} == {"multi": "app", "plain": "first"}
    out = await read_logs(FakeReader(api), LogQuery("shop", pods=("multi", "plain"),
                                                    container="istio-proxy"))
    pods = {p["name"]: p for p in out["pods"]}
    assert pods["multi"]["error"] is None and pods["multi"]["containers"] == ["istio-proxy", "app"]
    assert pods["plain"]["container"] is None and "istio-proxy" in pods["plain"]["error"]


async def test_big_workload_is_cut():
    api = shop()
    api["/api/v1/pods"]["items"] = [pod("shop", f"web-7d9f-{i:02d}", "n1", deployment="web")
                                    for i in range(25)]
    out = await read_logs(FakeReader(api), LogQuery("shop", workload="Deployment/web"))
    assert len(out["pods"]) == 20 and out["pods_truncated"]


def _reader():
    text = base64.b64decode(
        kubeconfig_b64("https://k.example:6443", datetime(2027, 1, 1, tzinfo=UTC))
    ).decode()
    return K8sReader(text)


@respx.mock
async def test_reader_log_path_is_checked():
    route = respx.get("https://k.example:6443/api/v1/namespaces/shop/pods/web-1/log").mock(
        return_value=httpx.Response(200, text="2026-10-16T10:00:00Z hi\n")
    )
    async with _reader() as reader:
        text, cut = await reader.pod_log("shop", "web-1", {"container": "app",
                                                           "timestamps": "true"},
                                         max_bytes=1024)
        assert (text, cut) == ("2026-10-16T10:00:00Z hi\n", False)
        for ns, name in (("shop", "../../secrets"), ("Shop", "web-1"), ("shop", "a/b")):
            with pytest.raises(ForbiddenPath):
                await reader.pod_log(ns, name, {}, max_bytes=1024)
        with pytest.raises(ForbiddenPath):
            await reader.pod_log("shop", "web-1", {"follow": "true"}, max_bytes=1024)
        with pytest.raises(ForbiddenPath):
            await reader.pod_log("shop", "web-1", {"container": "x/y"}, max_bytes=1024)
        with pytest.raises(ForbiddenPath):
            await reader.namespace_pods("kube-system/../secrets")
    assert route.call_count == 1 and route.calls.last.request.url.params["container"] == "app"


@respx.mock
async def test_reader_log_keeps_the_tail_and_the_clusters_message():
    body = "".join(f"line {i:04d}\n" for i in range(1000))  # 10 bytes each
    respx.get("https://k.example:6443/api/v1/namespaces/shop/pods/big/log").mock(
        return_value=httpx.Response(200, text=body)
    )
    respx.get("https://k.example:6443/api/v1/namespaces/shop/pods/new/log").mock(
        return_value=httpx.Response(400, json={
            "kind": "Status", "message": 'container "app" in pod "new" is waiting to start'})
    )
    async with _reader() as reader:
        text, cut = await reader.pod_log("shop", "big", {}, max_bytes=95)
        assert cut and text == "".join(f"line {i:04d}\n" for i in range(991, 1000))
        text, cut = await reader.pod_log("shop", "big", {}, max_bytes=90)  # at a line start
        assert cut and text == "".join(f"line {i:04d}\n" for i in range(991, 1000))
        with pytest.raises(K8sApiError, match="is waiting to start"):
            await reader.pod_log("shop", "new", {}, max_bytes=95)
