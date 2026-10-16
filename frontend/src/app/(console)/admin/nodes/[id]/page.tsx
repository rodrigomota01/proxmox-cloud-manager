"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import { ConnectionInstances, ConnectionSettings } from "@/components/admin/connection";
import { IpamPanel } from "@/components/admin/ipam-panel";
import { NodeStorageCard, PhysicalDisksCard } from "@/components/disks";
import { NodeMetrics } from "@/components/metrics-panel";
import { DescriptionList, PageHeader } from "@/components/page";
import { Card, ErrorBox, Status, formatBytes } from "@/components/ui";
import { Allocation, Meter, mib, uptime } from "@/components/viz";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";

const TABS = [
  { key: "overview", label: "infra.node.tabOverview" },
  { key: "vms", label: "infra.node.tabVms" },
  { key: "ips", label: "infra.node.tabIps" },
  { key: "config", label: "infra.node.tabConfig" },
] as const satisfies readonly { key: string; label: MessageKey }[];
type Tab = (typeof TABS)[number]["key"];

export default function NodeDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.some((x) => x.key === params.get("tab")) ? (params.get("tab") as Tab) : "overview";
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
    ...(multi ? ([[t("infra.node.cluster"), n.cluster_name]] as [string, React.ReactNode][]) : []),
    [t("infra.common.zone"), n.region_name ? `${n.region_name} · ${n.zone_name}` : t("infra.common.noZone")],
    [t("infra.node.proxmoxName"), n.name],
    [t("infra.usage.uptime"), online ? uptime(n.uptime_seconds) : "—"],
    [t("infra.usage.cpuInUse"), online ? <Meter value={n.cpu_usage} title="CPU" /> : "—"],
    [
      t("infra.usage.memoryInUse"),
      online ? (
        <Meter
          value={n.memory_bytes ? n.memory_used_bytes / n.memory_bytes : 0}
          label={`${formatBytes(n.memory_used_bytes)} / ${formatBytes(n.memory_bytes)}`}
          title={t("infra.node.memory")}
        />
      ) : (
        "—"
      ),
    ],
    [
      t("infra.usage.rootDisk"),
      online && n.root_disk_bytes ? (
        <Meter
          value={n.root_disk_used_bytes / n.root_disk_bytes}
          label={`${formatBytes(n.root_disk_used_bytes)} / ${formatBytes(n.root_disk_bytes)}`}
          title={t("infra.node.rootDiskHint")}
        />
      ) : (
        "—"
      ),
    ],
    [
      t("infra.usage.vcpusConfigured"),
      <Allocation
        key="v"
        ratio={n.cpu_count ? n.vcpus_allocated / n.cpu_count : 0}
        label={t("infra.node.cores", { used: n.vcpus_allocated, total: n.cpu_count })}
        title={t("infra.usage.vcpuHint")}
      />,
    ],
    [
      t("infra.usage.ramConfigured"),
      <Allocation
        key="r"
        ratio={n.memory_bytes ? (n.memory_allocated_mb * 1024 ** 2) / n.memory_bytes : 0}
        label={`${mib(n.memory_allocated_mb)} / ${formatBytes(n.memory_bytes)}`}
        title={t("infra.node.ramHint")}
        warnAbove={1}
      />,
    ],
    [t("infra.node.vmsRunning"), t("infra.node.vmsRunningValue", { running: n.instances_running, total: n.instances_total })],
  ];

  const title = multi ? n.name : n.cluster_name;
  const status =
    n.status === "online" ? (
      <Status tone="ok">{t("infra.common.online")}</Status>
    ) : n.status === "offline" ? (
      <Status tone="error">{t("infra.common.offline")}</Status>
    ) : (
      <Status tone="unknown">{t("status.unknown")}</Status>
    );

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        kind="hypervisor"
        status={status}
        breadcrumbs={[{ label: t("nav.infrastructure") }, { label: t("nav.hypervisors"), href: "/admin/nodes" }, { label: title }]}
        tabs={TABS.map((x) => ({ key: x.key, label: t(x.label) }))}
        activeTab={tab}
        onTab={(k) => router.replace(k === "overview" ? `/admin/nodes/${id}` : `/admin/nodes/${id}?tab=${k}`)}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {n.region_name ? `${n.region_name} · ${n.zone_name}` : t("infra.common.noZone")}
          {multi && t("infra.node.clusterSuffix", { name: n.cluster_name })}
          {!multi && n.name !== n.cluster_name && t("infra.node.proxmoxNameSuffix", { name: n.name })}
          {cluster.data?.version && ` · Proxmox ${cluster.data.version}`}
        </p>
      </PageHeader>
      {tab === "vms" && <ConnectionInstances clusterId={n.cluster_id} nodeName={n.name} />}
      {tab === "ips" && <IpamPanel clusterId={n.cluster_id} />}
      {tab === "config" && cluster.data && <ConnectionSettings cluster={cluster.data} nodeCount={siblings} />}
      {tab === "overview" && (
        <>
          <Card title={t("infra.node.details")}>
            <DescriptionList columns={3} items={rows} />
          </Card>
          {online && <NodeMetrics nodeId={n.id} />}
          <PhysicalDisksCard disks={n.disks} checkedAt={n.disks_checked_at} />
          <NodeStorageCard clusterId={n.cluster_id} node={n.name} />
        </>
      )}
    </div>
  );
}
