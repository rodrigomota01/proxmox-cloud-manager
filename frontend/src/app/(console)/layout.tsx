"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon, type IconName } from "@/components/icons";
import { LogoMark } from "@/components/logo";
import { api, unwrap } from "@/lib/api/client";
import { logout } from "@/lib/auth/session";
import { SessionProvider, usePermissions, useSession } from "@/lib/session";

type NavItem = { href: string; label: string; also?: string[] };
type NavGroup = { key: string; label: string; icon: IconName; items: NavItem[] };

/** Navigation as the console groups it: one section per area, each item gated by role. */
function useNav(): { top: NavItem & { icon: IconName }; groups: NavGroup[] } {
  const { tenantId, isPlatformAdmin } = useSession();
  const perms = usePermissions(tenantId ? `tenant:${tenantId}` : null);
  const admin = isPlatformAdmin;
  // the Kubernetes entry shows up for a client only once a cluster is linked to it
  const linked = useQuery({
    queryKey: ["k8s-clusters", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/kubernetes/clusters")),
    enabled: tenantId !== null,
    staleTime: 60_000,
  });
  const k8sLinked = (linked.data?.length ?? 0) > 0;
  const groups: NavGroup[] = [
    {
      key: "compute",
      label: "Computação",
      icon: "monitor",
      items: [
        { href: "/instances", label: "Máquinas virtuais" },
        { href: "/ssh-keys", label: "Chaves SSH" },
        ...(admin ? [{ href: "/admin/images", label: "Imagens" }] : []),
      ],
    },
    {
      key: "k8s",
      label: "Kubernetes",
      icon: "kubernetes",
      items: [
        ...(tenantId && (k8sLinked || admin) ? [{ href: "/kubernetes", label: admin ? "Clusters do cliente" : "Clusters" }] : []),
        ...(admin ? [{ href: "/admin/kubernetes", label: "Todos os clusters" }] : []),
      ],
    },
    {
      key: "observe",
      label: "Observabilidade",
      icon: "bell",
      items: [
        { href: "/alerts", label: "Alertas" },
        { href: "/history", label: "Histórico" },
        ...(admin ? [{ href: "/admin/alerts", label: "Regras de alerta" }] : []),
      ],
    },
    {
      key: "billing",
      label: "Custos",
      icon: "coins",
      items: [
        // every tenant role sees the costs of its own projects (the page scopes them)
        ...(tenantId ? [{ href: "/costs", label: "Custos" }] : []),
        ...(admin ? [{ href: "/admin/pricing", label: "Tabelas de preço" }] : []),
      ],
    },
    {
      key: "access",
      label: admin ? "Clientes e acesso" : "Organização",
      icon: "users",
      items: [
        ...(admin ? [{ href: "/admin/tenants", label: "Clientes e quotas" }] : []),
        ...(admin ? [{ href: "/admin/users", label: "Usuários" }] : []),
        ...(tenantId ? [{ href: "/projects", label: "Projetos" }] : []),
        ...(tenantId && perms.has("member:manage") ? [{ href: "/members", label: "Membros" }] : []),
      ],
    },
    ...(admin
      ? [
          {
            key: "infra",
            label: "Infraestrutura",
            icon: "server" as const,
            items: [
              { href: "/admin/nodes", label: "Hypervisors", also: ["/admin/clusters"] },
              { href: "/admin/regions", label: "Regiões e zonas" },
            ],
          },
        ]
      : []),
  ];
  return {
    top: { href: "/dashboard", label: "Visão geral", icon: "dashboard" },
    groups: groups.filter((g) => g.items.length > 0),
  };
}

const isActive = (pathname: string, item: NavItem) =>
  [item.href, ...(item.also ?? [])].some((h) => pathname === h || pathname.startsWith(`${h}/`));

/** Firing alerts in view: the tenant's (as its members see them) or, for platform
 * admins in the whole-platform view, everything. */
function useAlertSummary() {
  const { tenantId, platformView } = useSession();
  return useQuery({
    queryKey: ["alerts-summary", platformView, tenantId],
    queryFn: async () =>
      platformView
        ? unwrap(await api.GET("/api/v1/admin/alerts/summary"))
        : unwrap(await api.GET("/api/v1/alerts/summary")),
    enabled: platformView || tenantId !== null,
    refetchInterval: 30_000,
  }).data;
}

function AlertBell() {
  const s = useAlertSummary();
  const firing = s?.firing ?? 0;
  return (
    <Link
      href="/alerts"
      className="relative rounded-md p-2 text-slate-300 hover:bg-white/10 hover:text-white"
      aria-label={firing ? `${firing} alertas ativos${s?.critical ? `, ${s.critical} críticos` : ""}` : "Alertas"}
      title="Alertas"
    >
      <Icon name="bell" className="h-5 w-5" />
      {firing > 0 && (
        <span
          className={`absolute -top-0.5 -right-0.5 min-w-[1.1rem] rounded-full px-1 text-center text-[10px] font-bold leading-[1.1rem] tabular-nums ${
            s?.critical ? "bg-rose-600 text-white" : "bg-amber-400 text-slate-900"
          }`}
        >
          {firing}
        </span>
      )}
    </Link>
  );
}

function TenantSwitcher() {
  const { tenants, tenantId, selectTenant } = useSession();
  if (tenants.length === 0) return <span className="text-sm text-slate-400">Nenhum cliente</span>;
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="hidden text-slate-400 sm:inline">Cliente</span>
      {tenants.length === 1 ? (
        <span className="truncate font-medium text-white">{tenants[0].name}</span>
      ) : (
        <span className="relative">
          <select
            aria-label="Cliente ativo"
            value={tenantId ?? ""}
            onChange={(e) => selectTenant(e.target.value)}
            className="max-w-[14rem] appearance-none truncate rounded-md border border-white/15 bg-white/5 py-1.5 pr-8 pl-3 text-sm font-medium text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400 [&>option]:text-slate-900"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-slate-400">
            <Icon name="chevronDown" className="h-3.5 w-3.5" />
          </span>
        </span>
      )}
    </label>
  );
}

function UserMenu() {
  const router = useRouter();
  const { me, isPlatformAdmin } = useSession();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const initials = me.display_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  async function signOut() {
    await logout();
    router.replace("/login");
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md py-1 pr-2 pl-1 text-sm text-slate-200 hover:bg-white/10"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">
          {initials}
        </span>
        <span className="hidden max-w-[10rem] truncate md:inline">{me.display_name}</span>
        <Icon name="chevronDown" className="h-3.5 w-3.5 text-slate-400" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-60 rounded-md border border-slate-200 bg-white py-1 text-slate-800 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          <div className="border-b border-slate-100 px-4 py-2 dark:border-slate-800">
            <div className="truncate text-sm font-medium">{me.display_name}</div>
            <div className="truncate text-xs text-slate-500">{me.email}</div>
            {isPlatformAdmin && <div className="mt-1 text-xs text-indigo-600 dark:text-indigo-400">Administrador da plataforma</div>}
          </div>
          <Link role="menuitem" href="/perfil" className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
            <Icon name="user" /> Meu perfil
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Icon name="logout" /> Sair
          </button>
        </div>
      )}
    </div>
  );
}

const GROUPS_KEY = "cm.nav.closed";

function readClosed(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(GROUPS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const { top, groups } = useNav();
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => setClosed(readClosed()), []);
  const toggle = (key: string) => {
    const next = closed.includes(key) ? closed.filter((k) => k !== key) : [...closed, key];
    setClosed(next);
    try {
      window.localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  };
  const linkCls = (active: boolean) =>
    `flex items-center gap-2 border-l-[3px] py-2 pr-3 text-sm transition-colors ${
      active
        ? "border-indigo-400 bg-white/10 font-medium text-white"
        : "border-transparent text-slate-300 hover:bg-white/5 hover:text-white"
    }`;
  const topActive = isActive(pathname, top);

  return (
    <nav className="flex flex-col gap-1 py-3" aria-label="Navegação principal">
      <Link href={top.href} onClick={onNavigate} className={`${linkCls(topActive)} pl-4`} aria-current={topActive ? "page" : undefined}>
        <Icon name={top.icon} className="h-[18px] w-[18px]" />
        {top.label}
      </Link>
      {groups.map((g) => {
        const hasActive = g.items.some((i) => isActive(pathname, i));
        // a group holding the current page never collapses
        const open = hasActive || !closed.includes(g.key);
        return (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => toggle(g.key)}
              aria-expanded={open}
              className={`flex w-full items-center gap-2 border-l-[3px] border-transparent py-2 pr-3 pl-4 text-left text-sm hover:bg-white/5 hover:text-white ${
                hasActive ? "font-medium text-white" : "text-slate-300"
              }`}
            >
              <Icon name={g.icon} className="h-[18px] w-[18px]" />
              <span className="flex-1">{g.label}</span>
              <Icon name={open ? "chevronDown" : "chevronRight"} className="h-3.5 w-3.5 text-slate-400" />
            </button>
            {open && (
              <ul className="mb-1">
                {g.items.map((item) => {
                  const active = isActive(pathname, item);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={`${linkCls(active)} pl-11`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // desktop: sidebar shown unless collapsed; mobile: hidden unless opened
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-black/30 bg-slate-950 px-3 text-white">
        <button
          type="button"
          onClick={() => {
            if (window.matchMedia("(min-width: 1024px)").matches) setCollapsed((c) => !c);
            else setMobileOpen((o) => !o);
          }}
          aria-label="Mostrar ou ocultar navegação"
          className="rounded-md p-2 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <Link href="/dashboard" className="flex items-center gap-2 pr-2" aria-label="Cloud Manager System">
          <LogoMark className="h-6 w-auto" />
          <span className="hidden leading-none sm:flex sm:flex-col">
            <span className="text-sm font-semibold uppercase tracking-wide">Cloud Manager</span>
            <span className="mt-0.5 text-[0.55rem] font-medium uppercase tracking-[0.35em] text-sky-400">System</span>
          </span>
        </Link>
        <span className="hidden h-6 w-px bg-white/15 sm:block" />
        <TenantSwitcher />
        <div className="ml-auto flex items-center gap-1">
          <AlertBell />
          <UserMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {mobileOpen && (
          <button
            type="button"
            aria-label="Fechar navegação"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 top-14 z-20 bg-slate-950/50 lg:hidden"
          />
        )}
        <aside
          className={`fixed top-14 bottom-0 z-20 w-64 shrink-0 overflow-y-auto bg-slate-900 transition-transform lg:sticky lg:h-[calc(100vh-3.5rem)] lg:translate-x-0 dark:border-r dark:border-slate-800 ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          } ${collapsed ? "lg:hidden" : ""}`}
        >
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </aside>
        <main className="min-w-0 flex-1 bg-slate-100 px-4 py-6 sm:px-6 dark:bg-slate-950">{children}</main>
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
