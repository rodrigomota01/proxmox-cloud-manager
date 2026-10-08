"use client";

import { PageHeader } from "@/components/page";

import { AlertSettings } from "@/components/alerts";

export default function PlatformAlertSettingsPage() {
  return (
    <>
      <PageHeader
        title="Regras de alerta"
        description="Regras e canais da plataforma: valem para hosts, storage e as VMs de todos os clientes."
        breadcrumbs={[{ label: "Alertas", href: "/alerts" }, { label: "Regras de alerta" }]}
      />
      <div className="max-w-5xl space-y-4">
        <AlertSettings mode="platform" />
      </div>
    </>
  );
}
