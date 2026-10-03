"use client";

import Link from "next/link";

import { AlertSettings } from "@/components/alerts";
import { NoTenant } from "@/components/no-tenant";
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
    <div className="max-w-5xl space-y-4">
      <Link href="/alerts" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Alertas
      </Link>
      <h1 className="text-lg font-semibold">Regras e canais de {tenant?.name}</h1>
      <AlertSettings mode="tenant" />
    </div>
  );
}
