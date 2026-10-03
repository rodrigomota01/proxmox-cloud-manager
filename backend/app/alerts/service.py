"""Rules and channels of one owner: a tenant, or the platform (owner None).

The same code serves /alert-rules (tenant scope, RLS on that tenant) and
/admin/alert-rules (platform scope). Queries always pin the owner explicitly, so in
platform scope a tenant's rules are never mistaken for the platform's.
"""

import secrets
import uuid

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.alerts.models import AlertRule, NotificationChannel
from app.alerts.notify import WebhookRejected, check_url
from app.alerts.schemas import (
    AlertRuleCreate,
    AlertRuleUpdate,
    ChannelCreate,
    ChannelCreated,
    ChannelOut,
    ChannelUpdate,
    check_threshold,
)
from app.core.config import Settings
from app.core.errors import NotFound, ProviderUnavailableError, ValidationError
from app.core.ids import uuid7
from app.infra.secrets import SecretsBackend, seal
from app.jobs.models import Job
from app.jobs.queue import enqueue


def channel_out(c: NotificationChannel) -> ChannelOut:
    return ChannelOut(
        id=c.id, name=c.name, type=c.type, to=list(c.config.get("to", [])),
        url=c.config.get("url"), min_severity=c.min_severity, enabled=c.enabled,
        signed=c.secret_ciphertext is not None, created_at=c.created_at,
    )


class AlertConfig:
    def __init__(
        self, db: AsyncSession, owner: uuid.UUID | None, settings: Settings,
        secrets_backend: SecretsBackend | None = None,
    ) -> None:
        self.db, self.owner, self.settings, self.secrets = db, owner, settings, secrets_backend

    def _mine(self, column: ColumnElement) -> ColumnElement[bool]:
        return column.is_(None) if self.owner is None else column == self.owner

    # --- rules -----------------------------------------------------------------------

    async def rules(self) -> list[AlertRule]:
        stmt = select(AlertRule).where(self._mine(AlertRule.tenant_id))
        stmt = stmt.order_by(AlertRule.target, AlertRule.name)
        return list((await self.db.execute(stmt)).scalars())

    async def rule(self, rule_id: uuid.UUID) -> AlertRule:
        rule = await self.db.scalar(
            select(AlertRule).where(AlertRule.id == rule_id, self._mine(AlertRule.tenant_id))
        )
        if rule is None:
            raise NotFound()
        return rule

    async def create_rule(self, body: AlertRuleCreate) -> AlertRule:
        if self.owner is not None and body.target != "instance":
            raise ValidationError("clients can only watch their instances")
        rule = AlertRule(tenant_id=self.owner, **body.model_dump())
        self.db.add(rule)
        await self.db.flush()
        await self.db.refresh(rule)
        return rule

    async def update_rule(self, rule_id: uuid.UUID, body: AlertRuleUpdate) -> AlertRule:
        rule = await self.rule(rule_id)
        changes = body.model_dump(exclude_unset=True)
        if changes.get("threshold") is not None:
            try:
                check_threshold(rule.metric, changes["threshold"])
            except ValueError as exc:
                raise ValidationError(str(exc)) from exc
        for field, value in changes.items():
            if value is not None:
                setattr(rule, field, value)
        await self.db.flush()
        await self.db.refresh(rule)
        return rule

    async def delete_rule(self, rule_id: uuid.UUID) -> None:
        await self.db.delete(await self.rule(rule_id))  # its alerts go with it (cascade)

    # --- channels --------------------------------------------------------------------

    async def channels(self) -> list[NotificationChannel]:
        stmt = select(NotificationChannel).where(self._mine(NotificationChannel.tenant_id))
        return list((await self.db.execute(stmt.order_by(NotificationChannel.name))).scalars())

    async def channel(self, channel_id: uuid.UUID) -> NotificationChannel:
        channel = await self.db.scalar(
            select(NotificationChannel).where(
                NotificationChannel.id == channel_id, self._mine(NotificationChannel.tenant_id)
            )
        )
        if channel is None:
            raise NotFound()
        return channel

    def _check_url(self, url: str) -> None:
        try:
            check_url(url, self.settings)
        except WebhookRejected as exc:
            raise ValidationError(str(exc)) from exc

    async def create_channel(self, body: ChannelCreate) -> ChannelCreated:
        signing_secret = None
        channel = NotificationChannel(
            tenant_id=self.owner, name=body.name, type=body.type,
            min_severity=body.min_severity, enabled=body.enabled,
            config={"to": body.to} if body.type == "email" else {"url": body.url},
        )
        if body.type == "webhook":
            self._check_url(str(body.url))
            if self.secrets is None:
                raise ProviderUnavailableError("CM_KEK not configured; cannot store webhook secret")
            channel.id = uuid7()
            signing_secret = secrets.token_urlsafe(32)
            sealed = seal(self.secrets, signing_secret, aad=channel.id.bytes)
            channel.secret_ciphertext, channel.dek_wrapped = sealed.ciphertext, sealed.dek_wrapped
            channel.kek_ref = sealed.kek_ref
        self.db.add(channel)
        await self.db.flush()
        await self.db.refresh(channel)
        return ChannelCreated(**channel_out(channel).model_dump(), signing_secret=signing_secret)

    async def update_channel(
        self, channel_id: uuid.UUID, body: ChannelUpdate
    ) -> NotificationChannel:
        channel = await self.channel(channel_id)
        if body.to is not None:
            if channel.type != "email":
                raise ValidationError("`to` is only for e-mail channels")
            channel.config = {"to": body.to}
        if body.url is not None:
            if channel.type != "webhook":
                raise ValidationError("`url` is only for webhook channels")
            self._check_url(body.url)
            channel.config = {"url": body.url}
        for field in ("name", "min_severity", "enabled"):
            if (value := getattr(body, field)) is not None:
                setattr(channel, field, value)
        await self.db.flush()
        await self.db.refresh(channel)
        return channel

    async def delete_channel(self, channel_id: uuid.UUID) -> None:
        await self.db.delete(await self.channel(channel_id))

    async def test_channel(self, channel_id: uuid.UUID, actor: uuid.UUID) -> Job:
        """Sent by the worker (it has egress; the API does not), like real alerts."""
        channel = await self.channel(channel_id)
        return await enqueue(
            self.db, "alert.notify", tenant_id=self.owner, requested_by=actor,
            resource_type="notification_channel", resource_id=channel.id,
            payload={"event": "test", "channel_id": str(channel.id)},
        )
