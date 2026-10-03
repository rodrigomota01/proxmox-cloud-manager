"""HTTP client for the Proxmox VE API. The only module that knows URLs and headers.

- Auth: API token header (no ticket/CSRF needed). The secret never appears in errors,
  logs or reprs.
- TLS: system CAs by default, or the cluster's own CA bundle (ca_pem). Skipping
  verification is allowed only in dev.
- GETs are retried with exponential backoff + jitter on transport errors and
  502/503/504; mutations are not retried (not idempotent).
- A per-cluster semaphore bounds concurrency; a circuit breaker stops hammering a
  cluster that keeps failing.
"""

import asyncio
import logging
import random
import ssl
import time
from typing import Any

import httpx

from app.providers.base import (
    ProviderAuthError,
    ProviderError,
    ProviderUnavailable,
    ProviderValidationError,
)

logger = logging.getLogger(__name__)

_RETRY_STATUS = {502, 503, 504}


class CircuitBreaker:
    def __init__(self, threshold: int = 5, reset_seconds: float = 30.0) -> None:
        self.threshold, self.reset_seconds = threshold, reset_seconds
        self.failures = 0
        self.opened_at: float | None = None

    def check(self) -> None:
        if self.opened_at is None:
            return
        if time.monotonic() - self.opened_at >= self.reset_seconds:
            self.opened_at = None  # half-open: let one attempt through
            return
        raise ProviderUnavailable("circuit breaker open (cluster failing repeatedly)")

    def success(self) -> None:
        self.failures, self.opened_at = 0, None

    def failure(self) -> None:
        self.failures += 1
        if self.failures >= self.threshold:
            self.opened_at = time.monotonic()


def build_ssl_context(ca_pem: str | None, insecure: bool) -> ssl.SSLContext | bool:
    if insecure:
        return False
    if ca_pem:
        return ssl.create_default_context(cadata=ca_pem)
    return ssl.create_default_context()


class ProxmoxClient:
    def __init__(
        self,
        api_url: str,
        token_id: str,
        secret: str,
        *,
        verify: ssl.SSLContext | bool = True,
        timeout: float = 15.0,
        max_concurrency: int = 8,
        retries: int = 3,
        breaker: CircuitBreaker | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url=api_url.rstrip("/") + "/api2/json",
            headers={"Authorization": f"PVEAPIToken={token_id}={secret}"},
            verify=verify,
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        )
        self._sem = asyncio.Semaphore(max_concurrency)
        self._retries = retries
        self.breaker = breaker or CircuitBreaker()
        self.token_id = token_id

    def __repr__(self) -> str:  # never show the secret
        return f"ProxmoxClient({self._http.base_url}, token_id={self.token_id})"

    async def aclose(self) -> None:
        await self._http.aclose()

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._request("GET", path, params=params, retry=True)

    async def post(self, path: str, data: dict[str, Any] | None = None) -> Any:
        return await self._request("POST", path, data=data, retry=False)

    async def put(self, path: str, data: dict[str, Any] | None = None) -> Any:
        return await self._request("PUT", path, data=data, retry=False)

    async def delete(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._request("DELETE", path, params=params, retry=False)

    async def _request(
        self, method: str, path: str, *, retry: bool, params: Any = None, data: Any = None
    ) -> Any:
        self.breaker.check()
        attempts = self._retries + 1 if retry else 1
        last: ProviderError | None = None
        for attempt in range(attempts):
            if attempt:
                # jitter only, not security-sensitive
                jitter = 0.5 + random.random()  # noqa: S311  # nosec B311
                await asyncio.sleep(min(0.25 * 2**attempt, 4.0) * jitter)
            try:
                async with self._sem:
                    response = await self._http.request(method, path, params=params, data=data)
            except httpx.TransportError as exc:
                last = ProviderUnavailable(f"{method} {path}: {type(exc).__name__}")
                continue
            if response.status_code in _RETRY_STATUS:
                last = ProviderUnavailable(f"{method} {path}: HTTP {response.status_code}")
                continue
            self.breaker.success()
            return self._unwrap(method, path, response)
        self.breaker.failure()
        if last is None:  # unreachable: attempts >= 1 and every failed one sets it
            last = ProviderUnavailable(f"{method} {path}: no attempt made")
        logger.warning("proxmox request failed", extra={"error": str(last)})
        raise last

    @staticmethod
    def _unwrap(method: str, path: str, response: httpx.Response) -> Any:
        status = response.status_code
        if status in (401, 403):
            raise ProviderAuthError(f"{method} {path}: HTTP {status} (check token/ACL)")
        # PVE puts the reason in the status line (e.g. "500 VM 105 is locked")
        reason = response.reason_phrase or ""
        if status == 400:
            errors = _json(response).get("errors") or {}
            detail = "; ".join(f"{k}: {v}" for k, v in errors.items()) or reason
            raise ProviderValidationError(f"{method} {path}: {detail}")
        if status >= 400:
            raise ProviderError(f"{method} {path}: HTTP {status} {reason}".strip())
        return _json(response).get("data")


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}
