import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ExpiryStatus = Literal["expired", "critical", "warning", "ok", "unknown"]
Health = Literal["healthy", "warning", "critical", "unreachable"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class K8sClusterCreate(Input):
    name: Name
    # kubeconfig as YAML or base64 (as stored in the legacy table); write-only
    kubeconfig: Annotated[str, Field(min_length=20, max_length=262_144)]


class K8sKubeconfigPut(Input):
    kubeconfig: Annotated[str, Field(min_length=20, max_length=262_144)]


class K8sClusterTenantPut(Input):
    tenant_id: uuid.UUID | None  # null unlinks


class K8sTableNodeOut(BaseModel):
    id: int  # kubernetes_clusters.id
    host: int | None
    role: str | None


class K8sSummaryOut(BaseModel):
    """Last collection. Usage fields are null without metrics-server."""

    health: Health
    reasons: list[str]
    error: str | None
    version: str | None
    collected_at: datetime
    ok_at: datetime | None  # last successful read (data age when unreachable)
    nodes: int
    nodes_ready: int
    namespaces: int
    pods: int
    pods_running: int
    pods_problem: int
    workloads: int
    workloads_unready: int
    services: int
    ingresses: int
    httproutes: int
    gateway_api: bool  # Gateway API installed (HTTPRoute available)
    metrics: bool
    cpu_capacity: float  # cores
    cpu_allocatable: float
    cpu_requests: float
    cpu_usage: float | None
    mem_capacity: float  # bytes
    mem_allocatable: float
    mem_requests: float
    mem_usage: float | None


class K8sClusterOut(BaseModel):
    id: uuid.UUID
    name: str
    source: Literal["table", "manual"]
    api_server: str | None
    server_url: str | None
    certs_expire_on: date | None  # as recorded in the table
    cert_expires_at: datetime | None  # read from the kubeconfig's client certificate
    expires_on: date | None  # the earliest of the two
    days_left: int | None
    status: ExpiryStatus
    dates_differ: bool
    nodes: list[K8sTableNodeOut]
    has_kubeconfig: bool
    kubeconfig_error: str | None
    source_modified_at: datetime | None
    synced_at: datetime
    tenant_id: uuid.UUID | None = None
    tenant_name: str | None = None
    snapshot: K8sSummaryOut | None  # None: not collected yet


class K8sNodeOut(BaseModel):
    name: str
    ready: bool
    unschedulable: bool
    roles: list[str]
    version: str | None
    os: str | None
    ip: str | None
    pressure: list[str]
    cpu_capacity: float
    cpu_allocatable: float
    cpu_requests: float
    cpu_usage: float | None
    mem_capacity: float
    mem_allocatable: float
    mem_requests: float
    mem_usage: float | None
    pods: int
    pods_capacity: int
    created_at: str | None


class K8sNamespaceOut(BaseModel):
    name: str
    phase: str | None
    created_at: str | None
    pods: int
    running: int
    problems: int
    workloads: int
    services: int
    ingresses: int
    httproutes: int
    cpu_usage: float | None
    mem_usage: float | None
    cpu_requests: float
    mem_requests: float


class K8sWorkloadOut(BaseModel):
    kind: str
    namespace: str
    name: str | None
    desired: int
    ready: int
    images: list[str | None]
    created_at: str | None


class K8sPodOut(BaseModel):
    namespace: str
    name: str
    node: str | None
    status: str
    problem: bool
    ready: str
    restarts: int
    owner: str | None
    ip: str | None
    started_at: str | None
    cpu_usage: float | None
    mem_usage: float | None


class K8sServiceOut(BaseModel):
    namespace: str
    name: str | None
    type: str | None
    cluster_ip: str | None
    external: list[str]
    ports: list[str]


class K8sIngressRuleOut(BaseModel):
    host: str | None
    path: str
    service: str
    tls: bool


class K8sIngressOut(BaseModel):
    namespace: str
    name: str | None
    ingress_class: str | None
    rules: list[K8sIngressRuleOut]
    address: list[str | None]


class K8sHttpRouteRuleOut(BaseModel):
    path: str
    backends: str  # "svc:port (weight), ..."


class K8sHttpRouteOut(BaseModel):
    """Gateway API route. Address and TLS come from the Gateway listeners it attaches to."""

    namespace: str
    name: str | None
    hostnames: list[str]
    parents: list[str]  # "namespace/gateway[:listener]"
    rules: list[K8sHttpRouteRuleOut]
    address: list[str]
    tls: bool
    problem: str | None  # e.g. "Accepted: NotAllowedByListeners"


class K8sClusterDetail(K8sClusterOut):
    k8s_nodes: list[K8sNodeOut]
    namespaces: list[K8sNamespaceOut]
    workloads: list[K8sWorkloadOut]
    pods: list[K8sPodOut]
    pods_truncated: bool
    services: list[K8sServiceOut]
    ingresses: list[K8sIngressOut]
    httproutes: list[K8sHttpRouteOut]
