"use client";

import Link from "next/link";

import { Card } from "@/components/ui";
import { useSession } from "@/lib/session";

/** Users without memberships (e.g. a fresh platform admin) have no tenant to show. */
export function NoTenant() {
  const { isPlatformAdmin } = useSession();
  return (
    <Card title="Nenhum tenant">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Você ainda não é membro de nenhum tenant.
        {isPlatformAdmin ? (
          <>
            {" "}
            Como administrador da plataforma, comece pelos{" "}
            <Link href="/admin/nodes" className="text-indigo-600 hover:underline dark:text-indigo-400">
              hypervisors
            </Link>
            .
          </>
        ) : (
          " Peça acesso a um administrador."
        )}
      </p>
    </Card>
  );
}
