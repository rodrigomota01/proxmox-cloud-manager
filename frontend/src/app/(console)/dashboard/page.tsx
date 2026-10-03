"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { NoTenant } from "@/components/no-tenant";
import { ActivityRow } from "@/components/activity";
import { Card, Empty, ErrorBox } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useSession } from "@/lib/session";

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

export default function DashboardPage() {
  const { tenantId, tenant } = useSession();
  const summary = useQuery({
    queryKey: ["dashboard", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/dashboard/summary")),
    enabled: tenantId !== null,
    refetchInterval: 15_000,
  });

  if (!tenantId) return <NoTenant />;
  const data = summary.data;
  const count = (kind: string, state?: string) => {
    const byState = data?.instances[kind] ?? {};
    return state ? (byState[state] ?? 0) : Object.values(byState).reduce((a, b) => a + b, 0);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">{tenant?.name}</h1>
      <ErrorBox message={summary.isError ? errorMessage(summary.error) : null} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Projetos" value={data?.projects ?? "—"} />
        <Stat label="VMs" value={data ? count("vm") : "—"} />
        <Stat label="Containers" value={data ? count("container") : "—"} />
        <Stat
          label="Ligadas"
          value={data ? count("vm", "running") + count("container", "running") : "—"}
        />
        <Stat label="Operações em andamento" value={data?.active_jobs ?? "—"} />
      </div>

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
