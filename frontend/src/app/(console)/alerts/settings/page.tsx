"use client";


import { AlertSettings } from "@/components/alerts";
import { NoTenant } from "@/components/no-tenant";
import { PageHeader } from "@/components/page";
import { Card } from "@/components/ui";
import { usePermissions, useSession } from "@/lib/session";

export default function TenantAlertSettingsPage() {
  const { tenantId, tenant } = useSession();
  const perms = usePermissions(tenantId ? `tenant:${tenantId}` : null);
  if (!tenantId) return <NoTenant />;
  if (perms.size > 0 && !perms.has("alert:manage")) {
    return (
      <Card title="Regras de alerta">
        <p className="text-sm text-slate-600 dark:text-slate-400">Só o admin do cliente configura alertas.</p>
      </Card>
    );
  }
  return (
    <>
      <PageHeader
        title="Regras e canais"
        description={tenant?.name}
        breadcrumbs={[{ label: "Alertas", href: "/alerts" }, { label: "Regras e canais" }]}
      />
      <div className="max-w-5xl space-y-4">
        <AlertSettings mode="tenant" />
      </div>
    </>
  );
}
