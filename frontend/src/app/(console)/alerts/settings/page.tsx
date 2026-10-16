"use client";


import { AlertSettings } from "@/components/alerts";
import { NoTenant } from "@/components/no-tenant";
import { PageHeader } from "@/components/page";
import { Card } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { usePermissions, useSession } from "@/lib/session";

export default function TenantAlertSettingsPage() {
  const { tenantId, tenant } = useSession();
  const t = useT();
  const perms = usePermissions(tenantId ? `tenant:${tenantId}` : null);
  if (!tenantId) return <NoTenant />;
  if (perms.size > 0 && !perms.has("alert:manage")) {
    return (
      <Card title={t("alerts.page.alertRules")}>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("alerts.page.onlyTenantAdmin")}</p>
      </Card>
    );
  }
  return (
    <>
      <PageHeader
        title={t("alerts.page.rulesAndChannels")}
        description={tenant?.name}
        breadcrumbs={[{ label: t("alerts.page.title"), href: "/alerts" }, { label: t("alerts.page.rulesAndChannels") }]}
      />
      <div className="max-w-5xl space-y-4">
        <AlertSettings mode="tenant" />
      </div>
    </>
  );
}
