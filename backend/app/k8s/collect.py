"""Collects each cluster's state through its API (worker, read-only) into k8s_snapshots.

One pass every CM_K8S_POLL_INTERVAL_SECONDS, clusters in parallel, each bounded by
CM_K8S_POLL_TIMEOUT_SECONDS: an unreachable cluster only marks itself. What is kept is
what the screens need: no Secrets, no ConfigMaps, no container env (which may hold
credentials), only names, states, sizes and usage.

Health:
- unreachable: the API did not answer (the last good data stays, with its age);
- critical: /readyz not ok, or a node NotReady;
- warning: node pressure or memory > 90%, problem pods, workloads short of replicas,
  HTTPRoutes not accepted by their gateway.
"""

import asyncio
import logging
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import set_platform_scope
from app.infra.secrets import Sealed, SecretsBackend, SecretsError, unseal
from app.k8s.client import K8sApiError, K8sReader
from app.k8s.models import K8sCluster, K8sSnapshot

logger = logging.getLogger(__name__)

MAX_PODS = 5000  # kept per cluster; counts still cover every pod
PENDING_GRACE_SECONDS = 300
NODE_MEMORY_WARN = 0.9
BAD_WAITING = {
    "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError",
    "CreateContainerError", "InvalidImageName", "RunContainerError",
}
PRESSURE = ("MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable")

_QUANTITY = re.compile(r"^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)([a-zA-Z]*)$")
_SUFFIX = {
    "": 1, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12,
    "P": 1e15, "E": 1e18, "Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40, "Pi": 2**50,
    "Ei": 2**60,
}


def quantity(value: object) -> float:
    """Kubernetes resource quantity -> float (cores for CPU, bytes for memory)."""
    if value is None:
        return 0.0
    m = _QUANTITY.match(str(value).strip())
    if not m or m.group(2) not in _SUFFIX:
        return 0.0
    return float(m.group(1)) * _SUFFIX[m.group(2)]


def _ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _items(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    return (doc or {}).get("items") or []


def _requests(spec: dict[str, Any]) -> tuple[float, float]:
    cpu = mem = 0.0
    for c in spec.get("containers") or []:
        req = (c.get("resources") or {}).get("requests") or {}
        cpu += quantity(req.get("cpu"))
        mem += quantity(req.get("memory"))
    return cpu, mem


def pod_state(pod: dict[str, Any], now: datetime) -> tuple[str, bool]:
    """(status shown, is a problem). Completed pods (Succeeded) are never problems."""
    meta, status = pod.get("metadata") or {}, pod.get("status") or {}
    phase = status.get("phase") or "Unknown"
    if meta.get("deletionTimestamp"):
        return "Terminating", False
    for cs in (status.get("initContainerStatuses") or []) + (status.get("containerStatuses") or []):
        waiting = (cs.get("state") or {}).get("waiting") or {}
        if waiting.get("reason") in BAD_WAITING:
            return waiting["reason"], True
    if phase == "Pending":
        created = _ts(meta.get("creationTimestamp"))
        late = created is not None and (now - created).total_seconds() > PENDING_GRACE_SECONDS
        reason = next((c.get("reason") for c in status.get("conditions") or []
                       if c.get("status") == "False" and c.get("reason")), None)
        return reason or "Pending", late
    if phase in ("Failed", "Unknown"):
        return status.get("reason") or phase, True
    return phase, False


@dataclass
class Snapshot:
    health: str
    reasons: list[str]
    version: str | None
    summary: dict[str, Any]
    data: dict[str, Any]
    error: str | None = None


@dataclass
class _Ns:
    pods: int = 0
    running: int = 0
    problems: int = 0
    cpu_usage: float = 0.0
    mem_usage: float = 0.0
    cpu_requests: float = 0.0
    mem_requests: float = 0.0
    workloads: int = 0
    services: int = 0
    ingresses: int = 0
    httproutes: int = 0


async def _gateway_api(reader: K8sReader) -> tuple[Any, Any]:
    """HTTPRoutes and Gateways (v1, else v1beta1); (None, None) when not installed."""
    for version in ("v1", "v1beta1"):
        routes = await reader.get(f"/apis/gateway.networking.k8s.io/{version}/httproutes",
                                  optional=True)
        if routes is not None:
            gateways = await reader.get(
                f"/apis/gateway.networking.k8s.io/{version}/gateways", optional=True
            )
            return routes, gateways
    return None, None


def _route_conditions(status: dict[str, Any]) -> str | None:
    """Why a route is not serving, from its parents' conditions; None when fine."""
    for parent in status.get("parents") or []:
        for c in parent.get("conditions") or []:
            if c.get("type") in ("Accepted", "ResolvedRefs") and c.get("status") == "False":
                return f"{c['type']}: {c.get('reason') or 'False'}"
    return None


def http_routes(
    routes_doc: Any, gateways_doc: Any
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """HTTPRoutes with the address/TLS of the Gateway listeners they attach to."""
    gateways: dict[tuple[str, str], dict[str, Any]] = {}
    for g in _items(gateways_doc):
        meta, spec, status = g.get("metadata") or {}, g.get("spec") or {}, g.get("status") or {}
        gateways[(meta.get("namespace") or "", meta.get("name") or "")] = {
            "address": [a.get("value") for a in status.get("addresses") or [] if a.get("value")],
            "listeners": {
                (lst.get("name") or ""): lst.get("protocol") for lst in spec.get("listeners") or []
            },
        }
    out, per_ns = [], defaultdict(int)
    for r in _items(routes_doc):
        meta, spec, status = r.get("metadata") or {}, r.get("spec") or {}, r.get("status") or {}
        ns = meta.get("namespace") or ""
        per_ns[ns] += 1
        parents, address, tls = [], [], False
        for ref in spec.get("parentRefs") or []:
            gw_ns, gw_name = ref.get("namespace") or ns, ref.get("name") or ""
            section = ref.get("sectionName")
            parents.append(f"{gw_ns}/{gw_name}" + (f":{section}" if section else ""))
            gw = gateways.get((gw_ns, gw_name))
            if gw:
                address += [a for a in gw["address"] if a not in address]
                protocols = [gw["listeners"].get(section)] if section else gw["listeners"].values()
                tls = tls or any(p in ("HTTPS", "TLS") for p in protocols)
        rules = []
        for rule in spec.get("rules") or []:
            backends = ", ".join(
                f"{b.get('name')}:{b.get('port')}"
                + (f" ({b['weight']})" if b.get("weight") not in (None, 1) else "")
                for b in rule.get("backendRefs") or []
            ) or "—"
            matches = rule.get("matches") or [{}]
            for m in matches:
                path = (m.get("path") or {}).get("value") or "/"
                rules.append({"path": path, "backends": backends})
        out.append({
            "namespace": ns, "name": meta.get("name"),
            "hostnames": spec.get("hostnames") or [], "parents": parents, "rules": rules,
            "address": address, "tls": tls, "problem": _route_conditions(status),
        })
    out.sort(key=lambda x: (x["problem"] is None, x["namespace"], x["name"] or ""))
    return out, per_ns


async def collect(reader: K8sReader, now: datetime | None = None) -> Snapshot:
    now = now or datetime.now(UTC)
    version = (await reader.get("/version")).get("gitVersion")
    try:
        ready = await reader.get("/readyz")
    except K8sApiError as exc:
        ready = str(exc)
    nodes_doc, ns_doc, pods_doc, svc_doc, deploy_doc, sts_doc, ds_doc, ing_doc = (
        await asyncio.gather(
            reader.get("/api/v1/nodes"), reader.get("/api/v1/namespaces"),
            reader.get("/api/v1/pods"), reader.get("/api/v1/services"),
            reader.get("/apis/apps/v1/deployments"), reader.get("/apis/apps/v1/statefulsets"),
            reader.get("/apis/apps/v1/daemonsets"),
            reader.get("/apis/networking.k8s.io/v1/ingresses", optional=True),
        )
    )
    node_metrics, pod_metrics, (routes_doc, gateways_doc) = await asyncio.gather(
        reader.get("/apis/metrics.k8s.io/v1beta1/nodes", optional=True),
        reader.get("/apis/metrics.k8s.io/v1beta1/pods", optional=True),
        _gateway_api(reader),
    )
    metrics = node_metrics is not None
    reasons: list[str] = []
    critical = ready != "ok"
    if critical:
        reasons.append(f"API não está pronta (/readyz: {str(ready)[:80]})")

    node_usage = {
        (m.get("metadata") or {}).get("name"): (
            quantity((m.get("usage") or {}).get("cpu")),
            quantity((m.get("usage") or {}).get("memory")),
        )
        for m in _items(node_metrics)
    }
    pod_usage: dict[tuple[str, str], tuple[float, float]] = {}
    for m in _items(pod_metrics):
        meta = m.get("metadata") or {}
        cpu = sum(quantity((c.get("usage") or {}).get("cpu")) for c in m.get("containers") or [])
        mem = sum(quantity((c.get("usage") or {}).get("memory"))
                  for c in m.get("containers") or [])
        pod_usage[(meta.get("namespace"), meta.get("name"))] = (cpu, mem)

    # --- pods ---------------------------------------------------------------------------
    namespaces: dict[str, _Ns] = defaultdict(_Ns)
    node_requests: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0])
    pods_out, problems, running = [], 0, 0
    for p in _items(pods_doc):
        meta, spec, status = p.get("metadata") or {}, p.get("spec") or {}, p.get("status") or {}
        ns, name = meta.get("namespace") or "", meta.get("name") or ""
        state, problem = pod_state(p, now)
        phase = status.get("phase")
        statuses = status.get("containerStatuses") or []
        restarts = sum(int(c.get("restartCount") or 0) for c in statuses)
        ready_n = sum(1 for c in statuses if c.get("ready"))
        cpu_u, mem_u = pod_usage.get((ns, name), (None, None))
        n = namespaces[ns]
        n.pods += 1
        if phase == "Running":
            running += 1
            n.running += 1
        if problem:
            problems += 1
            n.problems += 1
        if phase not in ("Succeeded", "Failed"):
            cpu_r, mem_r = _requests(spec)
            n.cpu_requests += cpu_r
            n.mem_requests += mem_r
            if node := spec.get("nodeName"):
                node_requests[node][0] += cpu_r
                node_requests[node][1] += mem_r
                node_requests[node][2] += 1
        if cpu_u is not None:
            n.cpu_usage += cpu_u
            n.mem_usage += mem_u or 0.0
        owner = next(iter(meta.get("ownerReferences") or []), {})
        pods_out.append({
            "namespace": ns, "name": name, "node": spec.get("nodeName"), "status": state,
            "problem": problem, "ready": f"{ready_n}/{len(spec.get('containers') or [])}",
            "restarts": restarts, "owner": f"{owner.get('kind')}/{owner.get('name')}"
            if owner else None, "ip": status.get("podIP"),
            "started_at": status.get("startTime"), "cpu_usage": cpu_u, "mem_usage": mem_u,
        })
    if problems:
        reasons.append(f"{problems} pod(s) com problema")
    pods_out.sort(key=lambda p: (not p["problem"], p["namespace"], p["name"]))

    # --- nodes --------------------------------------------------------------------------
    nodes_out = []
    totals = defaultdict(float)
    not_ready, pressured = [], []
    for nd in _items(nodes_doc):
        meta, spec, status = nd.get("metadata") or {}, nd.get("spec") or {}, nd.get("status") or {}
        name = meta.get("name") or ""
        conds = {c.get("type"): c.get("status") for c in status.get("conditions") or []}
        is_ready = conds.get("Ready") == "True"
        if not is_ready:
            not_ready.append(name)
        pressure = [t for t in PRESSURE if conds.get(t) == "True"]
        cap, alloc = status.get("capacity") or {}, status.get("allocatable") or {}
        cpu_u, mem_u = node_usage.get(name, (None, None))
        mem_alloc = quantity(alloc.get("memory"))
        if mem_u is not None and mem_alloc and mem_u / mem_alloc > NODE_MEMORY_WARN:
            pressure.append("memória > 90%")
        if pressure:
            pressured.append(f"{name} ({', '.join(pressure)})")
        req = node_requests.get(name, [0.0, 0.0, 0])
        labels = meta.get("labels") or {}
        info = status.get("nodeInfo") or {}
        row = {
            "name": name, "ready": is_ready, "unschedulable": bool(spec.get("unschedulable")),
            "roles": sorted(k.split("/", 1)[1] for k in labels
                            if k.startswith("node-role.kubernetes.io/")) or ["worker"],
            "version": info.get("kubeletVersion"), "os": info.get("osImage"),
            "ip": next((a.get("address") for a in status.get("addresses") or []
                        if a.get("type") == "InternalIP"), None),
            "pressure": pressure,
            "cpu_capacity": quantity(cap.get("cpu")), "cpu_allocatable": quantity(alloc.get("cpu")),
            "mem_capacity": quantity(cap.get("memory")), "mem_allocatable": mem_alloc,
            "pods_capacity": int(quantity(alloc.get("pods"))),
            "cpu_usage": cpu_u, "mem_usage": mem_u,
            "cpu_requests": req[0], "mem_requests": req[1], "pods": int(req[2]),
            "created_at": meta.get("creationTimestamp"),
        }
        nodes_out.append(row)
        for k in ("cpu_capacity", "cpu_allocatable", "mem_capacity", "mem_allocatable",
                  "cpu_requests", "mem_requests"):
            totals[k] += row[k]
        if cpu_u is not None:
            totals["cpu_usage"] += cpu_u
            totals["mem_usage"] += mem_u or 0.0
    if not_ready:
        critical = True
        reasons.append(f"nó(s) fora do ar: {', '.join(not_ready)}")
    if pressured:
        reasons.append(f"nó(s) sob pressão: {', '.join(pressured)}")
    nodes_out.sort(key=lambda n: (n["ready"], n["name"]))

    # --- workloads ----------------------------------------------------------------------
    workloads, unready = [], []
    for kind, doc in (("Deployment", deploy_doc), ("StatefulSet", sts_doc),
                      ("DaemonSet", ds_doc)):
        for w in _items(doc):
            meta, spec, status = w.get("metadata") or {}, w.get("spec") or {}, w.get("status") or {}
            if kind == "DaemonSet":
                desired = status.get("desiredNumberScheduled") or 0
                ready_n = status.get("numberReady") or 0
            else:
                desired, ready_n = spec.get("replicas", 1) or 0, status.get("readyReplicas") or 0
            ns = meta.get("namespace") or ""
            namespaces[ns].workloads += 1
            containers = ((spec.get("template") or {}).get("spec") or {}).get("containers") or []
            item = {
                "kind": kind, "namespace": ns, "name": meta.get("name"), "desired": desired,
                "ready": ready_n, "images": [c.get("image") for c in containers],
                "created_at": meta.get("creationTimestamp"),
            }
            workloads.append(item)
            if ready_n < desired:
                unready.append(f"{ns}/{meta.get('name')}")
    if unready:
        reasons.append(f"{len(unready)} workload(s) sem todas as réplicas prontas")
    workloads.sort(key=lambda w: (w["ready"] >= w["desired"], w["namespace"], w["name"] or ""))

    # --- services and ingresses ---------------------------------------------------------
    services = []
    for s in _items(svc_doc):
        meta, spec, status = s.get("metadata") or {}, s.get("spec") or {}, s.get("status") or {}
        ns = meta.get("namespace") or ""
        namespaces[ns].services += 1
        lb = [i.get("ip") or i.get("hostname")
              for i in (status.get("loadBalancer") or {}).get("ingress") or []]
        services.append({
            "namespace": ns, "name": meta.get("name"), "type": spec.get("type"),
            "cluster_ip": spec.get("clusterIP"),
            "external": [x for x in lb + (spec.get("externalIPs") or []) if x],
            "ports": [
                f"{p.get('port')}{':' + str(p['nodePort']) if p.get('nodePort') else ''}"
                f"/{p.get('protocol', 'TCP')} → {p.get('targetPort')}"
                for p in spec.get("ports") or []
            ],
        })
    ingresses = []
    for i in _items(ing_doc):
        meta, spec, status = i.get("metadata") or {}, i.get("spec") or {}, i.get("status") or {}
        ns = meta.get("namespace") or ""
        namespaces[ns].ingresses += 1
        tls_hosts = {h for t in spec.get("tls") or [] for h in t.get("hosts") or []}
        rules = []
        for r in spec.get("rules") or []:
            for path in ((r.get("http") or {}).get("paths") or []):
                svc = (path.get("backend") or {}).get("service") or {}
                port = (svc.get("port") or {})
                rules.append({
                    "host": r.get("host"), "path": path.get("path") or "/",
                    "service": f"{svc.get('name')}:{port.get('number') or port.get('name')}",
                    "tls": r.get("host") in tls_hosts,
                })
        ingresses.append({
            "namespace": ns, "name": meta.get("name"),
            "ingress_class": spec.get("ingressClassName"), "rules": rules,
            "address": [x.get("ip") or x.get("hostname")
                        for x in (status.get("loadBalancer") or {}).get("ingress") or []],
        })

    routes, routes_per_ns = http_routes(routes_doc, gateways_doc)
    for ns, n in routes_per_ns.items():
        namespaces[ns].httproutes += n
    bad_routes = [r for r in routes if r["problem"]]
    if bad_routes:
        reasons.append(f"{len(bad_routes)} HTTPRoute(s) não aceita(s) pelo gateway")

    # --- namespaces ---------------------------------------------------------------------
    ns_out = []
    for n in _items(ns_doc):
        meta = n.get("metadata") or {}
        name = meta.get("name") or ""
        a = namespaces.get(name, _Ns())
        ns_out.append({
            "name": name, "phase": (n.get("status") or {}).get("phase"),
            "created_at": meta.get("creationTimestamp"), "pods": a.pods, "running": a.running,
            "problems": a.problems, "workloads": a.workloads, "services": a.services,
            "ingresses": a.ingresses, "httproutes": a.httproutes,
            "cpu_usage": a.cpu_usage if metrics else None,
            "mem_usage": a.mem_usage if metrics else None, "cpu_requests": a.cpu_requests,
            "mem_requests": a.mem_requests,
        })
    ns_out.sort(key=lambda n: (-(n["mem_usage"] or n["mem_requests"]), n["name"]))

    health = "critical" if critical else "warning" if reasons else "healthy"
    summary = {
        "nodes": len(nodes_out), "nodes_ready": len(nodes_out) - len(not_ready),
        "namespaces": len(ns_out), "pods": len(pods_out), "pods_running": running,
        "pods_problem": problems, "workloads": len(workloads), "workloads_unready": len(unready),
        "services": len(services), "ingresses": len(ingresses), "httproutes": len(routes),
        "gateway_api": routes_doc is not None, "metrics": metrics,
        **{k: totals[k] for k in ("cpu_capacity", "cpu_allocatable", "mem_capacity",
                                  "mem_allocatable", "cpu_requests", "mem_requests")},
        "cpu_usage": totals["cpu_usage"] if metrics else None,
        "mem_usage": totals["mem_usage"] if metrics else None,
    }
    data = {
        "nodes": nodes_out, "namespaces": ns_out, "workloads": workloads,
        "pods": pods_out[:MAX_PODS], "pods_truncated": len(pods_out) > MAX_PODS,
        "services": services, "ingresses": ingresses, "httproutes": routes,
    }
    return Snapshot(health, reasons, version, summary, data)


# --- worker ----------------------------------------------------------------------------


async def _store(
    sessionmaker: async_sessionmaker[AsyncSession], cluster_id: uuid.UUID, snap: Snapshot,
    now: datetime,
) -> None:
    ok = snap.error is None
    values: dict[str, Any] = {
        "cluster_id": cluster_id, "health": snap.health, "reasons": snap.reasons,
        "error": snap.error, "collected_at": now,
    }
    if ok:  # an unreachable cluster keeps its last good picture
        values |= {"version": snap.version, "summary": snap.summary, "data": snap.data,
                   "ok_at": now}
    stmt = insert(K8sSnapshot).values(**values)
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        if await db.get(K8sCluster, cluster_id) is None:
            return  # removed meanwhile
        await db.execute(stmt.on_conflict_do_update(
            index_elements=["cluster_id"],
            set_={k: v for k, v in values.items() if k != "cluster_id"},
        ))


async def _kubeconfigs(
    sessionmaker: async_sessionmaker[AsyncSession], secrets: SecretsBackend
) -> list[tuple[uuid.UUID, str, str]]:
    async with sessionmaker() as db, db.begin():
        await set_platform_scope(db)
        rows = (await db.execute(
            select(K8sCluster).where(K8sCluster.kubeconfig_ciphertext.is_not(None))
        )).scalars().all()
        out = []
        for c in rows:
            try:
                text = unseal(secrets, Sealed(c.kubeconfig_ciphertext, c.dek_wrapped,
                                              c.kek_ref or ""), aad=c.id.bytes)
            except SecretsError:
                logger.warning("kubeconfig cannot be unsealed", extra={"cluster": c.name})
                continue
            out.append((c.id, c.name, text))
        return out


async def poll_clusters(
    sessionmaker: async_sessionmaker[AsyncSession],
    secrets: SecretsBackend | None,
    *,
    concurrency: int = 4,
    cluster_timeout: float = 30.0,
    reader_factory=K8sReader,
) -> dict[str, int]:
    if secrets is None:
        return {}
    clusters = await _kubeconfigs(sessionmaker, secrets)
    slots = asyncio.Semaphore(concurrency)
    counts: dict[str, int] = defaultdict(int)

    async def one(cluster_id: uuid.UUID, name: str, text: str) -> None:
        async with slots:
            now = datetime.now(UTC)
            try:
                async with asyncio.timeout(cluster_timeout):
                    async with reader_factory(text) as reader:
                        snap = await collect(reader, now)
            except TimeoutError:
                snap = Snapshot("unreachable", [f"sem resposta em {cluster_timeout:.0f}s"],
                                None, {}, {}, error="timeout")
            except K8sApiError as exc:
                snap = Snapshot("unreachable", ["API inacessível"], None, {}, {},
                                error=str(exc)[:300])
            except Exception as exc:  # one broken cluster must not stop the others
                logger.exception("kubernetes collection crashed", extra={"cluster": name})
                snap = Snapshot("unreachable", ["falha ao ler o cluster"], None, {}, {},
                                error=type(exc).__name__)
            counts[snap.health] += 1
            await _store(sessionmaker, cluster_id, snap, now)

    await asyncio.gather(*(one(*c) for c in clusters))
    return dict(counts)
