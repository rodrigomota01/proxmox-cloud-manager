"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Logo } from "@/components/logo";
import { Button, Select } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { logout } from "@/lib/auth/session";
import { SessionProvider, usePermissions, useSession } from "@/lib/session";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/instances", label: "Instâncias" },
  { href: "/alerts", label: "Alertas" },
  { href: "/history", label: "Histórico" },
  { href: "/ssh-keys", label: "Chaves SSH" },
];
const ADMIN_NAV = [
  { href: "/admin/nodes", label: "Hypervisors" },
  { href: "/admin/regions", label: "Regiões e zonas" },
  { href: "/admin/images", label: "Imagens" },
  { href: "/admin/kubernetes", label: "Kubernetes" },
  { href: "/admin/alerts", label: "Regras de alerta" },
  { href: "/admin/tenants", label: "Clientes e quotas" },
  { href: "/admin/pricing", label: "Preços" },
  { href: "/admin/users", label: "Usuários" },
];

/** Firing alerts in view: the tenant's (as its members see them) or, for platform
 * admins in the whole-platform view, everything. */
function AlertCount() {
  const { tenantId, platformView } = useSession();
  const summary = useQuery({
    queryKey: ["alerts-summary", platformView, tenantId],
    queryFn: async () =>
      platformView
        ? unwrap(await api.GET("/api/v1/admin/alerts/summary"))
        : unwrap(await api.GET("/api/v1/alerts/summary")),
    enabled: platformView || tenantId !== null,
    refetchInterval: 30_000,
  });
  const s = summary.data;
  if (!s?.firing) return null;
  return (
    <span
      className={`ml-auto rounded-full px-1.5 text-xs font-semibold tabular-nums ${
        s.critical ? "bg-rose-600 text-white" : "bg-amber-400 text-slate-900"
      }`}
      aria-label={`${s.firing} alertas ativos${s.critical ? `, ${s.critical} críticos` : ""}`}
    >
      {s.firing}
    </span>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`flex items-center rounded-md px-3 py-1.5 text-sm ${
        active
          ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {label}
      {href === "/alerts" && <AlertCount />}
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { me, tenants, tenantId, selectTenant, isPlatformAdmin } = useSession();
  const tenantPerms = usePermissions(tenantId ? `tenant:${tenantId}` : null);

  async function signOut() {
    await logout();
    router.replace("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="px-3 pb-5">
          <Logo />
        </div>
        <nav className="space-y-1">
          {NAV.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}
        </nav>
        {tenantId && (
          <>
            <div className="mt-6 px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Organização
            </div>
            <nav className="space-y-1">
              <NavLink href="/projects" label="Projetos" />
              {tenantPerms.has("member:manage") && <NavLink href="/members" label="Membros" />}
              {(tenantPerms.has("billing:view") || isPlatformAdmin) && <NavLink href="/costs" label="Custos" />}
            </nav>
          </>
        )}
        {isPlatformAdmin && (
          <>
            <div className="mt-6 px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Plataforma
            </div>
            <nav className="space-y-1">
              {ADMIN_NAV.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </nav>
          </>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Tenant</span>
            {tenants.length === 1 ? (
              <span className="font-medium">{tenants[0].name}</span>
            ) : tenants.length > 0 ? (
              <Select
                aria-label="Tenant ativo"
                value={tenantId ?? ""}
                onChange={(e) => selectTenant(e.target.value)}
              >
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="text-slate-500">nenhum</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/perfil" className="text-slate-600 hover:underline dark:text-slate-400">
              {me.display_name}
            </Link>
            <Button variant="ghost" onClick={signOut}>
              Sair
            </Button>
          </div>
        </header>
        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
