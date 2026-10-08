"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { AddHypervisorDialog } from "@/components/admin/connection";
import { ClusterStatus } from "@/components/cluster-status";
import { Icon } from "@/components/icons";
import { PageHeader, ResourceIcon, SearchInput, StatTile, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Select, Status, formatBytes, tbl } from "@/components/ui";
import { Allocation, Meter, SortHeader, mib, ratioLabel, uptime, useSorted } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";

type Node = Schemas["NodeOut"];
type SortKey = "name" | "cpu" | "memory" | "vcpu" | "ram" | "vms";

const memRatio = (n: Node) => (n.memory_bytes ? n.memory_used_bytes / n.memory_bytes : 0);
const vcpuRatio = (n: Node) => (n.cpu_count ? n.vcpus_allocated / n.cpu_count : 0);
const ramRatio = (n: Node) => (n.memory_bytes ? (n.memory_allocated_mb * 1024 ** 2) / n.memory_bytes : 0);

function NodeStatus({ status }: { status: string }) {
  if (status === "online") return <Status tone="ok">Online</Status>;
  if (status === "offline") return <Status tone="error">Offline</Status>;
  return <Status tone="unknown">Desconhecido</Status>;
}

const TABS = [
  { key: "nodes", label: "Nodes" },
  { key: "storage", label: "Storage" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function Totals({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter((n) => n.status === "online");
  const cores = online.reduce((a, n) => a + n.cpu_count, 0);
  const vcpus = online.reduce((a, n) => a + n.vcpus_allocated, 0);
  const mem = online.reduce((a, n) => a + n.memory_bytes, 0);
  const memUsed = online.reduce((a, n) => a + n.memory_used_bytes, 0);
  const cpuWeighted = cores ? online.reduce((a, n) => a + n.cpu_usage * n.cpu_count, 0) / cores : 0;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        icon="server"
        label="Hypervisors online"
        value={`${online.length} de ${nodes.length}`}
        tone={online.length < nodes.length ? "warn" : "ok"}
        hint={online.length < nodes.length ? `${nodes.length - online.length} fora do ar` : "todos online"}
      />
      <StatTile icon="dashboard" label="CPU em uso" value={`${Math.round(cpuWeighted * 100)}%`} hint={`${cores} núcleos físicos`} />
      <StatTile
        icon="layers"
        label="Memória em uso"
        value={mem ? `${Math.round((memUsed / mem) * 100)}%` : "—"}
        hint={`${formatBytes(memUsed)} de ${formatBytes(mem)}`}
      />
      <StatTile
        icon="monitor"
        label="vCPUs configuradas / núcleos"
        value={`${vcpus} / ${cores}`}
        hint={cores ? `sobrecomprometimento ${ratioLabel(vcpus / cores)}` : undefined}
      />
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
    <Alert variant="warning" title={`${pending.length} conexão(ões) aguardando sincronização`}>
      <ul className="mt-1 space-y-1.5">
        {pending.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link href={`/admin/clusters/${c.id}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">
              {c.name}
            </Link>
            <span className="font-mono text-xs opacity-75">{c.api_url}</span>
            <ClusterStatus status={c.status} />
            {!c.has_credentials && <Badge tone="amber">sem token</Badge>}
            {c.last_error && <span className="w-full text-xs text-rose-700 dark:text-rose-300">{c.last_error}</span>}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

export default function NodesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = params.get("tab") === "storage" ? "storage" : "nodes";
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
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
  const needle = q.trim().toLowerCase();
  const visible = (nodes.data ?? []).filter(
    (n) =>
      (!region || (n.region_name ?? "Sem região") === region) &&
      (!needle || n.name.toLowerCase().includes(needle) || n.cluster_name.toLowerCase().includes(needle)),
  );
  const storageRows = (storage.data ?? []).filter(
    (s) => !needle || s.name.toLowerCase().includes(needle) || s.node.toLowerCase().includes(needle),
  );
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

  const regionSelect = (
    <Select aria-label="Região" value={region} onChange={(e) => setRegion(e.target.value)}>
      <option value="">Todas as regiões</option>
      {regionNames.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </Select>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Hypervisors"
        breadcrumbs={[{ label: "Infraestrutura" }, { label: "Hypervisors" }]}
        description="Servidores Proxmox integrados: consumo real, alocação das VMs e storage."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" /> Adicionar hypervisor
          </Button>
        }
        tabs={TABS.map((t) => ({
          ...t,
          count: t.key === "nodes" ? nodes.data?.length : storage.data?.length,
        }))}
        activeTab={tab}
        onTab={(t) => router.replace(t === "nodes" ? "/admin/nodes" : `/admin/nodes?tab=${t}`)}
      />
      <AddHypervisorDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => setAdding(false)}
      />
      <ErrorBox message={nodes.isError ? errorMessage(nodes.error) : null} />
      {nodes.data && <PendingConnections nodes={nodes.data} />}
      {nodes.data && tab === "nodes" && <Totals nodes={visible} />}

      {tab === "nodes" && (
        <Card flush>
          <Toolbar count={nodes.data ? `${visible.length} de ${nodes.data.length}` : undefined}>
            <SearchInput value={q} onChange={setQ} placeholder="Filtrar por nome…" />
            {regionSelect}
          </Toolbar>
          {nodes.data?.length === 0 ? (
            <Empty
              icon="server"
              title="Nenhum node sincronizado ainda"
              action={
                <Button onClick={() => setAdding(true)}>
                  <Icon name="plus" /> Adicionar hypervisor
                </Button>
              }
            >
              Adicione um servidor Proxmox; ele aparece aqui após a primeira sincronização.
            </Empty>
          ) : nodes.data && visible.length === 0 ? (
            <Empty>Nenhum hypervisor corresponde ao filtro.</Empty>
          ) : (
            !!nodes.data?.length && (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <SortHeader label="Node" k="name" sort={sort} toggle={toggle} />
                      <th className={tbl.th}>Status</th>
                      <SortHeader label="CPU em uso" k="cpu" sort={sort} toggle={toggle} />
                      <SortHeader label="Memória em uso" k="memory" sort={sort} toggle={toggle} />
                      <SortHeader label="vCPUs configuradas" k="vcpu" sort={sort} toggle={toggle} />
                      <SortHeader label="RAM configurada" k="ram" sort={sort} toggle={toggle} />
                      <SortHeader label="VMs" k="vms" sort={sort} toggle={toggle} align="right" />
                      <th className={`${tbl.th} text-right`}>Ligado há</th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {sorted.map((n) => {
                      const online = n.status === "online";
                      // standalone server = one-node connection: show the admin's label first
                      const multi = (nodes.data ?? []).filter((x) => x.cluster_id === n.cluster_id).length > 1;
                      return (
                        <tr key={n.id} className={tbl.tr}>
                          <td className={tbl.td}>
                            <div className="flex items-center gap-2">
                              <ResourceIcon kind="hypervisor" />
                              <Link href={`/admin/nodes/${n.id}`} className={tbl.link}>
                                {multi ? n.name : n.cluster_name}
                              </Link>
                            </div>
                            <div className="mt-0.5 pl-7 text-xs text-slate-500">
                              {n.region_name ? `${n.region_name} · ${n.zone_name}` : "sem zona"} ·{" "}
                              {multi ? `cluster ${n.cluster_name}` : n.name} · {n.cpu_count} núcleos · {formatBytes(n.memory_bytes)}
                            </div>
                          </td>
                          <td className={tbl.td}>
                            <NodeStatus status={n.status} />
                          </td>
                          <td className={tbl.td}>{online ? <Meter value={n.cpu_usage} title={`CPU de ${n.name}`} /> : "—"}</td>
                          <td className={tbl.td}>
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
                          <td className={tbl.td}>
                            <Allocation
                              ratio={vcpuRatio(n)}
                              label={`${n.vcpus_allocated} / ${n.cpu_count}`}
                              title="vCPUs configuradas nas VMs sobre os núcleos físicos. Não é consumo: acima de 1× é normal em CPU."
                            />
                          </td>
                          <td className={tbl.td}>
                            <Allocation
                              ratio={ramRatio(n)}
                              label={`${mib(n.memory_allocated_mb)} / ${formatBytes(n.memory_bytes)}`}
                              title="RAM configurada nas VMs sobre a RAM física. Acima de 1× há risco de falta de memória se todas usarem o máximo."
                              warnAbove={1}
                            />
                          </td>
                          <td className={`${tbl.td} text-right tabular-nums`}>
                            {n.instances_running}
                            <span className="text-slate-500"> / {n.instances_total}</span>
                          </td>
                          <td className={`${tbl.td} text-right tabular-nums text-slate-600 dark:text-slate-400`}>
                            {online ? uptime(n.uptime_seconds) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500 dark:border-slate-800">
            “Em uso” é o consumo real medido pelo Proxmox. “Configuradas” é o que as VMs receberam
            (não é consumo): acima de 1× é sobrecomprometimento, comum em CPU e arriscado em memória (⚠).
          </p>
        </Card>
      )}

      {tab === "storage" && (
        <Card flush>
          <Toolbar count={storage.data ? `${storageRows.length} de ${storage.data.length}` : undefined}>
            <SearchInput value={q} onChange={setQ} placeholder="Filtrar por storage ou node…" />
          </Toolbar>
          {storage.data?.length === 0 && (
            <Empty icon="layers">Nenhum storage visível ao token (precisa de Datastore.Audit no storage).</Empty>
          )}
          {!!storage.data?.length && (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Storage</th>
                    <th className={tbl.th}>Node</th>
                    <th className={tbl.th}>Tipo</th>
                    <th className={tbl.th}>Status</th>
                    <th className={tbl.th}>Uso</th>
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {storageRows.map((s) => (
                    <tr key={s.id} className={tbl.tr}>
                      <td className={`${tbl.td} font-medium`}>{s.name}</td>
                      <td className={tbl.td}>{s.node}</td>
                      <td className={tbl.td}>
                        {s.type}
                        {s.shared && <span className="ml-1 text-xs text-slate-500">(compartilhado)</span>}
                      </td>
                      <td className={tbl.td}>
                        {s.active ? <Status tone="ok">Ativo</Status> : <Status tone="error">Inativo</Status>}
                      </td>
                      <td className={tbl.td}>
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
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
