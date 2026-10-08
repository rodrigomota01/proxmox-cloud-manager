"""Read-only client for a cluster's API, built from its kubeconfig.

The kubeconfigs are cluster-admin, so read-only is enforced here, not trusted to the
credential: the only operation is `get`, on an allowlist of collection paths, and the
underlying HTTP client is never exposed. Secrets and ConfigMaps are not on the list.
"""

import base64
import os
import ssl
import tempfile
from types import TracebackType
from typing import Any

import httpx
import yaml

# everything the collector reads; anything else is refused before leaving the process
ALLOWED_PATHS = frozenset({
    "/version",
    "/readyz",
    "/api/v1/nodes",
    "/api/v1/namespaces",
    "/api/v1/pods",
    "/api/v1/services",
    "/apis/apps/v1/deployments",
    "/apis/apps/v1/statefulsets",
    "/apis/apps/v1/daemonsets",
    "/apis/networking.k8s.io/v1/ingresses",
    # Gateway API (HTTPRoute), when installed: v1, or v1beta1 on older controllers
    "/apis/gateway.networking.k8s.io/v1/httproutes",
    "/apis/gateway.networking.k8s.io/v1/gateways",
    "/apis/gateway.networking.k8s.io/v1beta1/httproutes",
    "/apis/gateway.networking.k8s.io/v1beta1/gateways",
    "/apis/metrics.k8s.io/v1beta1/nodes",
    "/apis/metrics.k8s.io/v1beta1/pods",
})


class K8sApiError(Exception):
    pass


class ForbiddenPath(K8sApiError):
    pass


def _ssl_context(cluster: dict[str, Any], user: dict[str, Any]) -> ssl.SSLContext | bool:
    """CA and client certificate from inline data. ssl needs files for the key pair:
    they live in a private temp dir only while the context loads them."""
    if cluster.get("insecure-skip-tls-verify"):
        ctx = ssl.create_default_context()
        ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    elif ca := cluster.get("certificate-authority-data"):
        ctx = ssl.create_default_context(cadata=base64.b64decode(ca).decode())
    else:
        ctx = ssl.create_default_context()
    cert, key = user.get("client-certificate-data"), user.get("client-key-data")
    if cert and key:
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            paths = []
            for name, data in (("tls.crt", cert), ("tls.key", key)):
                path = os.path.join(tmp, name)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as f:
                    f.write(base64.b64decode(data))
                paths.append(path)
            ctx.load_cert_chain(*paths)
    return ctx


class K8sReader:
    def __init__(self, kubeconfig_text: str, *, timeout: float = 15.0) -> None:
        doc = yaml.safe_load(kubeconfig_text)
        try:
            contexts = {c["name"]: c["context"] for c in doc.get("contexts") or []}
            ctx = contexts.get(doc.get("current-context")) or next(iter(contexts.values()), {})
            clusters = {c["name"]: c["cluster"] for c in doc["clusters"]}
            users = {u["name"]: u.get("user") or {} for u in doc.get("users") or []}
            cluster = clusters.get(ctx.get("cluster")) or next(iter(clusters.values()))
            user = users.get(ctx.get("user")) or next(iter(users.values()), {})
        except (KeyError, StopIteration, TypeError, AttributeError) as exc:
            raise K8sApiError("kubeconfig without a usable cluster") from exc
        if "exec" in user or "auth-provider" in user:
            raise K8sApiError("kubeconfig uses an exec/auth-provider plugin (unsupported)")
        headers = {"Accept": "application/json"}
        if token := user.get("token"):
            headers["Authorization"] = f"Bearer {token}"
        try:
            verify = _ssl_context(cluster, user)
        except (ssl.SSLError, ValueError) as exc:
            raise K8sApiError(
                f"kubeconfig TLS data cannot be loaded: {type(exc).__name__}"
            ) from exc
        self.server = cluster["server"].rstrip("/")
        self.__http = httpx.AsyncClient(
            base_url=self.server, verify=verify, headers=headers, timeout=timeout,
            follow_redirects=False,
        )

    async def __aenter__(self) -> "K8sReader":
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.__http.aclose()

    async def get(self, path: str, *, optional: bool = False) -> Any:
        """JSON of a GET on an allowed path. `optional`: 404/503 (an API group that is
        not installed, e.g. metrics-server) returns None instead of raising."""
        if path not in ALLOWED_PATHS:
            raise ForbiddenPath(path)
        try:
            r = await self.__http.get(path)
        except httpx.HTTPError as exc:
            raise K8sApiError(f"{type(exc).__name__}: {exc}"[:300]) from exc
        if optional and r.status_code in (404, 503):
            return None
        if r.status_code >= 400:
            raise K8sApiError(f"GET {path}: HTTP {r.status_code}")
        if path == "/readyz":
            return r.text.strip()
        return r.json()
