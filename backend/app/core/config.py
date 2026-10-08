"""Application settings loaded from environment variables (prefix CM_)."""

from functools import lru_cache
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import Field, PostgresDsn, RedisDsn, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _sqlalchemy_url(dsn: PostgresDsn) -> str:
    return str(dsn).replace("postgresql://", "postgresql+asyncpg://", 1)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CM_", env_file=".env", extra="ignore")

    env: Literal["dev", "test", "staging", "production"] = "dev"
    service_name: str = "cloud-manager"
    log_level: str = "INFO"

    # cm_app: runtime role (RLS applies). cm_owner: migrations and catalog seed only.
    database_url: PostgresDsn = Field(
        default=PostgresDsn("postgresql://cm_app:change-me@postgres:5432/cloudmanager"),
    )
    migration_database_url: PostgresDsn | None = None
    db_pool_size: int = 10
    redis_url: RedisDsn = Field(default=RedisDsn("redis://redis:6379/0"))

    readiness_timeout_seconds: float = 2.0

    # Auth (docs/architecture/06-autenticacao.md)
    jwt_private_key: SecretStr | None = None  # Ed25519 PEM; `python -m app.cli gen-keys`
    jwt_issuer: str = "cloud-manager"
    access_token_ttl_seconds: int = 600
    refresh_idle_ttl_seconds: int = 12 * 3600
    refresh_absolute_ttl_seconds: int = 7 * 24 * 3600
    password_reset_ttl_seconds: int = 30 * 60
    invite_ttl_seconds: int = 72 * 3600
    cookie_secure: bool = True
    allowed_origins: list[str] = ["http://localhost"]
    public_base_url: str = "http://localhost"

    login_rate_limit_ip_per_minute: int = 10
    login_rate_limit_email_per_minute: int = 5

    # Key-encryption key for provider secrets (base64, 32 bytes); `app.cli gen-keys`.
    kek: SecretStr | None = None

    # Proxmox
    provider_timeout_seconds: float = 15.0
    reconcile_interval_seconds: float = 15.0
    # several independent Proxmox servers: sync them in parallel, each with a deadline,
    # so one slow/unreachable server never delays the others
    reconcile_concurrency: int = 4
    reconcile_timeout_seconds: float = 60.0
    # disk usage inside VMs comes from the guest agent: one call per running VM, so slower
    guest_disk_interval_seconds: float = 300.0
    # alert webhooks: only public https targets unless relaxed (dev/lab receivers)
    webhook_allow_http: bool = False
    webhook_allow_private: bool = False
    webhook_timeout_seconds: float = 5.0
    # legacy IPAM (MySQL awf_ip_pool), e.g. mysql://user:pw@host:3306/awf_cloud; None = off
    ipam_mysql_url: SecretStr | None = None
    ipam_sync_interval_seconds: float = 120.0
    # Kubernetes clusters (ADR-0017): read-only collection through each cluster's API
    k8s_poll_interval_seconds: float = 60.0
    k8s_poll_timeout_seconds: float = 30.0
    k8s_poll_concurrency: int = 4
    # concurrent job runners per worker process (a slow shutdown on one server must not
    # hold back operations on another)
    job_concurrency: int = 4

    # Quota applied when a tenant has no explicit limit (admin sets per tenant)
    default_quota_instances: int = 5
    default_quota_vcpus: int = 8
    default_quota_memory_mb: int = 16 * 1024
    default_quota_storage_gb: int = 200

    # Cost (ADR-0015): one currency for the whole platform; months follow this timezone
    billing_currency: str = Field(default="BRL", pattern=r"^[A-Z]{3}$")
    billing_timezone: str = "America/Sao_Paulo"
    billing_interval_seconds: float = 60.0
    # a worker outage longer than this is not charged (guest states are unknown there)
    billing_max_gap_seconds: float = 3600.0

    smtp_host: str | None = None  # unset -> e-mails are only logged (without the token)
    smtp_port: int = 1025
    smtp_from: str = "Cloud Manager <no-reply@cloud-manager.local>"

    @field_validator(
        "jwt_private_key", "kek", "smtp_host", "migration_database_url", "ipam_mysql_url",
        mode="before",
    )
    @classmethod
    def _empty_is_unset(cls, value: object) -> object:
        # compose passes `${VAR:-}` as an empty string
        return None if value == "" else value

    @field_validator("billing_timezone")
    @classmethod
    def _known_timezone(cls, value: str) -> str:
        ZoneInfo(value)  # raises on an unknown zone: fail at startup, not in a report
        return value

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def sqlalchemy_url(self) -> str:
        return _sqlalchemy_url(self.database_url)

    @property
    def sqlalchemy_migration_url(self) -> str:
        if self.migration_database_url is None:
            raise RuntimeError("CM_MIGRATION_DATABASE_URL is required for migrations")
        return _sqlalchemy_url(self.migration_database_url)


@lru_cache
def get_settings() -> Settings:
    return Settings()
