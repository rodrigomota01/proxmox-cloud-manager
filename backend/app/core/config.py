"""Application settings loaded from environment variables (prefix CM_)."""

from functools import lru_cache
from typing import Literal

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
    worker_heartbeat_seconds: float = 30.0

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

    smtp_host: str | None = None  # unset -> e-mails are only logged (without the token)
    smtp_port: int = 1025
    smtp_from: str = "Cloud Manager <no-reply@cloud-manager.local>"

    @field_validator("jwt_private_key", "smtp_host", "migration_database_url", mode="before")
    @classmethod
    def _empty_is_unset(cls, value: object) -> object:
        # compose passes `${VAR:-}` as an empty string
        return None if value == "" else value

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
