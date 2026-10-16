"use client";

import { PageHeader } from "@/components/page";

import { AlertSettings } from "@/components/alerts";
import { useT } from "@/lib/i18n";

export default function PlatformAlertSettingsPage() {
  const t = useT();
  return (
    <>
      <PageHeader
        title={t("alerts.page.alertRules")}
        description={t("alerts.page.platformRulesDescription")}
        breadcrumbs={[{ label: t("alerts.page.title"), href: "/alerts" }, { label: t("alerts.page.alertRules") }]}
      />
      <div className="max-w-5xl space-y-4">
        <AlertSettings mode="platform" />
      </div>
    </>
  );
}
