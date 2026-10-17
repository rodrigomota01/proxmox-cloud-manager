"""Pod logs, read on demand through the cluster API (platform admins).

One pod, or every pod of a workload with their lines merged in time order, each line
tagged with its pod. Nothing is stored: logs may carry credentials. The pods are listed
live (not from the snapshot, which can be a minute old), so a workload's freshly
replaced pods are the ones read.
"""

import asyncio
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.k8s.client import K8sApiError
from app.k8s.collect import pod_workload

MAX_PODS = 20  # read at once; a bigger workload reports the cut
MAX_TAIL = 5000
DEFAULT_TAIL = 500
MAX_SINCE = 7 * 86400
MAX_BYTES = 2 * 2**20  # kept per pod
MAX_LINE = 4000  # characters shown per line
CONCURRENCY = 5  # the same default as `kubectl logs -l`
DEFAULT_CONTAINER = "kubectl.kubernetes.io/default-container"

# RFC3339 with up to nanoseconds, as the kubelet writes it with timestamps=true
_TS = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d) ")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


@dataclass(frozen=True)
class LogQuery:
    namespace: str
    workload: str | None = None  # "Kind/name", or
    pods: tuple[str, ...] = ()  # pod names
    container: str | None = None  # None: each pod's default container
    tail_lines: int = DEFAULT_TAIL
    since_seconds: int | None = None
    previous: bool = False  # the instance before the last restart


def _container(pod: dict[str, Any], wanted: str | None) -> str | None:
    names = [c.get("name") for c in (pod.get("spec") or {}).get("containers") or []]
    if wanted:
        return wanted if wanted in names else None
    default = ((pod.get("metadata") or {}).get("annotations") or {}).get(DEFAULT_CONTAINER)
    return default if default in names else next(iter(names), None)


def _split(line: str) -> tuple[str, str | None, str]:
    """(sort key, timestamp, text). Fractions are padded so keys compare as strings."""
    m = _TS.match(line)
    if not m:
        return "", None, line
    key = f"{m.group(1)}.{(m.group(2) or '').ljust(9, '0')}{m.group(3)}"
    return key, line[m.start(): m.end() - 1], line[m.end():]


def _clean(text: str) -> str:
    text = _ANSI.sub("", text).rstrip("\r")
    return text if len(text) <= MAX_LINE else text[:MAX_LINE] + " …"


async def read_logs(reader, q: LogQuery) -> dict[str, Any]:
    items = (await reader.namespace_pods(q.namespace)).get("items") or []
    by_name = {(p.get("metadata") or {}).get("name"): p for p in items}
    if q.workload:
        chosen = sorted(n for n, p in by_name.items()
                        if pod_workload(p.get("metadata") or {}) == q.workload)
    else:
        chosen = sorted(set(q.pods))
    truncated = len(chosen) > MAX_PODS
    chosen = chosen[:MAX_PODS]

    params = {"timestamps": "true", "tailLines": str(q.tail_lines)}
    if q.since_seconds:
        params["sinceSeconds"] = str(q.since_seconds)
    if q.previous:
        params["previous"] = "true"
    slots = asyncio.Semaphore(CONCURRENCY)

    async def one(name: str) -> tuple[dict[str, Any], list[tuple[str, str | None, str]]]:
        pod = by_name.get(name)
        if pod is None:
            return {"name": name, "status": None, "restarts": 0, "containers": [],
                    "container": None, "lines": 0, "partial": False,
                    "error": "o pod não existe mais"}, []
        status = pod.get("status") or {}
        out = {
            "name": name, "status": status.get("phase"),
            "restarts": sum(int(c.get("restartCount") or 0)
                            for c in status.get("containerStatuses") or []),
            "containers": [c.get("name") for c in (pod.get("spec") or {}).get("containers") or []],
            "container": _container(pod, q.container), "lines": 0, "partial": False,
            "error": None,
        }
        if out["container"] is None:
            out["error"] = f"o pod não tem o container {q.container}"
            return out, []
        try:
            async with slots:
                text, out["partial"] = await reader.pod_log(
                    q.namespace, name, {**params, "container": out["container"]},
                    max_bytes=MAX_BYTES,
                )
        except K8sApiError as exc:
            out["error"] = str(exc)
            return out, []
        lines = [_split(line) for line in text.splitlines() if line]
        out["lines"] = len(lines)
        return out, lines

    results = await asyncio.gather(*(one(n) for n in chosen))
    merged = sorted(
        (key, i, j, ts, pod["name"], text)
        for i, (pod, lines) in enumerate(results)
        for j, (key, ts, text) in enumerate(lines)
    )
    # the latest N lines overall are among the latest N of each pod: the cut is exact
    merged = merged[-q.tail_lines:]
    return {
        "namespace": q.namespace, "workload": q.workload,
        "pods": [pod for pod, _ in results], "pods_truncated": truncated,
        "lines": [{"ts": ts, "pod": pod, "text": _clean(text)}
                  for _, _, _, ts, pod, text in merged],
        "fetched_at": datetime.now(UTC),
    }
