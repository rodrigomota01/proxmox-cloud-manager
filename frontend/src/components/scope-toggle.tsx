"use client";

import { useSession } from "@/lib/session";

/** Platform admins: the tenant chosen in the header, or the whole platform. */
export function ScopeToggle() {
  const { isPlatformAdmin, tenant, platformView, setPlatformView } = useSession();
  if (!isPlatformAdmin) return null;
  const option = (on: boolean, label: string) => (
    <button
      type="button"
      onClick={() => setPlatformView(on)}
      disabled={!on && !tenant}
      aria-pressed={platformView === on}
      className={`rounded-md px-3 py-1 text-sm ${
        platformView === on
          ? "bg-white font-medium shadow-sm dark:bg-slate-700"
          : "text-slate-600 hover:text-slate-900 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-100"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800" role="group" aria-label="Escopo">
      {option(false, tenant ? `Cliente ${tenant.name}` : "Nenhum cliente")}
      {option(true, "Toda a plataforma")}
    </div>
  );
}
