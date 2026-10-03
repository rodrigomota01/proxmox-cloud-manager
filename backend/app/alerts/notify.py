"""Alert notifications: e-mail and signed webhooks, sent by the `alert.notify` job.

Who is told: the channels of the rule's owner plus those of the tenant that owns the
resource. So a platform default rule on a client's VM reaches the platform team *and*
the client; a client's own rule reaches only the client. Each channel filters by
minimum severity ("resolved" follows the severity of the alert it closes).

Webhooks are an SSRF surface (tenants choose the URL and the worker has egress):
https only, no redirects, every resolved address must be public, and the connection
goes to the address that was checked (no second DNS lookup to rebind).
"""

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import socket
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.alerts.models import RATIO_METRICS, Alert, NotificationChannel
from app.core.config import Settings
from app.infra.mailer import Mail, Mailer, build_mailer
from app.infra.secrets import Sealed, SecretsBackend, unseal
from app.jobs.queue import JobContext, JobFailed, RetryLater, enqueue, handler

logger = logging.getLogger(__name__)

SEVERITY_RANK = {"warning": 1, "critical": 2}
METRIC_LABEL = {
    "cpu": "CPU", "memory": "memória", "disk": "disco", "net_in": "rede (entrada)",
    "net_out": "rede (saída)",
}
RESOURCE_LABEL = {"node": "Hypervisor", "storage": "Storage", "instance": "VM"}


class WebhookRejected(Exception):
    """The target is not allowed (scheme, private address...). Not retried."""


def format_value(metric: str, value: float) -> str:
    if metric in RATIO_METRICS:
        return f"{value * 100:.0f}%"
    return f"{value * 8 / 1_000_000:.1f} Mbit/s"


def check_url(url: str, settings: Settings) -> None:
    """Static validation (on save): scheme, host, no credentials in the URL."""
    parts = urlsplit(url)
    allowed = ("https", "http") if settings.webhook_allow_http else ("https",)
    if parts.scheme not in allowed:
        raise WebhookRejected("a URL do webhook precisa ser https")
    if not parts.hostname or parts.username or parts.password:
        raise WebhookRejected("URL inválida (sem host, ou com usuário/senha embutidos)")


def _public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return addr.is_global and not addr.is_multicast


async def resolve_public(host: str, port: int, settings: Settings) -> str:
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise WebhookRejected(f"não foi possível resolver {host}") from exc
    ips = sorted({str(info[4][0]) for info in infos})
    if not settings.webhook_allow_private and not all(_public(ip) for ip in ips):
        raise WebhookRejected(f"{host} aponta para um endereço interno; não permitido")
    return ips[0]


class WebhookSender(Protocol):
    async def post(self, url: str, body: bytes, headers: dict[str, str]) -> None: ...


class HttpWebhookSender:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def post(self, url: str, body: bytes, headers: dict[str, str]) -> None:
        check_url(url, self.settings)
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "https" else 80)
        ip = await resolve_public(host, port, self.settings)
        netloc = f"[{ip}]" if ":" in ip else ip
        pinned = urlunsplit((parts.scheme, f"{netloc}:{port}", parts.path or "/", parts.query, ""))
        async with httpx.AsyncClient(
            timeout=self.settings.webhook_timeout_seconds, follow_redirects=False
        ) as client:
            response = await client.post(
                pinned, content=body,
                headers={**headers, "Host": parts.netloc.rsplit("@", 1)[-1],
                         "Content-Type": "application/json"},
                # TLS checks the certificate against the real host name, not the IP
                extensions={"sni_hostname": host},
            )
        if response.status_code >= 300:
            raise httpx.HTTPStatusError(
                f"webhook answered HTTP {response.status_code}", request=response.request,
                response=response,
            )


def sign(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return f"sha256={digest.hexdigest()}"


@dataclass
class Notifier:
    settings: Settings
    mailer: Mailer
    webhook: WebhookSender
    secrets: SecretsBackend | None

    @classmethod
    def build(cls, settings: Settings, secrets: SecretsBackend | None) -> "Notifier":
        return cls(settings, build_mailer(settings), HttpWebhookSender(settings), secrets)

    def payload(self, alert: Alert, event: str) -> dict[str, Any]:
        summary = self.mail("", alert, event).subject.removeprefix("[Cloud Manager] ")
        return {
            # chat services render these as the message (Slack/Mattermost: text,
            # Discord: content); everything else is for programmatic receivers
            "text": f"Cloud Manager — {summary}",
            "content": f"Cloud Manager — {summary}",
            "event": event,  # firing|resolved|test
            "alert_id": str(alert.id),
            "severity": alert.severity,
            "rule": alert.rule_name,
            "resource": {"type": alert.resource_type, "id": str(alert.resource_id),
                         "name": alert.resource_name},
            "metric": alert.metric,
            "value": alert.value,
            "peak": alert.peak,
            "threshold": alert.threshold,
            "value_text": format_value(alert.metric, alert.value),
            "threshold_text": format_value(alert.metric, alert.threshold),
            "started_at": alert.started_at.isoformat(),
            "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
            "url": f"{self.settings.public_base_url}/alerts",
        }

    def mail(self, to: str, alert: Alert, event: str) -> Mail:
        what = f"{RESOURCE_LABEL.get(alert.resource_type, '')} {alert.resource_name}".strip()
        metric = METRIC_LABEL.get(alert.metric, alert.metric)
        value = format_value(alert.metric, alert.value)
        limit = format_value(alert.metric, alert.threshold)
        if event == "resolved":
            subject = f"[Cloud Manager] RESOLVIDO: {what} — {metric} normalizada"
            first = f"O alerta \"{alert.rule_name}\" foi resolvido: {metric} agora em {value}."
        else:
            tag = "TESTE" if event == "test" else alert.severity.upper()
            subject = f"[Cloud Manager] {tag}: {what} — {metric} {value} (limite {limit})"
            first = f"{what}: {metric} em {value}, acima do limite de {limit}."
        body = (
            f"{first}\n\nRegra: {alert.rule_name}\nSeveridade: {alert.severity}\n"
            f"Pico: {format_value(alert.metric, alert.peak)}\n"
            f"Início: {alert.started_at:%d/%m/%Y %H:%M} UTC\n\n"
            f"Ver alertas: {self.settings.public_base_url}/alerts\n"
        )
        return Mail(to=to, subject=subject, body=body)

    async def send(self, channel: NotificationChannel, alert: Alert, event: str) -> None:
        if channel.type == "email":
            for to in channel.config.get("to", []):
                await self.mailer.send(self.mail(to, alert, event))
            return
        body = json.dumps(self.payload(alert, event), separators=(",", ":")).encode()
        headers = {"User-Agent": "cloud-manager-alerts/1"}
        if channel.secret_ciphertext and channel.dek_wrapped and channel.kek_ref:
            if self.secrets is None:
                raise JobFailed("KEK_MISSING", "CM_KEK not configured; cannot sign webhook")
            secret = unseal(
                self.secrets,
                Sealed(channel.secret_ciphertext, channel.dek_wrapped, channel.kek_ref),
                aad=channel.id.bytes,
            )
            timestamp = str(int(time.time()))
            headers["X-CM-Timestamp"] = timestamp
            headers["X-CM-Signature"] = sign(secret, timestamp, body)
        await self.webhook.post(str(channel.config["url"]), body, headers)


_notifier: Notifier | None = None


def configure(notifier: Notifier | None) -> None:
    """The worker (and tests) install the notifier; otherwise one is built on first use."""
    global _notifier
    _notifier = notifier


def notifier_for(ctx: JobContext) -> Notifier:
    global _notifier
    if _notifier is None:
        _notifier = Notifier.build(ctx.providers.settings, ctx.providers.secrets)
    return _notifier


async def recipients(db: AsyncSession, alert: Alert) -> list[NotificationChannel]:
    owners = [NotificationChannel.tenant_id == alert.tenant_id] if alert.tenant_id else []
    owners.append(
        NotificationChannel.tenant_id.is_(None) if alert.rule_tenant_id is None
        else NotificationChannel.tenant_id == alert.rule_tenant_id
    )
    stmt = select(NotificationChannel).where(NotificationChannel.enabled, or_(*owners))
    rank = SEVERITY_RANK[alert.severity]
    return [
        c for c in (await db.execute(stmt)).scalars()
        if SEVERITY_RANK[c.min_severity] <= rank
    ]


async def enqueue_notifications(db: AsyncSession, alert: Alert, event: str) -> int:
    """One job per channel: a receiver that is down is retried alone, and the others
    are not told twice."""
    channels = await recipients(db, alert)
    for channel in channels:
        # no resource_id: jobs allow one active operation per resource, and these
        # are several deliveries of the same alert
        await enqueue(
            db, "alert.notify", tenant_id=None, requested_by=None,
            payload={"event": event, "channel_id": str(channel.id), "alert_id": str(alert.id)},
        )
    return len(channels)


@handler("alert.notify")
async def alert_notify(ctx: JobContext) -> dict[str, Any]:
    """payload {"event": firing|resolved|test, "channel_id", "alert_id"}; a test has no
    alert and sends a sample one."""
    event = ctx.job.payload["event"]
    db = await ctx.session()
    try:
        channel = await db.get(NotificationChannel, uuid.UUID(ctx.job.payload["channel_id"]))
        alert = (
            sample_alert() if event == "test"
            else await db.get(Alert, uuid.UUID(ctx.job.payload["alert_id"]))
        )
        await db.commit()
    finally:
        await db.close()
    if channel is None or alert is None:
        return {"sent": False, "reason": "channel or alert deleted meanwhile"}
    try:
        await notifier_for(ctx).send(channel, alert, event)
    except WebhookRejected as exc:  # configuration problem: retrying will not help
        raise JobFailed("WEBHOOK_REJECTED", str(exc)) from exc
    except (httpx.HTTPError, OSError) as exc:
        raise RetryLater(f"{channel.name}: {exc}") from exc
    return {"sent": True, "channel": channel.name}


def sample_alert() -> Alert:
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    return Alert(
        id=uuid.UUID(int=0), rule_id=uuid.UUID(int=0), resource_type="instance",
        resource_id=uuid.UUID(int=0), resource_name="vm-exemplo", rule_name="Teste de notificação",
        metric="cpu", threshold=0.9, severity="warning", value=0.97, peak=0.99, state="firing",
        started_at=now, updated_at=now,
    )
