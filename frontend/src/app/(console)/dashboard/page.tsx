"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { ActivityRow } from "@/components/activity";
import { Card, Empty, ErrorBox, Select, formatBytes } from "@/components/ui";
import { Stat, UsagePanel } from "@/components/usage-panel";
import { pct } from "@/components/viz";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useSession } from "@/lib/session";

/** Platform admins: every guest on every hypervisor, or one tenant's. */
function PlatformOverview() {
  const { tenants } = useSession();
  const [scope, setScope] = useState("");
  const overview = useQuery({
    queryKey: ["admin", "overview", scope],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/overview", { params: { query: scope ? { tenant_id: scope } : {} } })),
    refetchInterval: 15_000,
  });
  const infra = overview.data?.infra;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Visão geral</h1>
        <Select aria-label="Escopo" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">Todos os clientes e hypervisors</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              Cliente {t.name}
            </option>
          ))}
        </Select>
      </div>
      <ErrorBox message={overview.isError ? errorMessage(overview.error) : null} />
      {infra && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Hypervisors online" value={`${infra.nodes_online} de ${infra.nodes_total}`} />
          <Stat label="CPU dos hosts" value={pct(infra.cpu_usage)} hint={`${infra.cores} núcleos`} />
          <Stat
            label="Memória dos hosts"
            value={infra.memory_bytes ? pct(infra.memory_used_bytes / infra.memory_bytes) : "—"}
            hint={`${formatBytes(infra.memory_used_bytes)} de ${formatBytes(infra.memory_bytes)}`}
          />
          <Stat
            label="Storage"
            value={infra.storage_total_bytes ? pct(infra.storage_used_bytes / infra.storage_total_bytes) : "—"}
            hint={`${formatBytes(infra.storage_used_bytes)} de ${formatBytes(infra.storage_total_bytes)}`}
          />
        </div>
      )}
      {overview.data && (
        <>
          <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            {scope ? "VMs do cliente" : "VMs (todas, inclusive não adotadas)"}
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
  const { tenantId, isPlatformAdmin } = useSession();
  if (isPlatformAdmin) return <PlatformOverview />;
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
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">{tenant?.name}</h1>
      <ErrorBox message={summary.isError ? errorMessage(summary.error) : null} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Projetos" value={data?.projects ?? "—"} />
        <Stat label="VMs" value={data ? count("vm") : "—"} />
        <Stat label="Containers" value={data ? count("container") : "—"} />
        <Stat label="Operações em andamento" value={data?.active_jobs ?? "—"} />
      </div>

      <TenantUsage tenantId={tenantId} />

      <Card
        title="Operações recentes"
        actions={
          <Link href="/history" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            Ver histórico completo
          </Link>
        }
      >
        {data && data.recent_jobs.length === 0 && <Empty>Nenhuma operação ainda.</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data?.recent_jobs.map((job) => (
            <ActivityRow key={job.id} job={job} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
