import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.compute.schemas import IPv4Config

ExpiryStatus = Literal["expired", "critical", "warning", "ok", "unknown"]
Health = Literal["healthy", "warning", "critical", "unreachable"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
# becomes part of VM and node names: a DNS label with room for "-<pool>-<n>"
ClusterName = Annotated[str, StringConstraints(pattern=r"^[a-z]([a-z0-9-]{1,28}[a-z0-9])$")]
PoolName = Annotated[str, StringConstraints(pattern=r"^[a-z]([a-z0-9-]{0,14}[a-z0-9])?$")]
State = Literal["provisioning", "active", "updating", "error", "deleting"]


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
    source: Literal["table", "manual", "managed"]
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
    managed: "K8sManagedOut | None" = None  # source='managed' only (ADR-0018)


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
    # absent from snapshots taken before the logs screen
    workload: str | None = None
    containers: list[str] = []


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


# --- clusters created by the platform (ADR-0018) ------------------------------------------


class K8sNodeSize(Input):
    vcpus: Annotated[int, Field(ge=1, le=32)]
    memory_mb: Annotated[int, Field(ge=1024, le=262_144, multiple_of=256)]
    disk_gb: Annotated[int, Field(ge=10, le=2048)]


class K8sWorkerPool(K8sNodeSize):
    name: PoolName
    count: Annotated[int, Field(ge=1, le=20)]


class K8sIpamNetwork(Input):
    """Addresses from the IPAM (GET /zones/{id}/addresses): one per node, in pool order
    (control plane first), plus the load balancer's. All in the same network."""

    mode: Literal["ipam"]
    node_address_ids: Annotated[list[uuid.UUID], Field(min_length=2, max_length=41)]
    lb_address_id: uuid.UUID
    dns: Annotated[list[str], Field(max_length=3)] = []


class K8sStaticNetwork(Input):
    """Addresses typed by hand: the nodes' (prefix and gateway from `node_ipv4`, same
    subnet) and the load balancer's. `bridge`/`vlan`: platform admins only."""

    mode: Literal["static"]
    node_ipv4: Annotated[list[IPv4Config], Field(min_length=2, max_length=41)]
    lb_ip: str
    bridge: Annotated[str | None, Field(max_length=32)] = None
    vlan: Annotated[int | None, Field(ge=1, le=4094)] = None


class K8sProvision(Input):
    name: ClusterName
    project_id: uuid.UUID
    zone_id: uuid.UUID
    image_id: uuid.UUID  # a Kubernetes image (GET /kubernetes/images): fixes the version
    control_plane: K8sNodeSize
    workers: Annotated[list[K8sWorkerPool], Field(min_length=1, max_length=5)]
    network: Annotated[K8sIpamNetwork | K8sStaticNetwork, Field(discriminator="mode")]
    ssh_key_ids: Annotated[list[uuid.UUID], Field(max_length=10)] = []

    @model_validator(mode="after")
    def _shape(self) -> "K8sProvision":
        if self.control_plane.vcpus < 2 or self.control_plane.memory_mb < 2048:
            raise ValueError("the control plane needs at least 2 vCPUs and 2048 MB (kubeadm)")
        names = [p.name for p in self.workers]
        if len(set(names)) != len(names) or "cp" in names:
            raise ValueError("worker pool names must be unique and not 'cp'")
        nodes = 1 + sum(p.count for p in self.workers)
        given = (len(self.network.node_address_ids) if isinstance(self.network, K8sIpamNetwork)
                 else len(self.network.node_ipv4))
        if given != nodes:
            raise ValueError(f"{nodes} nodes need {nodes} node addresses, got {given}")
        return self


class K8sAdminProvision(K8sProvision):
    tenant_id: uuid.UUID


class K8sClusterDelete(Input):
    confirm: str  # must equal the cluster name


class K8sPoolOut(BaseModel):
    id: uuid.UUID
    name: str
    role: Literal["control-plane", "worker"]
    count: int
    vcpus: int
    memory_mb: int
    disk_gb: int


class K8sManagedOut(BaseModel):
    state: State
    state_message: str | None  # current step while provisioning, the error when failed
    project_id: uuid.UUID
    kubernetes_version: str
    api_endpoint: str | None
    lb_ip: str | None  # the shared Gateway's public address
    components: dict[str, str]  # name -> version
    pools: list[K8sPoolOut]
    created_at: datetime


class K8sImageOut(BaseModel):
    id: uuid.UUID
    name: str
    kubernetes_version: str
    min_disk_gb: int
    zone_ids: list[uuid.UUID]


class K8sLogPodOut(BaseModel):
    name: str
    status: str | None  # phase
    restarts: int
    containers: list[str]
    container: str | None  # the one read; None when the request named one it lacks
    lines: int
    partial: bool  # stopped at the size limit: the oldest lines of the tail are missing
    error: str | None  # the cluster's refusal, e.g. "container ... is waiting to start"


class K8sLogLineOut(BaseModel):
    ts: str | None
    pod: str
    text: str


class K8sLogsOut(BaseModel):
    namespace: str
    workload: str | None
    pods: list[K8sLogPodOut]
    pods_truncated: bool  # the workload has more pods than are read at once
    lines: list[K8sLogLineOut]  # every pod, in time order, the latest `tail_lines`
    fetched_at: datetime


K8sClusterOut.model_rebuild()
K8sClusterDetail.model_rebuild()
