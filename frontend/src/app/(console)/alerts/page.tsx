"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { AlertList } from "@/components/alerts";
import { NoTenant } from "@/components/no-tenant";
import { ScopeToggle } from "@/components/scope-toggle";
import { PageHeader } from "@/components/page";
import { Card, ErrorBox } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { usePermissions, useSession } from "@/lib/session";

type State = "active" | "resolved";

const TABS = [
  { key: "active", label: "Ativos" },
  { key: "resolved", label: "Resolvidos" },
] as const;

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
    <>
      <PageHeader
        title="Alertas"
        description="Toda a plataforma: hosts, storage e as VMs de todos os clientes."
        actions={
          <>
            <ScopeToggle />
            <Link href="/admin/alerts" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
              Regras e canais
            </Link>
          </>
        }
        tabs={TABS}
        activeTab={state}
        onTab={setState}
      />
      <div className="max-w-5xl space-y-4">
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
    </>
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
    <>
      <PageHeader
        title="Alertas"
        description={`${tenant?.name ?? ""}: VMs com consumo acima dos limites definidos pela plataforma e pelo seu time.`}
        actions={
          <>
            <ScopeToggle />
            {perms.has("alert:manage") && (
              <Link href="/alerts/settings" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                Regras e canais
              </Link>
            )}
          </>
        }
        tabs={TABS}
        activeTab={state}
        onTab={setState}
      />
      <div className="max-w-5xl space-y-4">
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
    </>
  );
}

export default function AlertsPage() {
  const { tenantId, platformView } = useSession();
  if (platformView) return <PlatformAlerts />;
  if (!tenantId) return <NoTenant />;
  return <TenantAlerts tenantId={tenantId} />;
}
