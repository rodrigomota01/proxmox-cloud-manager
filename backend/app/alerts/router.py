"""/alerts, /alert-rules, /notification-channels (tenant) and their /admin/* twins."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, Response, status
from sqlalchemy import ColumnElement, UnaryExpression, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.alerts.models import Alert
from app.alerts.schemas import (
    AdminAlertOut,
    AlertOut,
    AlertRuleCreate,
    AlertRuleOut,
    AlertRuleUpdate,
    AlertSummary,
    ChannelCreate,
    ChannelCreated,
    ChannelOut,
    ChannelUpdate,
    TestAccepted,
)
from app.alerts.service import AlertConfig, channel_out
from app.api.deps import (
    AppSettings,
    CurrentTenant,
    DbSession,
    Principal,
    TenantContext,
    require_platform,
)
from app.compute.service import ComputeService
from app.core.config import Settings
from app.iam.authz import Scope, authorize
from app.infra.secrets import SecretsBackend
from app.jobs.presenter import job_out
from app.tenancy.models import Tenant

router = APIRouter(tags=["alerts"])
admin_router = APIRouter(prefix="/admin", tags=["admin"])

AlertViewer = Annotated[Principal, require_platform("node:view")]
AlertAdmin = Annotated[Principal, require_platform("alert:manage")]
State = Literal["active", "resolved"]
Limit = Annotated[int, Query(ge=1, le=200)]


def _state(state: State) -> ColumnElement[bool]:
    return Alert.state == ("firing" if state == "active" else "resolved")


def _order(state: State) -> UnaryExpression:
    return Alert.fired_at.desc() if state == "active" else Alert.resolved_at.desc()


def alert_out(a: Alert) -> AlertOut:
    return AlertOut.model_validate(a, from_attributes=True)


def _secrets(request: Request) -> SecretsBackend | None:
    return request.app.state.providers.secrets


# --- tenant ------------------------------------------------------------------------------


async def _tenant_visible(
    ctx: TenantContext, db: AsyncSession
) -> list[ColumnElement[bool]]:
    conditions = [Alert.tenant_id == ctx.tenant_id]
    projects = await ComputeService(db, ctx).viewable_projects()
    if projects is not None:
        conditions.append(Alert.project_id.in_(projects))
    return conditions


@router.get("/alerts")
async def list_alerts(
    ctx: CurrentTenant, db: DbSession, state: State = "active", limit: Limit = 50
) -> list[AlertOut]:
    rows = await db.execute(
        select(Alert).where(*await _tenant_visible(ctx, db), _state(state))
        .order_by(_order(state)).limit(limit)
    )
    return [alert_out(a) for a in rows.scalars()]


@router.get("/alerts/summary")
async def alerts_summary(ctx: CurrentTenant, db: DbSession) -> AlertSummary:
    return await _summary(db, *await _tenant_visible(ctx, db))


async def _manager(
    ctx: TenantContext, db: AsyncSession, settings: Settings, request: Request
) -> AlertConfig:
    await authorize(db, ctx.principal.user_id, "alert:manage", Scope(ctx.tenant_id))
    return AlertConfig(db, ctx.tenant_id, settings, _secrets(request))


@router.get("/alert-rules")
async def list_rules(
    ctx: CurrentTenant, db: DbSession, settings: AppSettings, request: Request
) -> list[AlertRuleOut]:
    svc = await _manager(ctx, db, settings, request)
    return [AlertRuleOut.model_validate(r) for r in await svc.rules()]


@router.post("/alert-rules", status_code=status.HTTP_201_CREATED)
async def create_rule(
    body: AlertRuleCreate, ctx: CurrentTenant, db: DbSession, settings: AppSettings,
    request: Request,
) -> AlertRuleOut:
    svc = await _manager(ctx, db, settings, request)
    return AlertRuleOut.model_validate(await svc.create_rule(body))


@router.patch("/alert-rules/{rule_id}")
async def update_rule(
    rule_id: uuid.UUID, body: AlertRuleUpdate, ctx: CurrentTenant, db: DbSession,
    settings: AppSettings, request: Request,
) -> AlertRuleOut:
    svc = await _manager(ctx, db, settings, request)
    return AlertRuleOut.model_validate(await svc.update_rule(rule_id, body))


@router.delete("/alert-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: uuid.UUID, ctx: CurrentTenant, db: DbSession, settings: AppSettings,
    request: Request,
) -> None:
    await (await _manager(ctx, db, settings, request)).delete_rule(rule_id)


@router.get("/notification-channels")
async def list_channels(
    ctx: CurrentTenant, db: DbSession, settings: AppSettings, request: Request
) -> list[ChannelOut]:
    svc = await _manager(ctx, db, settings, request)
    return [channel_out(c) for c in await svc.channels()]


@router.post("/notification-channels", status_code=status.HTTP_201_CREATED)
async def create_channel(
    body: ChannelCreate, ctx: CurrentTenant, db: DbSession, settings: AppSettings,
    request: Request,
) -> ChannelCreated:
    return await (await _manager(ctx, db, settings, request)).create_channel(body)


@router.patch("/notification-channels/{channel_id}")
async def update_channel(
    channel_id: uuid.UUID, body: ChannelUpdate, ctx: CurrentTenant, db: DbSession,
    settings: AppSettings, request: Request,
) -> ChannelOut:
    svc = await _manager(ctx, db, settings, request)
    return channel_out(await svc.update_channel(channel_id, body))


@router.delete("/notification-channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(
    channel_id: uuid.UUID, ctx: CurrentTenant, db: DbSession, settings: AppSettings,
    request: Request,
) -> None:
    await (await _manager(ctx, db, settings, request)).delete_channel(channel_id)


@router.post("/notification-channels/{channel_id}/test", status_code=status.HTTP_202_ACCEPTED)
async def test_channel(
    channel_id: uuid.UUID, ctx: CurrentTenant, db: DbSession, settings: AppSettings,
    request: Request, response: Response,
) -> TestAccepted:
    svc = await _manager(ctx, db, settings, request)
    job = await svc.test_channel(channel_id, ctx.principal.user_id)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/jobs/{job.id}"
    return TestAccepted(job=await job_out(db, job))


# --- platform ----------------------------------------------------------------------------


async def _summary(db: AsyncSession, *conditions: ColumnElement[bool]) -> AlertSummary:
    firing, critical = (
        await db.execute(
            select(func.count(), func.count().filter(Alert.severity == "critical"))
            .where(*conditions, Alert.state == "firing")
        )
    ).one()
    return AlertSummary(firing=firing, critical=critical)


def _admin_scope(tenant_id: uuid.UUID | None) -> list[ColumnElement[bool]]:
    return [Alert.tenant_id == tenant_id] if tenant_id else []


@admin_router.get("/alerts")
async def admin_list_alerts(
    _: AlertViewer, db: DbSession, state: State = "active", limit: Limit = 50,
    tenant_id: uuid.UUID | None = None,
) -> list[AdminAlertOut]:
    rows = (
        await db.execute(
            select(Alert, Tenant.name).outerjoin(Tenant, Tenant.id == Alert.tenant_id)
            .where(*_admin_scope(tenant_id), _state(state)).order_by(_order(state)).limit(limit)
        )
    ).all()
    return [
        AdminAlertOut(**alert_out(a).model_dump(), tenant_id=a.tenant_id, tenant_name=name)
        for a, name in rows
    ]


@admin_router.get("/alerts/summary")
async def admin_alerts_summary(
    _: AlertViewer, db: DbSession, tenant_id: uuid.UUID | None = None
) -> AlertSummary:
    return await _summary(db, *_admin_scope(tenant_id))


def _platform(db: AsyncSession, settings: Settings, request: Request) -> AlertConfig:
    return AlertConfig(db, None, settings, _secrets(request))


@admin_router.get("/alert-rules")
async def admin_list_rules(
    _: AlertAdmin, db: DbSession, settings: AppSettings, request: Request
) -> list[AlertRuleOut]:
    return [AlertRuleOut.model_validate(r) for r in await _platform(db, settings, request).rules()]


@admin_router.post("/alert-rules", status_code=status.HTTP_201_CREATED)
async def admin_create_rule(
    body: AlertRuleCreate, _: AlertAdmin, db: DbSession, settings: AppSettings, request: Request
) -> AlertRuleOut:
    return AlertRuleOut.model_validate(await _platform(db, settings, request).create_rule(body))


@admin_router.patch("/alert-rules/{rule_id}")
async def admin_update_rule(
    rule_id: uuid.UUID, body: AlertRuleUpdate, _: AlertAdmin, db: DbSession,
    settings: AppSettings, request: Request,
) -> AlertRuleOut:
    rule = await _platform(db, settings, request).update_rule(rule_id, body)
    return AlertRuleOut.model_validate(rule)


@admin_router.delete("/alert-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_rule(
    rule_id: uuid.UUID, _: AlertAdmin, db: DbSession, settings: AppSettings, request: Request
) -> None:
    await _platform(db, settings, request).delete_rule(rule_id)


@admin_router.get("/notification-channels")
async def admin_list_channels(
    _: AlertAdmin, db: DbSession, settings: AppSettings, request: Request
) -> list[ChannelOut]:
    return [channel_out(c) for c in await _platform(db, settings, request).channels()]


@admin_router.post("/notification-channels", status_code=status.HTTP_201_CREATED)
async def admin_create_channel(
    body: ChannelCreate, _: AlertAdmin, db: DbSession, settings: AppSettings, request: Request
) -> ChannelCreated:
    return await _platform(db, settings, request).create_channel(body)


@admin_router.patch("/notification-channels/{channel_id}")
async def admin_update_channel(
    channel_id: uuid.UUID, body: ChannelUpdate, _: AlertAdmin, db: DbSession,
    settings: AppSettings, request: Request,
) -> ChannelOut:
    return channel_out(await _platform(db, settings, request).update_channel(channel_id, body))


@admin_router.delete("/notification-channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_channel(
    channel_id: uuid.UUID, _: AlertAdmin, db: DbSession, settings: AppSettings, request: Request
) -> None:
    await _platform(db, settings, request).delete_channel(channel_id)


@admin_router.post(
    "/notification-channels/{channel_id}/test", status_code=status.HTTP_202_ACCEPTED
)
async def admin_test_channel(
    channel_id: uuid.UUID, principal: AlertAdmin, db: DbSession, settings: AppSettings,
    request: Request, response: Response,
) -> TestAccepted:
    job = await _platform(db, settings, request).test_channel(channel_id, principal.user_id)
    await db.refresh(job)
    response.headers["Location"] = f"/api/v1/admin/jobs/{job.id}"
    return TestAccepted(job=await job_out(db, job))

