"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";

import { NodeMetrics } from "@/components/metrics-panel";
import { Card, ErrorBox, formatBytes } from "@/components/ui";
import { Allocation, Meter, mib, uptime } from "@/components/viz";
import { api, errorMessage, unwrap } from "@/lib/api/client";

export default function NodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const node = useQuery({
    queryKey: ["admin", "node", id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/nodes/{node_id}", { params: { path: { node_id: id } } })),
    refetchInterval: 15_000,
  });
  if (node.isError) return <ErrorBox message={errorMessage(node.error)} />;
  const n = node.data;
  if (!n) return null;
  const online = n.status === "online";

  const rows: [string, React.ReactNode][] = [
    ["Cluster", n.cluster_name],
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
      <h1 className="text-lg font-semibold">{n.name}</h1>
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
    </div>
  );
}
