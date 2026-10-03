"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import { ConnectionInstances, ConnectionSettings } from "@/components/admin/connection";
import { NodeMetrics } from "@/components/metrics-panel";
import { Card, ErrorBox, formatBytes } from "@/components/ui";
import { Allocation, Meter, mib, uptime } from "@/components/viz";
import { api, errorMessage, unwrap } from "@/lib/api/client";

const TABS = [
  { key: "overview", label: "Visão geral" },
  { key: "vms", label: "VMs" },
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
    ["Status", online ? "Online" : n.status],
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

  return (
    <div className="space-y-4">
      <Link href="/admin/nodes" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Hypervisors
      </Link>
      <div>
        <h1 className="text-lg font-semibold">{multi ? n.name : n.cluster_name}</h1>
        {!multi && n.name !== n.cluster_name && (
          <p className="text-sm text-slate-500">Nome no Proxmox: {n.name}</p>
        )}
      </div>
      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label="Seções">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => router.replace(t.key === "overview" ? `/admin/nodes/${id}` : `/admin/nodes/${id}?tab=${t.key}`)}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? "border-indigo-600 font-medium text-indigo-700 dark:text-indigo-300"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "vms" && <ConnectionInstances clusterId={n.cluster_id} nodeName={n.name} />}
      {tab === "config" && cluster.data && <ConnectionSettings cluster={cluster.data} nodeCount={siblings} />}
      {tab === "overview" && (
        <>
          <Card title="Agora">
            <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {rows.map(([label, value]) => (
                <div key={label} className="grid grid-cols-3 items-center gap-4 text-sm">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="col-span-2">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>
          {online && <NodeMetrics nodeId={n.id} />}
        </>
      )}
    </div>
  );
}
