"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { AddHypervisorDialog } from "@/components/admin/connection";
import { ClusterStatus } from "@/components/cluster-status";
import { failingDisks } from "@/components/disks";
import { Icon } from "@/components/icons";
import { PageHeader, ResourceIcon, SearchInput, StatTile, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Select, Status, formatBytes, tbl } from "@/components/ui";
import { Allocation, Meter, SortHeader, mib, ratioLabel, uptime, useSorted } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";

type Node = Schemas["NodeOut"];
type SortKey = "name" | "cpu" | "memory" | "disk" | "vcpu" | "ram" | "vms";

const memRatio = (n: Node) => (n.memory_bytes ? n.memory_used_bytes / n.memory_bytes : 0);
const diskRatio = (n: Node) => (n.root_disk_bytes ? n.root_disk_used_bytes / n.root_disk_bytes : 0);
const vcpuRatio = (n: Node) => (n.cpu_count ? n.vcpus_allocated / n.cpu_count : 0);
const ramRatio = (n: Node) => (n.memory_bytes ? (n.memory_allocated_mb * 1024 ** 2) / n.memory_bytes : 0);

function NodeStatus({ status }: { status: string }) {
  const t = useT();
  if (status === "online") return <Status tone="ok">{t("infra.common.online")}</Status>;
  if (status === "offline") return <Status tone="error">{t("infra.common.offline")}</Status>;
  return <Status tone="unknown">{t("status.unknown")}</Status>;
}

const TABS: readonly { key: "nodes" | "storage"; label: MessageKey }[] = [
  { key: "nodes", label: "infra.nodes.tabNodes" },
  { key: "storage", label: "infra.nodes.tabStorage" },
];
type Tab = (typeof TABS)[number]["key"];

function Totals({ nodes }: { nodes: Node[] }) {
  const t = useT();
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
        label={t("infra.nodes.hypervisorsOnline")}
        value={t("infra.common.countOf", { shown: online.length, total: nodes.length })}
        tone={online.length < nodes.length ? "warn" : "ok"}
        hint={
          online.length < nodes.length
            ? t("infra.nodes.down", { count: nodes.length - online.length })
            : t("infra.nodes.allOnline")
        }
      />
      <StatTile
        icon="dashboard"
        label={t("infra.usage.cpuInUse")}
        value={`${Math.round(cpuWeighted * 100)}%`}
        hint={t("infra.nodes.physicalCores", { count: cores })}
      />
      <StatTile
        icon="layers"
        label={t("infra.usage.memoryInUse")}
        value={mem ? `${Math.round((memUsed / mem) * 100)}%` : "—"}
        hint={t("infra.nodes.memoryOf", { used: formatBytes(memUsed), total: formatBytes(mem) })}
      />
      <StatTile
        icon="monitor"
        label={t("infra.nodes.vcpusOverCores")}
        value={`${vcpus} / ${cores}`}
        hint={cores ? t("infra.nodes.overcommit", { ratio: ratioLabel(vcpus / cores) }) : undefined}
      />
    </div>
  );
}

/** Connections with no node yet: just added, waiting for the first sync, or a bad token. */
function PendingConnections({ nodes }: { nodes: Node[] }) {
  const t = useT();
  const clusters = useQuery({
    queryKey: ["admin", "clusters"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/clusters")),
    refetchInterval: 15_000,
  });
  const pending = (clusters.data ?? []).filter((c) => !nodes.some((n) => n.cluster_id === c.id));
  if (pending.length === 0) return null;
  return (
    <Alert variant="warning" title={t("infra.nodes.pendingTitle", { count: pending.length })}>
      <ul className="mt-1 space-y-1.5">
        {pending.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link href={`/admin/clusters/${c.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
              {c.name}
            </Link>
            <span className="font-mono text-xs opacity-75">{c.api_url}</span>
            <ClusterStatus status={c.status} />
            {!c.has_credentials && <Badge tone="amber">{t("infra.nodes.noToken")}</Badge>}
            {c.last_error && <span className="w-full text-xs text-rose-700 dark:text-rose-300">{c.last_error}</span>}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

export default function NodesPage() {
  const t = useT();
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
  const regionNames = [...new Set((nodes.data ?? []).map((n) => n.region_name ?? t("infra.common.noRegion")))].sort();
  const needle = q.trim().toLowerCase();
  const visible = (nodes.data ?? []).filter(
    (n) =>
      (!region || (n.region_name ?? t("infra.common.noRegion")) === region) &&
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
      disk: diskRatio,
      vcpu: vcpuRatio,
      ram: ramRatio,
      vms: (n) => n.instances_running,
    },
    { key: "cpu", desc: true },
  );

  const regionSelect = (
    <Select aria-label={t("infra.common.region")} value={region} onChange={(e) => setRegion(e.target.value)}>
      <option value="">{t("infra.nodes.allRegions")}</option>
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
        title={t("nav.hypervisors")}
        breadcrumbs={[{ label: t("nav.infrastructure") }, { label: t("nav.hypervisors") }]}
        description={t("infra.nodes.description")}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" /> {t("infra.nodes.addHypervisor")}
          </Button>
        }
        tabs={TABS.map((x) => ({
          key: x.key,
          label: t(x.label),
          count: x.key === "nodes" ? nodes.data?.length : storage.data?.length,
        }))}
        activeTab={tab}
        onTab={(k) => router.replace(k === "nodes" ? "/admin/nodes" : `/admin/nodes?tab=${k}`)}
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
          <Toolbar count={nodes.data ? t("infra.common.countOf", { shown: visible.length, total: nodes.data.length }) : undefined}>
            <SearchInput value={q} onChange={setQ} placeholder={t("infra.nodes.filterByName")} />
            {regionSelect}
          </Toolbar>
          {nodes.data?.length === 0 ? (
            <Empty
              icon="server"
              title={t("infra.nodes.emptyTitle")}
              action={
                <Button onClick={() => setAdding(true)}>
                  <Icon name="plus" /> {t("infra.nodes.addHypervisor")}
                </Button>
              }
            >
              {t("infra.nodes.emptyBody")}
            </Empty>
          ) : nodes.data && visible.length === 0 ? (
            <Empty>{t("infra.nodes.noMatch")}</Empty>
          ) : (
            !!nodes.data?.length && (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <SortHeader label={t("infra.common.node")} k="name" sort={sort} toggle={toggle} />
                      <th className={tbl.th}>{t("infra.common.status")}</th>
                      <SortHeader label={t("infra.usage.cpuInUse")} k="cpu" sort={sort} toggle={toggle} />
                      <SortHeader label={t("infra.usage.memoryInUse")} k="memory" sort={sort} toggle={toggle} />
                      <SortHeader label={t("infra.usage.rootDisk")} k="disk" sort={sort} toggle={toggle} />
                      <SortHeader label={t("infra.usage.vcpusConfigured")} k="vcpu" sort={sort} toggle={toggle} />
                      <SortHeader label={t("infra.usage.ramConfigured")} k="ram" sort={sort} toggle={toggle} />
                      <SortHeader label="VMs" k="vms" sort={sort} toggle={toggle} align="right" />
                      <th className={`${tbl.th} text-right`}>{t("infra.usage.uptime")}</th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {sorted.map((n) => {
                      const online = n.status === "online";
                      // standalone server = one-node connection: show the admin's label first
                      const multi = (nodes.data ?? []).filter((x) => x.cluster_id === n.cluster_id).length > 1;
                      return (
                        <tr key={n.id} className={tbl.tr}>
                          {/* only where it is: Proxmox name, cluster, cores and memory are on its page */}
                          <td className={`${tbl.td} whitespace-nowrap`}>
                            <div className="flex items-center gap-2">
                              <ResourceIcon kind="hypervisor" />
                              <Link href={`/admin/nodes/${n.id}`} className={tbl.link}>
                                {multi ? n.name : n.cluster_name}
                              </Link>
                            </div>
                            <div className="mt-0.5 pl-7 text-xs text-slate-500">
                              {n.region_name ? `${n.region_name} · ${n.zone_name}` : t("infra.common.noZone")}
                            </div>
                          </td>
                          <td className={tbl.td}>
                            <NodeStatus status={n.status} />
                            {failingDisks(n.disks).length > 0 && (
                              <div className="mt-0.5">
                                <Status tone="warn">
                                  {t("infra.nodes.smartFailing", {
                                    count: failingDisks(n.disks).length,
                                    health: failingDisks(n.disks)[0].health ?? "",
                                  })}
                                </Status>
                              </div>
                            )}
                          </td>
                          <td className={tbl.td}>{online ? <Meter value={n.cpu_usage} title={t("infra.nodes.cpuOf", { name: n.name })} /> : "—"}</td>
                          <td className={tbl.td}>
                            {online ? (
                              <Meter
                                value={memRatio(n)}
                                label={`${formatBytes(n.memory_used_bytes)} / ${formatBytes(n.memory_bytes)}`}
                                title={t("infra.nodes.memoryOfNode", { name: n.name })}
                              />
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={tbl.td}>
                            {online && n.root_disk_bytes ? (
                              <Meter
                                value={diskRatio(n)}
                                label={`${formatBytes(n.root_disk_used_bytes)} / ${formatBytes(n.root_disk_bytes)}`}
                                title={t("infra.nodes.rootDiskHint")}
                              />
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={tbl.td}>
                            <Allocation
                              ratio={vcpuRatio(n)}
                              label={`${n.vcpus_allocated} / ${n.cpu_count}`}
                              title={t("infra.usage.vcpuHint")}
                            />
                          </td>
                          <td className={tbl.td}>
                            <Allocation
                              ratio={ramRatio(n)}
                              label={`${mib(n.memory_allocated_mb)} / ${formatBytes(n.memory_bytes)}`}
                              title={t("infra.nodes.ramHint")}
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
            {t("infra.nodes.footnote")}
          </p>
        </Card>
      )}

      {tab === "storage" && (
        <Card flush>
          <Toolbar count={storage.data ? t("infra.common.countOf", { shown: storageRows.length, total: storage.data.length }) : undefined}>
            <SearchInput value={q} onChange={setQ} placeholder={t("infra.nodes.filterStorage")} />
          </Toolbar>
          {storage.data?.length === 0 && (
            <Empty icon="layers">{t("infra.nodes.noStorage")}</Empty>
          )}
          {!!storage.data?.length && (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Storage</th>
                    <th className={tbl.th}>{t("infra.common.node")}</th>
                    <th className={tbl.th}>{t("infra.common.type")}</th>
                    <th className={tbl.th}>{t("infra.common.status")}</th>
                    <th className={tbl.th}>{t("infra.common.usage")}</th>
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {storageRows.map((s) => (
                    <tr key={s.id} className={tbl.tr}>
                      <td className={`${tbl.td} font-medium`}>{s.name}</td>
                      <td className={tbl.td}>{s.node}</td>
                      <td className={tbl.td}>
                        {s.type}
                        {s.shared && <span className="ml-1 text-xs text-slate-500">{t("infra.common.shared")}</span>}
                      </td>
                      <td className={tbl.td}>
                        {s.active ? <Status tone="ok">{t("infra.common.active")}</Status> : <Status tone="error">{t("infra.common.inactive")}</Status>}
                      </td>
                      <td className={tbl.td}>
                        <Meter
                          value={s.total_bytes ? s.used_bytes / s.total_bytes : 0}
                          label={`${formatBytes(s.used_bytes)} / ${formatBytes(s.total_bytes)}`}
                          title={t("infra.common.usageOf", { name: s.name })}
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
