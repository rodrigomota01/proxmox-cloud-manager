"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { NoTenant } from "@/components/no-tenant";
import { ActivityRow } from "@/components/activity";
import { PageHeader, StatTile } from "@/components/page";
import { Card, Empty, ErrorBox, formatBytes } from "@/components/ui";
import { AlertList } from "@/components/alerts";
import { PlatformCostPreview, TenantCostPreview } from "@/components/cost";
import { K8sAttentionPreview } from "@/components/k8s";
import { ScopeToggle } from "@/components/scope-toggle";
import { UsagePanel } from "@/components/usage-panel";
import { pct } from "@/components/viz";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useSession } from "@/lib/session";

/** Platform admins: every guest on every hypervisor, or one tenant's. */
function PlatformOverview() {
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/overview")),
    refetchInterval: 15_000,
  });
  const infra = overview.data?.infra;
  return (
    <section className="space-y-4">
      <PageHeader
        title="Visão geral"
        description="Toda a plataforma: hypervisors, VMs de todos os clientes, alertas e custos."
        actions={<ScopeToggle />}
      />
      <ErrorBox message={overview.isError ? errorMessage(overview.error) : null} />
      <ActiveAlerts scope={{ admin: true, tenantId: "" }} />
      <K8sAttentionPreview />
      <PlatformCostPreview />
      {infra && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile
            label="Hypervisors online"
            icon="server"
            href="/admin/nodes"
            tone={infra.nodes_online < infra.nodes_total ? "warn" : "ok"}
            value={`${infra.nodes_online} de ${infra.nodes_total}`}
          />
          <StatTile label="CPU dos hosts" icon="dashboard" value={pct(infra.cpu_usage)} hint={`${infra.cores} núcleos`} />
          <StatTile
            label="Memória dos hosts"
            icon="layers"
            value={infra.memory_bytes ? pct(infra.memory_used_bytes / infra.memory_bytes) : "—"}
            hint={`${formatBytes(infra.memory_used_bytes)} de ${formatBytes(infra.memory_bytes)}`}
          />
          <StatTile
            label="Storage"
            icon="folder"
            value={infra.storage_total_bytes ? pct(infra.storage_used_bytes / infra.storage_total_bytes) : "—"}
            hint={`${formatBytes(infra.storage_used_bytes)} de ${formatBytes(infra.storage_total_bytes)}`}
          />
        </div>
      )}
      {overview.data && (
        <>
          <h2 className="pt-2 text-base font-semibold">
            Utilização das VMs{" "}
            <span className="text-sm font-normal text-slate-500">de todos os clientes, inclusive as não adotadas</span>
          </h2>
          <UsagePanel
            usage={overview.data.usage}
            href={(e) => (e.node_id ? `/admin/nodes/${e.node_id}?tab=vms` : null)}
          />
        </>
      )}
    </section>
  );
}

/** Firing alerts in view, most recent first; hidden when there are none. */
/** scope.tenantId "" (admin only) = every alert on the platform. */
function ActiveAlerts({ scope }: { scope: { admin: boolean; tenantId: string } }) {
  const alerts = useQuery({
    queryKey: ["dashboard", "alerts", scope.admin, scope.tenantId],
    queryFn: async () =>
      scope.admin
        ? unwrap(
            await api.GET("/api/v1/admin/alerts", {
              params: { query: { limit: 8, ...(scope.tenantId ? { tenant_id: scope.tenantId } : {}) } },
            }),
          )
        : unwrap(await api.GET("/api/v1/alerts", { params: { query: { limit: 8 } } })),
    refetchInterval: 15_000,
  });
  if (!alerts.data?.length) return null;
  return (
    <Card
      title="Alertas ativos"
      actions={
        <Link href="/alerts" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          Ver todos
        </Link>
      }
    >
      <AlertList
        alerts={alerts.data}
        showTenant={scope.admin && !scope.tenantId}
        href={(a) =>
          scope.admin
            ? a.resource_type === "node"
              ? `/admin/nodes/${a.resource_id}`
              : null
            : `/instances/${a.resource_id}`
        }
      />
    </Card>
  );
}

/** The selected tenant, as its members see it (project visibility applies). */
function TenantUsage({ tenantId }: { tenantId: string }) {
  const usage = useQuery({
    queryKey: ["dashboard", "usage", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/dashboard/usage")),
    refetchInterval: 15_000,
  });
  if (usage.isError) return <ErrorBox message={errorMessage(usage.error)} />;
  if (!usage.data) return null;
  return <UsagePanel usage={usage.data} href={(e) => `/instances/${e.id}`} />;
}

export default function DashboardPage() {
  const { tenantId, platformView } = useSession();
  if (platformView) return <PlatformOverview />;
  if (!tenantId) return <NoTenant />;
  return <TenantDashboard tenantId={tenantId} />;
}

function TenantDashboard({ tenantId }: { tenantId: string }) {
  const { tenant } = useSession();
  const summary = useQuery({
    queryKey: ["dashboard", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/dashboard/summary")),
    refetchInterval: 15_000,
  });

  const data = summary.data;
  const count = (kind: string, state?: string) => {
    const byState = data?.instances[kind] ?? {};
    return state ? (byState[state] ?? 0) : Object.values(byState).reduce((a, b) => a + b, 0);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Visão geral"
        description={tenant ? `Cliente ${tenant.name}: máquinas, consumo, alertas, custos e operações recentes.` : undefined}
        actions={<ScopeToggle />}
      />
      <ErrorBox message={summary.isError ? errorMessage(summary.error) : null} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Projetos" icon="folder" href="/projects" value={data?.projects ?? "—"} />
        <StatTile
          label="VMs"
          icon="monitor"
          href="/instances"
          value={data ? count("vm") : "—"}
          hint={data ? `${count("vm", "running")} ligadas` : undefined}
        />
        <StatTile
          label="Containers"
          icon="layers"
          href="/instances"
          value={data ? count("container") : "—"}
          hint={data ? `${count("container", "running")} ligados` : undefined}
        />
        <StatTile label="Operações em andamento" icon="history" href="/history" value={data?.active_jobs ?? "—"} />
      </div>

      <ActiveAlerts scope={{ admin: false, tenantId }} />
      <TenantCostPreview tenantId={tenantId} />
      <TenantUsage tenantId={tenantId} />

      <Card
        title="Operações recentes"
        actions={
          <Link href="/history" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            Ver histórico completo
          </Link>
        }
      >
        {data && data.recent_jobs.length === 0 && <Empty icon="history">Nenhuma operação ainda.</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data?.recent_jobs.map((job) => (
            <ActivityRow key={job.id} job={job} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
