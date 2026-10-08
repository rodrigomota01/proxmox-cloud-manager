"""Wiring: the configured source (same MySQL as the IPAM) and expiry status."""

from datetime import date

from app.core.config import Settings
from app.k8s.models import K8sCluster
from app.k8s.source import K8sSource, MysqlK8sSource

WARN_DAYS, CRITICAL_DAYS = 30, 7

_override: K8sSource | None = None


def configure(source: K8sSource | None) -> None:
    """Tests install a fake source; production builds one from the settings."""
    global _override
    _override = source


def source_for(settings: Settings) -> K8sSource | None:
    if _override is not None:
        return _override
    if settings.ipam_mysql_url is None:
        return None
    return MysqlK8sSource(settings.ipam_mysql_url.get_secret_value())


def expires_on(c: K8sCluster) -> date | None:
    """The earliest of what the table says and what the certificate says: the table
    has been seen to drift (e.g. 2099 for a certificate that already expired)."""
    known = [d for d in (c.certs_expire_on, c.cert_expires_at and c.cert_expires_at.date()) if d]
    return min(known) if known else None


def status(days_left: int | None) -> str:
    if days_left is None:
        return "unknown"
    if days_left < 0:
        return "expired"
    if days_left <= CRITICAL_DAYS:
        return "critical"
    return "warning" if days_left <= WARN_DAYS else "ok"
