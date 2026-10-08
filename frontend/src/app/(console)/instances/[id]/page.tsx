"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import { NoTenant } from "@/components/no-tenant";
import { DescriptionList, PageHeader } from "@/components/page";
import { PowerActions } from "@/components/power-actions";
import { DeleteInstance } from "@/components/delete-instance";
import { InstanceMetrics } from "@/components/metrics-panel";
import { DiskUsage } from "@/components/disk-usage";
import { Meter, mib, rate, uptime } from "@/components/viz";
import { ActivityRow } from "@/components/activity";
import { Badge, Card, Empty, ErrorBox, PowerBadge, StateBadge, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useProjectNames } from "@/lib/queries";
import { useSession } from "@/lib/session";

const BUSY = ["provisioning", "deleting"];

const TABS = [
  { key: "overview", label: "Visão geral" },
  { key: "metrics", label: "Métricas" },
  { key: "history", label: "Histórico" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const CRUMBS = { label: "Máquinas virtuais", href: "/instances" };

export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.some((t) => t.key === params.get("tab")) ? (params.get("tab") as Tab) : "overview";
  const { tenantId } = useSession();
  const projectNames = useProjectNames();

  const instance = useQuery({
    queryKey: ["instance", id, tenantId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/instances/{instance_id}", { params: { path: { instance_id: id } } })),
    enabled: tenantId !== null,
    // poll faster while a job is creating/deleting it
    refetchInterval: (q) => (q.state.data && BUSY.includes(q.state.data.state) ? 2_000 : 15_000),
  });
  const jobs = useQuery({
    queryKey: ["jobs", tenantId, id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/jobs", { params: { query: { resource_id: id, limit: 20 } } })).items,
    enabled: tenantId !== null,
    refetchInterval: 5_000,
  });

  if (!tenantId) return <NoTenant />;
  if (instance.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title="Instância" breadcrumbs={[CRUMBS]} />
        <ErrorBox message={errorMessage(instance.error)} />
      </div>
    );
  }
  const i = instance.data;
  if (!i) return null;
  const running = i.power_state === "running" && i.state === "active";

  return (
    <div className="space-y-4">
      <PageHeader
        title={i.name}
        kind={i.kind === "vm" ? "vm" : "container"}
        breadcrumbs={[CRUMBS, { label: i.name }]}
        status={i.state === "active" ? <PowerBadge state={i.power_state} /> : <StateBadge state={i.state} />}
        actions={
          <>
            <PowerActions instance={i} />
            <DeleteInstance instance={i} />
          </>
        }
        tabs={TABS.map((t) => (t.key === "history" && jobs.data ? { ...t, count: jobs.data.length } : t))}
        activeTab={tab}
        onTab={(t) => router.replace(t === "overview" ? `/instances/${id}` : `/instances/${id}?tab=${t}`)}
      />

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Detalhes" className="lg:col-span-2">
            <DescriptionList
              items={[
                ["Nome", i.name],
                ["Tipo", i.kind === "vm" ? "Máquina virtual" : "Container"],
                ["Projeto", projectNames.get(i.project_id) ?? "—"],
                ["Região / zona", i.region_name ? `${i.region_name} · ${i.zone_name}` : "—"],
                ["vCPUs", i.vcpus],
                ["Memória", `${(i.memory_mb / 1024).toFixed(1)} GiB`],
                ["Disco raiz", `${i.root_disk_gb} GiB`],
                [
                  "IP",
                  i.ipv4 ? (
                    <span className="font-mono">
                      {i.ipv4} <span className="text-slate-500">via {i.gateway}</span>
                    </span>
                  ) : (
                    "—"
                  ),
                ],
                [
                  "Tags",
                  i.tags.length ? (
                    <span className="flex flex-wrap gap-1">
                      {i.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </span>
                  ) : (
                    "—"
                  ),
                ],
                ["Visto pela última vez", formatDate(i.last_seen_at)],
              ]}
            />
          </Card>

          <Card title="Utilização" description={running ? "Agora" : undefined}>
            {running ? (
              <DescriptionList
                columns={1}
                items={[
                  ["CPU", <Meter key="c" value={i.cpu_usage} title="CPU" />],
                  [
                    "Memória",
                    <Meter
                      key="m"
                      value={i.memory_mb ? i.memory_used_mb / i.memory_mb : 0}
                      label={`${mib(i.memory_used_mb)} / ${mib(i.memory_mb)}`}
                      title="Memória"
                    />,
                  ],
                  ["Disco usado", <DiskUsage key="d" disk={i.disk} detailed />],
                  [
                    "Rede",
                    <span key="n" className="tabular-nums">
                      ↓ {rate(i.net_in_bps)} · ↑ {rate(i.net_out_bps)}
                    </span>,
                  ],
                  ["Ligada há", uptime(i.uptime_seconds)],
                ]}
              />
            ) : (
              <Empty icon="power">Sem consumo: a instância não está ligada.</Empty>
            )}
          </Card>

          <Card
            title="Operações recentes"
            className="lg:col-span-3"
            actions={
              <Link href={`/instances/${id}?tab=history`} replace className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                Ver todas
              </Link>
            }
          >
            {jobs.data?.length === 0 && <Empty icon="history">Nenhuma operação nesta instância.</Empty>}
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {jobs.data?.slice(0, 5).map((job) => (
                <ActivityRow key={job.id} job={job} showResource={false} />
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === "metrics" &&
        (i.state === "active" ? (
          <InstanceMetrics instanceId={i.id} tenantId={tenantId} />
        ) : (
          <Card>
            <Empty icon="dashboard">Métricas aparecem quando a instância estiver ativa.</Empty>
          </Card>
        ))}

      {tab === "history" && (
        <Card
          title="Histórico"
          actions={
            <Link href="/history" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
              Histórico do cliente
            </Link>
          }
        >
          {jobs.data?.length === 0 && <Empty icon="history">Nenhuma operação nesta instância.</Empty>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {jobs.data?.map((job) => (
              <ActivityRow key={job.id} job={job} showResource={false} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
