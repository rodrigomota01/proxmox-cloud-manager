"""cluster -> CloudProvider. Decrypts the credential only here, only for the call."""

import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.infra.secrets import Sealed, SecretsBackend, SecretsError, unseal
from app.inventory.models import ProviderCluster, ProviderCredential
from app.providers.base import CloudProvider, ProviderAuthError, ProviderError
from app.providers.proxmox.client import CircuitBreaker, ProxmoxClient, build_ssl_context
from app.providers.proxmox.provider import ProxmoxProvider

# (cluster, token_id, secret) -> provider; tests swap it for a FakeProvider factory
ProviderFactory = Callable[[ProviderCluster, str, str], CloudProvider]


class ProviderRegistry:
    def __init__(
        self,
        settings: Settings,
        secrets: SecretsBackend | None,
        factory: ProviderFactory | None = None,
    ) -> None:
        self.settings, self.secrets = settings, secrets
        self.factory = factory or self._proxmox
        self._breakers: dict[uuid.UUID, CircuitBreaker] = {}

    def require_secrets(self) -> SecretsBackend:
        if self.secrets is None:
            raise SecretsError("CM_KEK is not configured; run `python -m app.cli gen-keys`")
        return self.secrets

    def _proxmox(self, cluster: ProviderCluster, token_id: str, secret: str) -> CloudProvider:
        if cluster.insecure_skip_verify and self.settings.env != "dev":
            raise ProviderError("TLS verification can only be skipped in dev")
        client = ProxmoxClient(
            cluster.api_url, token_id, secret,
            verify=build_ssl_context(cluster.ca_pem, cluster.insecure_skip_verify),
            timeout=self.settings.provider_timeout_seconds,
            breaker=self._breakers.setdefault(cluster.id, CircuitBreaker()),
        )
        return ProxmoxProvider(client)

    @asynccontextmanager
    async def open(
        self, db: AsyncSession, cluster: ProviderCluster
    ) -> AsyncIterator[CloudProvider]:
        cred = await db.get(ProviderCredential, cluster.id)
        if cred is None:
            raise ProviderAuthError("cluster has no credentials")
        secret = unseal(
            self.require_secrets(),
            Sealed(cred.secret_ciphertext, cred.dek_wrapped, cred.kek_ref),
            aad=cluster.id.bytes,
        )
        provider = self.factory(cluster, cred.token_id, secret)
        try:
            yield provider
        finally:
            await provider.aclose()
