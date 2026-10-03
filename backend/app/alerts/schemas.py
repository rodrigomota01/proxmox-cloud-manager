import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.alerts.models import RATIO_METRICS, TARGET_METRICS
from app.auth.schemas import Email
from app.compute.schemas import JobOut

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Target = Literal["node", "storage", "instance"]
Metric = Literal["cpu", "memory", "disk", "net_in", "net_out"]
Severity = Literal["warning", "critical"]
Duration = Annotated[int, Field(ge=0, le=7 * 86_400)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


def check_threshold(metric: str, threshold: float) -> None:
    if metric in RATIO_METRICS and threshold >= 1:
        raise ValueError("cpu/memory/disk thresholds are fractions: 0.9 = 90%")


class AlertRuleCreate(Input):
    """threshold: cpu/memory/disk as a fraction (0.9 = 90%); network in bytes/s."""

    name: Name
    target: Target = "instance"
    metric: Metric
    threshold: Annotated[float, Field(gt=0)]
    duration_seconds: Duration = 300
    severity: Severity = "warning"
    enabled: bool = True

    @model_validator(mode="after")
    def _consistent(self) -> "AlertRuleCreate":
        if self.metric not in TARGET_METRICS[self.target]:
            raise ValueError(f"{self.target} has no {self.metric} metric")
        check_threshold(self.metric, self.threshold)
        return self


class AlertRuleUpdate(Input):
    name: Name | None = None
    threshold: Annotated[float, Field(gt=0)] | None = None
    duration_seconds: Duration | None = None
    severity: Severity | None = None
    enabled: bool | None = None


class AlertRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    target: str
    metric: str
    threshold: float
    duration_seconds: int
    severity: str
    enabled: bool


Url = Annotated[str, StringConstraints(strip_whitespace=True, min_length=8, max_length=2000)]


class ChannelCreate(Input):
    name: Name
    type: Literal["email", "webhook"]
    to: Annotated[list[Email], Field(max_length=10)] = []  # e-mail
    url: Url | None = None  # webhook
    min_severity: Severity = "warning"
    enabled: bool = True

    @model_validator(mode="after")
    def _by_type(self) -> "ChannelCreate":
        if self.type == "email" and (not self.to or self.url):
            raise ValueError("an e-mail channel needs `to` (and no url)")
        if self.type == "webhook" and (not self.url or self.to):
            raise ValueError("a webhook channel needs `url` (and no `to`)")
        return self


class ChannelUpdate(Input):
    name: Name | None = None
    to: Annotated[list[Email], Field(min_length=1, max_length=10)] | None = None
    url: Url | None = None
    min_severity: Severity | None = None
    enabled: bool | None = None


class ChannelOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    to: list[str]
    url: str | None
    min_severity: str
    enabled: bool
    signed: bool  # webhook requests carry X-CM-Signature
    created_at: datetime


class ChannelCreated(ChannelOut):
    # HMAC key for X-CM-Signature; returned only here, never again
    signing_secret: str | None


class AlertOut(BaseModel):
    id: uuid.UUID
    rule_name: str
    severity: str
    state: str  # firing|resolved
    resource_type: str
    resource_id: uuid.UUID
    resource_name: str
    project_id: uuid.UUID | None
    metric: str
    value: float
    peak: float
    threshold: float
    started_at: datetime
    fired_at: datetime | None
    resolved_at: datetime | None


class AdminAlertOut(AlertOut):
    tenant_id: uuid.UUID | None
    tenant_name: str | None


class AlertSummary(BaseModel):
    firing: int
    critical: int


class TestAccepted(BaseModel):
    job: JobOut
