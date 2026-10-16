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
import { useT, type MessageKey } from "@/lib/i18n";
import { usePermissions, useSession } from "@/lib/session";

type State = "active" | "resolved";

const TABS = [
  { key: "active", label: "alerts.page.tabActive" },
  { key: "resolved", label: "alerts.page.tabResolved" },
] as const satisfies readonly { key: State; label: MessageKey }[];

function useTabs() {
  const t = useT();
  return TABS.map((tab) => ({ key: tab.key, label: t(tab.label) }));
}

/** Platform admins, whole-platform view: hosts, storage and every client's VMs. */
function PlatformAlerts() {
  const t = useT();
  const tabs = useTabs();
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
        title={t("alerts.page.title")}
        description={t("alerts.page.platformDescription")}
        actions={
          <>
            <ScopeToggle />
            <Link href="/admin/alerts" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
              {t("alerts.page.rulesAndChannels")}
            </Link>
          </>
        }
        tabs={tabs}
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
              empty={state === "active" ? t("alerts.list.empty") : t("alerts.page.noResolved")}
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
  const t = useT();
  const tabs = useTabs();
  const [state, setState] = useState<State>("active");
  const alerts = useQuery({
    queryKey: ["alerts", tenantId, state],
    queryFn: async () => unwrap(await api.GET("/api/v1/alerts", { params: { query: { state, limit: 200 } } })),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader
        title={t("alerts.page.title")}
        description={t("alerts.page.tenantDescription", { tenant: tenant?.name ?? "" })}
        actions={
          <>
            <ScopeToggle />
            {perms.has("alert:manage") && (
              <Link href="/alerts/settings" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
                {t("alerts.page.rulesAndChannels")}
              </Link>
            )}
          </>
        }
        tabs={tabs}
        activeTab={state}
        onTab={setState}
      />
      <div className="max-w-5xl space-y-4">
        <ErrorBox message={alerts.isError ? errorMessage(alerts.error) : null} />
        <Card>
          {alerts.data && (
            <AlertList
              alerts={alerts.data}
              empty={state === "active" ? t("alerts.list.empty") : t("alerts.page.noResolved")}
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
