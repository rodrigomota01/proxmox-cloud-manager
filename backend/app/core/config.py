"""Application settings loaded from environment variables (prefix CM_)."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, PostgresDsn, RedisDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CM_", env_file=".env", extra="ignore")

    env: Literal["dev", "test", "staging", "production"] = "dev"
    service_name: str = "cloud-manager"
    log_level: str = "INFO"

    database_url: PostgresDsn = Field(
        default=PostgresDsn("postgresql://cm_app:change-me@postgres:5432/cloudmanager"),
    )
    redis_url: RedisDsn = Field(default=RedisDsn("redis://redis:6379/0"))

    readiness_timeout_seconds: float = 2.0
    worker_heartbeat_seconds: float = 30.0

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
