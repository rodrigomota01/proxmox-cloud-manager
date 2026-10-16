"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon, type IconName } from "@/components/icons";
import { LogoMark } from "@/components/logo";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { logout } from "@/lib/auth/session";
import { LOCALES, useLocale, useT, type Locale } from "@/lib/i18n";
import { useCostVisibility } from "@/lib/queries";
import { SessionProvider, usePermissions, useSession } from "@/lib/session";

type NavItem = { href: string; label: string; also?: string[] };
type NavGroup = { key: string; label: string; icon: IconName; items: NavItem[] };

/** Navigation as the console groups it: one section per area, each item gated by role. */
function useNav(): { top: NavItem & { icon: IconName }; groups: NavGroup[] } {
  const t = useT();
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
  // per client: costs, resource usage only (no prices), or hidden
  const costs = useCostVisibility();
  const groups: NavGroup[] = [
    {
      key: "compute",
      label: t("nav.compute"),
      icon: "monitor",
      items: [
        { href: "/instances", label: t("nav.vms") },
        { href: "/ssh-keys", label: t("nav.sshKeys") },
        ...(admin ? [{ href: "/admin/images", label: t("nav.images") }] : []),
      ],
    },
    {
      key: "k8s",
      label: t("nav.kubernetes"),
      icon: "kubernetes",
      items: [
        ...(tenantId && (k8sLinked || admin) ? [{ href: "/kubernetes", label: admin ? t("nav.tenantClusters") : t("nav.clusters") }] : []),
        ...(admin ? [{ href: "/admin/kubernetes", label: t("nav.allClusters") }] : []),
      ],
    },
    {
      key: "observe",
      label: t("nav.observability"),
      icon: "bell",
      items: [
        { href: "/alerts", label: t("nav.alerts") },
        { href: "/history", label: t("nav.history") },
        ...(admin ? [{ href: "/admin/alerts", label: t("nav.alertRules") }] : []),
      ],
    },
    {
      key: "billing",
      label: admin || costs !== "usage" ? t("nav.costs") : t("nav.consumption"),
      icon: "coins",
      items: [
        // every tenant role sees the costs of its own projects (the page scopes them),
        // unless the client's costs are limited to usage or hidden
        ...(tenantId && costs && costs !== "none"
          ? [{ href: "/costs", label: costs === "usage" ? t("nav.resourceUsage") : t("nav.costsAndUsage") }]
          : []),
        ...(admin ? [{ href: "/admin/pricing", label: t("nav.pricing") }] : []),
      ],
    },
    {
      key: "access",
      label: admin ? t("nav.clientsAndAccess") : t("nav.organization"),
      icon: "users",
      items: [
        ...(admin ? [{ href: "/admin/tenants", label: t("nav.clientsAndQuotas") }] : []),
        ...(admin ? [{ href: "/admin/users", label: t("nav.users") }] : []),
        ...(tenantId ? [{ href: "/projects", label: t("nav.projects") }] : []),
        ...(tenantId && perms.has("member:manage") ? [{ href: "/members", label: t("nav.members") }] : []),
      ],
    },
    ...(admin
      ? [
          {
            key: "infra",
            label: t("nav.infrastructure"),
            icon: "server" as const,
            items: [
              { href: "/admin/nodes", label: t("nav.hypervisors"), also: ["/admin/clusters"] },
              { href: "/admin/regions", label: t("nav.regionsAndZones") },
            ],
          },
        ]
      : []),
  ];
  return {
    top: { href: "/dashboard", label: t("nav.overview"), icon: "dashboard" },
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
  const t = useT();
  const s = useAlertSummary();
  const firing = s?.firing ?? 0;
  return (
    <Link
      href="/alerts"
      className="relative rounded-md p-2 text-slate-300 hover:bg-white/10 hover:text-white"
      aria-label={
        firing
          ? t("header.activeAlerts", { count: firing }) +
            (s?.critical ? t("header.criticalAlerts", { count: s.critical }) : "")
          : t("header.alerts")
      }
      title={t("header.alerts")}
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
  const t = useT();
  const { tenants, tenantId, selectTenant } = useSession();
  if (tenants.length === 0) return <span className="text-sm text-slate-400">{t("header.noClient")}</span>;
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="hidden text-slate-400 sm:inline">{t("header.client")}</span>
      {tenants.length === 1 ? (
        <span className="truncate font-medium text-white">{tenants[0].name}</span>
      ) : (
        <span className="relative">
          <select
            aria-label={t("header.activeClient")}
            value={tenantId ?? ""}
            onChange={(e) => selectTenant(e.target.value)}
            className="max-w-[14rem] appearance-none truncate rounded-md border border-white/15 bg-white/5 py-1.5 pr-8 pl-3 text-sm font-medium text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-brand-400 [&>option]:text-slate-900"
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
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

/** Saved on the account (PATCH /me), so it follows the user to other devices and e-mails. */
function LanguageSwitch() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async (next: Locale) => unwrap(await api.PATCH("/api/v1/me", { body: { locale: next } })),
    onSuccess: (_, next) => {
      queryClient.setQueryData(["me"], (me: Schemas["MeResponse"] | undefined) => (me ? { ...me, locale: next } : me));
      setLocale(next);
    },
  });
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 text-sm" onClick={(e) => e.stopPropagation()}>
      <span className="flex items-center gap-2">
        <Icon name="globe" /> {t("common.language")}
      </span>
      <span className="flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
        {LOCALES.map((l) => (
          <button
            key={l.value}
            type="button"
            disabled={save.isPending}
            aria-pressed={locale === l.value}
            onClick={() => locale !== l.value && save.mutate(l.value)}
            className={`px-2 py-0.5 text-xs ${
              locale === l.value
                ? "bg-brand-600 text-white"
                : "hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
            title={l.label}
          >
            {l.value === "pt-BR" ? "PT" : "EN"}
          </button>
        ))}
      </span>
    </div>
  );
}

function UserMenu() {
  const t = useT();
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
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
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
            {isPlatformAdmin && <div className="mt-1 text-xs text-brand-600 dark:text-brand-400">{t("header.platformAdmin")}</div>}
          </div>
          <Link role="menuitem" href="/perfil" className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
            <Icon name="user" /> {t("header.myProfile")}
          </Link>
          <LanguageSwitch />
          <button
            role="menuitem"
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Icon name="logout" /> {t("header.signOut")}
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
  const t = useT();
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
        ? "border-accent-400 bg-white/10 font-medium text-white"
        : "border-transparent text-slate-300 hover:bg-white/5 hover:text-white"
    }`;
  const topActive = isActive(pathname, top);

  return (
    <nav className="flex flex-col gap-1 py-3" aria-label={t("nav.main")}>
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
  const t = useT();
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
          aria-label={t("nav.toggle")}
          className="rounded-md p-2 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <Link href="/dashboard" className="flex items-center gap-2 pr-2" aria-label="Cloud Manager System">
          <LogoMark className="h-6 w-auto" />
          <span className="hidden leading-none sm:flex sm:flex-col">
            <span className="text-sm font-semibold uppercase tracking-wide">Cloud Manager</span>
            <span className="mt-0.5 text-[0.55rem] font-medium uppercase tracking-[0.35em] text-accent-400">System</span>
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
            aria-label={t("nav.close")}
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
