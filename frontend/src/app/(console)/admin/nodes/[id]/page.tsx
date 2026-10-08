"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import { ConnectionInstances, ConnectionSettings } from "@/components/admin/connection";
import { IpamPanel } from "@/components/admin/ipam-panel";
import { NodeMetrics } from "@/components/metrics-panel";
import { DescriptionList, PageHeader } from "@/components/page";
import { Card, ErrorBox, Status, formatBytes } from "@/components/ui";
import { Allocation, Meter, mib, uptime } from "@/components/viz";
import { api, errorMessage, unwrap } from "@/lib/api/client";

const TABS = [
  { key: "overview", label: "Visão geral" },
  { key: "vms", label: "VMs" },
  { key: "ips", label: "IPs" },
  { key: "config", label: "Configuração" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function NodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.some((t) => t.key === params.get("tab")) ? (params.get("tab") as Tab) : "overview";
  const nodes = useQuery({
    queryKey: ["admin", "nodes"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/nodes")),
    refetchInterval: 15_000,
  });
  const node = useQuery({
    queryKey: ["admin", "node", id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/nodes/{node_id}", { params: { path: { node_id: id } } })),
    refetchInterval: 15_000,
  });
  const n = node.data;
  const cluster = useQuery({
    queryKey: ["admin", "cluster", n?.cluster_id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/clusters/{cluster_id}", { params: { path: { cluster_id: n!.cluster_id } } })),
    enabled: !!n,
    refetchInterval: 15_000,
  });
  if (node.isError) return <ErrorBox message={errorMessage(node.error)} />;
  if (!n) return null;
  const online = n.status === "online";
  // a standalone server is a one-node connection: the admin's label is its name
  const siblings = (nodes.data ?? []).filter((x) => x.cluster_id === n.cluster_id).length;
  const multi = siblings > 1;

  const rows: [string, React.ReactNode][] = [
    ...(multi ? ([["Cluster", n.cluster_name]] as [string, React.ReactNode][]) : []),
    ["Zona", n.region_name ? `${n.region_name} · ${n.zone_name}` : "sem zona"],
    ["Nome no Proxmox", n.name],
    ["Ligado há", online ? uptime(n.uptime_seconds) : "—"],
    ["CPU em uso", online ? <Meter value={n.cpu_usage} title="CPU" /> : "—"],
    [
      "Memória em uso",
      online ? (
        <Meter
          value={n.memory_bytes ? n.memory_used_bytes / n.memory_bytes : 0}
          label={`${formatBytes(n.memory_used_bytes)} / ${formatBytes(n.memory_bytes)}`}
          title="Memória"
        />
      ) : (
        "—"
      ),
    ],
    [
      "vCPUs configuradas",
      <Allocation
        key="v"
        ratio={n.cpu_count ? n.vcpus_allocated / n.cpu_count : 0}
        label={`${n.vcpus_allocated} / ${n.cpu_count} núcleos`}
        title="vCPUs configuradas nas VMs sobre os núcleos físicos. Não é consumo: acima de 1× é normal em CPU."
      />,
    ],
    [
      "RAM configurada",
      <Allocation
        key="r"
        ratio={n.memory_bytes ? (n.memory_allocated_mb * 1024 ** 2) / n.memory_bytes : 0}
        label={`${mib(n.memory_allocated_mb)} / ${formatBytes(n.memory_bytes)}`}
        title="RAM configurada nas VMs sobre a RAM física. Acima de 1× há risco se todas usarem o máximo."
        warnAbove={1}
      />,
    ],
    ["VMs ligadas", `${n.instances_running} de ${n.instances_total}`],
  ];

  const title = multi ? n.name : n.cluster_name;
  const status =
    n.status === "online" ? (
      <Status tone="ok">Online</Status>
    ) : n.status === "offline" ? (
      <Status tone="error">Offline</Status>
    ) : (
      <Status tone="unknown">Desconhecido</Status>
    );

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        kind="hypervisor"
        status={status}
        breadcrumbs={[{ label: "Infraestrutura" }, { label: "Hypervisors", href: "/admin/nodes" }, { label: title }]}
        tabs={TABS}
        activeTab={tab}
        onTab={(t) => router.replace(t === "overview" ? `/admin/nodes/${id}` : `/admin/nodes/${id}?tab=${t}`)}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {n.region_name ? `${n.region_name} · ${n.zone_name}` : "sem zona"}
          {multi && ` · cluster ${n.cluster_name}`}
          {!multi && n.name !== n.cluster_name && ` · nome no Proxmox: ${n.name}`}
          {cluster.data?.version && ` · Proxmox ${cluster.data.version}`}
        </p>
      </PageHeader>
      {tab === "vms" && <ConnectionInstances clusterId={n.cluster_id} nodeName={n.name} />}
      {tab === "ips" && <IpamPanel clusterId={n.cluster_id} />}
      {tab === "config" && cluster.data && <ConnectionSettings cluster={cluster.data} nodeCount={siblings} />}
      {tab === "overview" && (
        <>
          <Card title="Detalhes">
            <DescriptionList columns={3} items={rows} />
          </Card>
          {online && <NodeMetrics nodeId={n.id} />}
        </>
      )}
    </div>
  );
}
