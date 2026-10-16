"use client";

import Link from "next/link";

import { Card } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";

/** Users without memberships (e.g. a fresh platform admin) have no tenant to show. */
export function NoTenant() {
  const t = useT();
  const { isPlatformAdmin } = useSession();
  return (
    <Card title={t("compute.noTenant.title")}>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {t("compute.noTenant.body")}
        {isPlatformAdmin ? (
          <>
            {" "}
            {t("compute.noTenant.adminBefore")}{" "}
            <Link href="/admin/nodes" className="text-brand-600 hover:underline dark:text-brand-400">
              {t("compute.noTenant.adminLink")}
            </Link>
            .
          </>
        ) : (
          ` ${t("compute.noTenant.askAdmin")}`
        )}
      </p>
    </Card>
  );
}
