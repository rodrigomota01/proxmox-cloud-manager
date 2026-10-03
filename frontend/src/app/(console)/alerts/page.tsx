"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { AlertList } from "@/components/alerts";
import { NoTenant } from "@/components/no-tenant";
import { ScopeToggle } from "@/components/scope-toggle";
import { Card, ErrorBox } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { usePermissions, useSession } from "@/lib/session";

type State = "active" | "resolved";

function Tabs({ state, setState }: { state: State; setState: (s: State) => void }) {
  return (
    <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label="Alertas">
      {(["active", "resolved"] as const).map((s) => (
        <button
          key={s}
          onClick={() => setState(s)}
          aria-current={state === s ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            state === s
              ? "border-indigo-600 font-medium text-indigo-700 dark:text-indigo-300"
              : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          }`}
        >
          {s === "active" ? "Ativos" : "Resolvidos"}
        </button>
      ))}
    </nav>
  );
}

/** Platform admins, whole-platform view: hosts, storage and every client's VMs. */
function PlatformAlerts() {
  const [state, setState] = useState<State>("active");
  const alerts = useQuery({
    queryKey: ["admin", "alerts", state],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/alerts", { params: { query: { state, limit: 200 } } })),
    refetchInterval: 15_000,
  });
  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Alertas de toda a plataforma</h1>
        <div className="flex items-center gap-3">
          <ScopeToggle />
          <Link href="/admin/alerts" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            Regras e canais
          </Link>
        </div>
      </div>
      <Tabs state={state} setState={setState} />
      <ErrorBox message={alerts.isError ? errorMessage(alerts.error) : null} />
      <Card>
        {alerts.data && (
          <AlertList
            alerts={alerts.data}
            showTenant
            empty={state === "active" ? "Nenhum alerta ativo." : "Nenhum alerta resolvido ainda."}
            href={(a) =>
              a.resource_type === "node" ? `/admin/nodes/${a.resource_id}` : a.resource_type === "storage" ? "/admin/nodes" : null
            }
          />
        )}
      </Card>
    </div>
  );
}

function TenantAlerts({ tenantId }: { tenantId: string }) {
  const { tenant } = useSession();
  const perms = usePermissions(`tenant:${tenantId}`);
  const [state, setState] = useState<State>("active");
  const alerts = useQuery({
    queryKey: ["alerts", tenantId, state],
    queryFn: async () => unwrap(await api.GET("/api/v1/alerts", { params: { query: { state, limit: 200 } } })),
    refetchInterval: 15_000,
  });
  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Alertas de {tenant?.name}</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            VMs com consumo acima dos limites definidos pela plataforma e pelo seu time.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeToggle />
          {perms.has("alert:manage") && (
            <Link href="/alerts/settings" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
              Regras e canais
            </Link>
          )}
        </div>
      </div>
      <Tabs state={state} setState={setState} />
      <ErrorBox message={alerts.isError ? errorMessage(alerts.error) : null} />
      <Card>
        {alerts.data && (
          <AlertList
            alerts={alerts.data}
            empty={state === "active" ? "Nenhum alerta ativo." : "Nenhum alerta resolvido ainda."}
            href={(a) => `/instances/${a.resource_id}`}
          />
        )}
      </Card>
    </div>
  );
}

export default function AlertsPage() {
  const { tenantId, platformView } = useSession();
  if (platformView) return <PlatformAlerts />;
  if (!tenantId) return <NoTenant />;
  return <TenantAlerts tenantId={tenantId} />;
}
