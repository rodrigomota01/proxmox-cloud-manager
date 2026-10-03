"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AddHypervisorDialog } from "@/components/admin/connection";
import { ClusterStatus } from "@/components/cluster-status";

import { Badge, Button, Card, Empty, ErrorBox, Select, formatBytes } from "@/components/ui";
import { Allocation, Meter, SortHeader, mib, ratioLabel, uptime, useSorted } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";

type Node = Schemas["NodeOut"];
type SortKey = "name" | "cpu" | "memory" | "vcpu" | "ram" | "vms";

const memRatio = (n: Node) => (n.memory_bytes ? n.memory_used_bytes / n.memory_bytes : 0);
const vcpuRatio = (n: Node) => (n.cpu_count ? n.vcpus_allocated / n.cpu_count : 0);
const ramRatio = (n: Node) => (n.memory_bytes ? (n.memory_allocated_mb * 1024 ** 2) / n.memory_bytes : 0);

function StatusBadge({ status }: { status: string }) {
  const tone = status === "online" ? "green" : status === "offline" ? "red" : "amber";
  const label = status === "online" ? "Online" : status === "offline" ? "Offline" : "Desconhecido";
  return <Badge tone={tone}>{label}</Badge>;
}

function Totals({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter((n) => n.status === "online");
  const cores = online.reduce((a, n) => a + n.cpu_count, 0);
  const vcpus = online.reduce((a, n) => a + n.vcpus_allocated, 0);
  const mem = online.reduce((a, n) => a + n.memory_bytes, 0);
  const memUsed = online.reduce((a, n) => a + n.memory_used_bytes, 0);
  const cpuWeighted = cores ? online.reduce((a, n) => a + n.cpu_usage * n.cpu_count, 0) / cores : 0;
  const tiles = [
    { label: "Hypervisors online", value: `${online.length} de ${nodes.length}` },
    { label: "CPU em uso", value: `${Math.round(cpuWeighted * 100)}%` },
    { label: "Memória em uso", value: `${formatBytes(memUsed)} de ${formatBytes(mem)}` },
    { label: "vCPUs configuradas / núcleos", value: `${vcpus} / ${cores}${cores ? ` · ${ratioLabel(vcpus / cores)}` : ""}` },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
          <div className="mt-1 text-xl font-semibold">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Connections with no node yet: just added, waiting for the first sync, or a bad token. */
function PendingConnections({ nodes }: { nodes: Node[] }) {
  const clusters = useQuery({
    queryKey: ["admin", "clusters"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/clusters")),
    refetchInterval: 15_000,
  });
  const pending = (clusters.data ?? []).filter((c) => !nodes.some((n) => n.cluster_id === c.id));
  if (pending.length === 0) return null;
  return (
    <Card title="Aguardando sincronização">
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {pending.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span>
              <Link href={`/admin/clusters/${c.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                {c.name}
              </Link>{" "}
              <span className="text-xs text-slate-500">{c.api_url}</span>
              {c.last_error && <div className="text-xs text-rose-600 dark:text-rose-400">{c.last_error}</div>}
            </span>
            <span className="flex items-center gap-2">
              {!c.has_credentials && <Badge tone="amber">sem token</Badge>}
              <ClusterStatus status={c.status} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function NodesPage() {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const nodes = useQuery({
    queryKey: ["admin", "nodes"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/nodes")),
    refetchInterval: 15_000,
  });
  const storage = useQuery({
    queryKey: ["admin", "storage"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/storage")),
    refetchInterval: 60_000,
  });
  const [region, setRegion] = useState("");
  const regionNames = [...new Set((nodes.data ?? []).map((n) => n.region_name ?? "Sem região"))].sort();
  const visible = (nodes.data ?? []).filter((n) => !region || (n.region_name ?? "Sem região") === region);
  const { sorted, sort, toggle } = useSorted<Node, SortKey>(
    visible,
    {
      name: (n) => n.name,
      cpu: (n) => n.cpu_usage,
      memory: memRatio,
      vcpu: vcpuRatio,
      ram: ramRatio,
      vms: (n) => n.instances_running,
    },
    { key: "cpu", desc: true },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Hypervisors</h1>
        <div className="flex items-center gap-2">
          <Select aria-label="Região" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">Todas as regiões</option>
            {regionNames.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Button onClick={() => setAdding(true)}>Adicionar hypervisor</Button>
        </div>
      </div>
      <AddHypervisorDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => setAdding(false)}
      />
      <ErrorBox message={nodes.isError ? errorMessage(nodes.error) : null} />
      {nodes.data && <Totals nodes={visible} />}
      {nodes.data && <PendingConnections nodes={nodes.data} />}

      <Card title="Nodes">
        {nodes.data?.length === 0 && <Empty>Nenhum node sincronizado ainda.</Empty>}
        {!!nodes.data?.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <SortHeader label="Node" k="name" sort={sort} toggle={toggle} />
                  <th className="py-2 pr-4 font-medium uppercase tracking-wide">Status</th>
                  <SortHeader label="CPU em uso" k="cpu" sort={sort} toggle={toggle} />
                  <SortHeader label="Memória em uso" k="memory" sort={sort} toggle={toggle} />
                  <SortHeader label="vCPUs configuradas" k="vcpu" sort={sort} toggle={toggle} />
                  <SortHeader label="RAM configurada" k="ram" sort={sort} toggle={toggle} />
                  <SortHeader label="VMs" k="vms" sort={sort} toggle={toggle} align="right" />
                  <th className="py-2 text-right font-medium uppercase tracking-wide">Ligado há</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sorted.map((n) => {
                  const online = n.status === "online";
                  // standalone server = one-node connection: show the admin's label first
                  const multi = (nodes.data ?? []).filter((x) => x.cluster_id === n.cluster_id).length > 1;
                  return (
                    <tr key={n.id}>
                      <td className="py-2.5 pr-4">
                        <Link href={`/admin/nodes/${n.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                          {multi ? n.name : n.cluster_name}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {n.region_name ? `${n.region_name} · ${n.zone_name}` : "sem zona"} ·{" "}
                          {multi ? `cluster ${n.cluster_name}` : n.name} · {n.cpu_count} núcleos · {formatBytes(n.memory_bytes)}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <StatusBadge status={n.status} />
                      </td>
                      <td className="py-2.5 pr-4">{online ? <Meter value={n.cpu_usage} title={`CPU de ${n.name}`} /> : "—"}</td>
                      <td className="py-2.5 pr-4">
                        {online ? (
                          <Meter
                            value={memRatio(n)}
                            label={`${formatBytes(n.memory_used_bytes)} / ${formatBytes(n.memory_bytes)}`}
                            title={`Memória de ${n.name}`}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Allocation
                          ratio={vcpuRatio(n)}
                          label={`${n.vcpus_allocated} / ${n.cpu_count}`}
                          title="vCPUs configuradas nas VMs sobre os núcleos físicos. Não é consumo: acima de 1× é normal em CPU."
                        />
                      </td>
                      <td className="py-2.5 pr-4">
                        <Allocation
                          ratio={ramRatio(n)}
                          label={`${mib(n.memory_allocated_mb)} / ${formatBytes(n.memory_bytes)}`}
                          title="RAM configurada nas VMs sobre a RAM física. Acima de 1× há risco de falta de memória se todas usarem o máximo."
                          warnAbove={1}
                        />
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {n.instances_running}
                        <span className="text-slate-500"> / {n.instances_total}</span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                        {online ? uptime(n.uptime_seconds) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          “Em uso” é o consumo real medido pelo Proxmox. “Configuradas” é o que as VMs receberam
          (não é consumo): acima de 1× é sobrecomprometimento, comum em CPU e arriscado em memória (⚠).
        </p>
      </Card>

      <Card title="Storage">
        {storage.data?.length === 0 && (
          <Empty>Nenhum storage visível ao token (precisa de Datastore.Audit no storage).</Empty>
        )}
        {!!storage.data?.length && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Storage</th>
                <th className="py-2 pr-4 font-medium">Node</th>
                <th className="py-2 pr-4 font-medium">Tipo</th>
                <th className="py-2 font-medium">Uso</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {storage.data.map((s) => (
                <tr key={s.id}>
                  <td className="py-2.5 pr-4 font-medium">
                    {s.name}
                    {!s.active && <span className="ml-2"><Badge tone="red">inativo</Badge></span>}
                  </td>
                  <td className="py-2.5 pr-4">{s.node}</td>
                  <td className="py-2.5 pr-4">
                    {s.type}
                    {s.shared && <span className="ml-1 text-xs text-slate-500">(compartilhado)</span>}
                  </td>
                  <td className="py-2.5">
                    <Meter
                      value={s.total_bytes ? s.used_bytes / s.total_bytes : 0}
                      label={`${formatBytes(s.used_bytes)} / ${formatBytes(s.total_bytes)}`}
                      title={`Uso de ${s.name}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
