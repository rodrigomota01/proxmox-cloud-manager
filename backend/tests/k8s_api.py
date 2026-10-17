"""A small fake cluster API: what K8sReader.get would return, per path."""

from datetime import UTC, datetime, timedelta

from app.k8s.client import ALLOWED_PATHS, LOG_PARAMS, NAME, ForbiddenPath, K8sApiError

NOW = datetime.now(UTC).replace(microsecond=0)  # the worker collects with the real clock


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def node(name, *, ready=True, role="worker", memory_pressure=False):
    return {
        "metadata": {"name": name, "labels": {f"node-role.kubernetes.io/{role}": ""},
                     "creationTimestamp": "2025-01-01T00:00:00Z"},
        "spec": {},
        "status": {
            "conditions": [{"type": "Ready", "status": "True" if ready else "False"},
                           {"type": "MemoryPressure",
                            "status": "True" if memory_pressure else "False"}],
            "capacity": {"cpu": "4", "memory": "8Gi", "pods": "110"},
            "allocatable": {"cpu": "3800m", "memory": "7Gi", "pods": "110"},
            "addresses": [{"type": "InternalIP", "address": f"10.0.0.{len(name)}"}],
            "nodeInfo": {"kubeletVersion": "v1.30.4", "osImage": "Ubuntu 24.04"},
        },
    }


def pod(ns, name, node_name, *, phase="Running", waiting=None, created=NOW, restarts=0,
        cpu="250m", memory="256Mi", env_secret=False, deployment=None, containers=("app",),
        annotations=None):
    """`deployment`: owned like a Deployment's pod (ReplicaSet `<deployment>-7d9f` with the
    matching pod-template-hash); otherwise by a ReplicaSet `<name>-rs`."""
    specs = [{"name": c, "image": "nginx:1.27",
              "resources": {"requests": {"cpu": cpu, "memory": memory}}} for c in containers]
    if env_secret:
        specs[0]["env"] = [{"name": "DB_PASSWORD", "value": "hunter2"}]
    status = {"phase": phase, "podIP": "10.244.0.5", "startTime": _iso(created),
              "containerStatuses": [{"ready": phase == "Running" and not waiting,
                                     "restartCount": restarts,
                                     "state": {"waiting": {"reason": waiting}} if waiting
                                     else {"running": {}}}]}
    meta = {"namespace": ns, "name": name, "creationTimestamp": _iso(created),
            "ownerReferences": [{"kind": "ReplicaSet", "name": f"{name}-rs"}]}
    if deployment:
        meta["labels"] = {"pod-template-hash": "7d9f"}
        meta["ownerReferences"] = [{"kind": "ReplicaSet", "name": f"{deployment}-7d9f",
                                    "controller": True}]
    if annotations:
        meta["annotations"] = annotations
    return {"metadata": meta, "spec": {"nodeName": node_name, "containers": specs},
            "status": status}


def gateway(ns, name, *, address="198.51.100.9"):
    return {"metadata": {"namespace": ns, "name": name},
            "spec": {"listeners": [{"name": "http", "protocol": "HTTP", "port": 80},
                                   {"name": "https", "protocol": "HTTPS", "port": 443}]},
            "status": {"addresses": [{"type": "IPAddress", "value": address}]}}


def httproute(ns, name, *, gw=("infra", "public"), section="https", accepted=True,
              hosts=("app.example",)):
    return {
        "metadata": {"namespace": ns, "name": name},
        "spec": {
            "parentRefs": [{"name": gw[1], "namespace": gw[0], "sectionName": section}],
            "hostnames": list(hosts),
            "rules": [{"matches": [{"path": {"type": "PathPrefix", "value": "/api"}}],
                       "backendRefs": [{"name": "api", "port": 8080, "weight": 90},
                                       {"name": "api-canary", "port": 8080, "weight": 10}]}],
        },
        "status": {"parents": [{"conditions": [
            {"type": "Accepted", "status": "True" if accepted else "False",
             "reason": "Accepted" if accepted else "NotAllowedByListeners"},
            {"type": "ResolvedRefs", "status": "True"},
        ]}]},
    }


def with_gateway_api(api, *, version="v1", routes=None):
    base = f"/apis/gateway.networking.k8s.io/{version}"
    api[f"{base}/gateways"] = {"items": [gateway("infra", "public")]}
    api[f"{base}/httproutes"] = {"items": routes if routes is not None
                                 else [httproute("shop", "api")]}
    return api


def healthy_cluster(*, metrics=True) -> dict[str, object]:
    pods = [
        pod("shop", "web-1", "n1"), pod("shop", "web-2", "n2"),
        pod("shop", "worker-1", "n2", waiting="CrashLoopBackOff", restarts=12),
        pod("jobs", "stuck", None, phase="Pending", created=NOW - timedelta(minutes=10)),
        pod("jobs", "new", None, phase="Pending", created=NOW - timedelta(minutes=1)),
        pod("jobs", "done", "n1", phase="Succeeded", env_secret=True),
    ]
    api: dict[str, object] = {
        "/version": {"gitVersion": "v1.30.4"},
        "/readyz": "ok",
        "/api/v1/nodes": {"items": [node("n1", role="control-plane"), node("n2")]},
        "/api/v1/namespaces": {"items": [
            {"metadata": {"name": n}, "status": {"phase": "Active"}}
            for n in ("shop", "jobs", "kube-system")
        ]},
        "/api/v1/pods": {"items": pods},
        "/api/v1/services": {"items": [{
            "metadata": {"namespace": "shop", "name": "web"},
            "spec": {"type": "LoadBalancer", "clusterIP": "10.96.0.10",
                     "ports": [{"port": 80, "nodePort": 30080, "protocol": "TCP",
                                "targetPort": 8080}]},
            "status": {"loadBalancer": {"ingress": [{"ip": "203.0.113.7"}]}},
        }]},
        "/apis/apps/v1/deployments": {"items": [
            {"metadata": {"namespace": "shop", "name": "web"}, "spec": {"replicas": 2,
             "template": {"spec": {"containers": [{"image": "nginx:1.27"}]}}},
             "status": {"readyReplicas": 2}},
            {"metadata": {"namespace": "shop", "name": "worker"}, "spec": {"replicas": 1,
             "template": {"spec": {"containers": [{"image": "worker:3"}]}}},
             "status": {"readyReplicas": 0}},
        ]},
        "/apis/apps/v1/statefulsets": {"items": []},
        "/apis/apps/v1/daemonsets": {"items": [
            {"metadata": {"namespace": "kube-system", "name": "proxy"}, "spec": {},
             "status": {"desiredNumberScheduled": 2, "numberReady": 2}},
        ]},
        "/apis/networking.k8s.io/v1/ingresses": {"items": [{
            "metadata": {"namespace": "shop", "name": "web"},
            "spec": {"ingressClassName": "nginx", "tls": [{"hosts": ["shop.example"]}],
                     "rules": [{"host": "shop.example", "http": {"paths": [
                         {"path": "/", "backend": {"service": {"name": "web",
                                                               "port": {"number": 80}}}}]}}]},
            "status": {"loadBalancer": {"ingress": [{"ip": "203.0.113.7"}]}},
        }]},
    }
    if metrics:
        api["/apis/metrics.k8s.io/v1beta1/nodes"] = {"items": [
            {"metadata": {"name": "n1"}, "usage": {"cpu": "500m", "memory": "2Gi"}},
            {"metadata": {"name": "n2"}, "usage": {"cpu": "1500m", "memory": "3Gi"}},
        ]}
        api["/apis/metrics.k8s.io/v1beta1/pods"] = {"items": [
            {"metadata": {"namespace": "shop", "name": "web-1"},
             "containers": [{"usage": {"cpu": "100m", "memory": "128Mi"}}]},
            {"metadata": {"namespace": "shop", "name": "web-2"},
             "containers": [{"usage": {"cpu": "200m", "memory": "256Mi"}}]},
        ]}
    return api


class FakeReader:
    """Same surface as K8sReader; records what was asked."""

    def __init__(self, api: dict[str, object]) -> None:
        self.api, self.calls = api, []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def get(self, path: str, *, optional: bool = False):
        if path not in ALLOWED_PATHS:
            raise ForbiddenPath(path)
        self.calls.append(path)
        if path not in self.api:
            if optional:
                return None
            raise K8sApiError(f"GET {path}: HTTP 404")
        return self.api[path]

    async def namespace_pods(self, namespace: str):
        if not NAME.fullmatch(namespace):
            raise ForbiddenPath(namespace)
        self.calls.append(f"pods:{namespace}")
        items = (self.api.get("/api/v1/pods") or {}).get("items") or []
        return {"items": [p for p in items if p["metadata"]["namespace"] == namespace]}

    async def pod_log(self, namespace: str, pod: str, params: dict[str, str], *, max_bytes: int):
        """api["logs"][(namespace, pod, container)]: the full log (timestamped lines), or
        an exception to raise; the tail is applied here like the kubelet does."""
        assert params.keys() <= LOG_PARAMS and params.get("timestamps") == "true"
        self.calls.append(("log", namespace, pod, dict(params)))
        log = (self.api.get("logs") or {}).get((namespace, pod, params.get("container")))
        if isinstance(log, Exception):
            raise log
        if log is None:
            raise K8sApiError(f'container "{params.get("container")}" in pod "{pod}" '
                              "is waiting to start: ContainerCreating")
        lines = log.splitlines()[-int(params["tailLines"]):]
        return "".join(f"{line}\n" for line in lines), False
