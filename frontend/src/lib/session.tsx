"use client";

/**
 * Session state for the console: who is logged in (/me), the active tenant (sent as
 * X-Tenant-Id by the API client) and permission lookups used only to hide UI actions —
 * the API enforces everything on its own.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api, setActiveTenant, unwrap, type Schemas } from "@/lib/api/client";
import { getAccessToken, onAuthChange, refresh } from "@/lib/auth/session";

type Me = Schemas["MeResponse"];

type SessionValue = {
  me: Me;
  /** memberships, plus every tenant for platform admins */
  tenants: Me["tenants"];
  tenantId: string | null;
  tenant: Me["tenants"][number] | null;
  selectTenant: (id: string) => void;
  isPlatformAdmin: boolean;
  /** platform admins: Dashboard/Alertas show the whole platform instead of the tenant */
  platformView: boolean;
  setPlatformView: (on: boolean) => void;
};

const SessionContext = createContext<SessionValue | null>(null);
const TENANT_KEY = "cm.tenant";
const PLATFORM_VIEW_KEY = "cm.platformView";

function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

function storedTenant(): string | null {
  try {
    return window.localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

/** Ensures there is a session (silent refresh on reload), else sends to /login. */
function useAuthenticated(): boolean {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(() => getAccessToken() !== null);

  useEffect(() => {
    let alive = true;
    const toLogin = () => router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (!getAccessToken()) {
      refresh().then((token) => {
        if (!alive) return;
        if (token) setReady(true);
        else toLogin();
      });
    }
    const off = onAuthChange((token) => {
      if (!token && alive) toLogin();
    });
    return () => {
      alive = false;
      off();
    };
  }, [router, pathname]);

  return ready;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const authenticated = useAuthenticated();
  const queryClient = useQueryClient();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [platformView, setPlatformViewState] = useState(() => {
    try {
      return window.localStorage.getItem(PLATFORM_VIEW_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setPlatformView = useCallback((on: boolean) => {
    remember(PLATFORM_VIEW_KEY, on ? "1" : "0");
    setPlatformViewState(on);
  }, []);

  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => unwrap(await api.GET("/api/v1/me")),
    enabled: authenticated,
    staleTime: 60_000,
  });

  const isPlatformAdmin = !!me.data?.platform_roles.some((r) =>
    ["SUPER_ADMIN", "PLATFORM_ADMIN"].includes(r),
  );
  // platform admins may act in any tenant (the API audits it as PLATFORM_SCOPE_ACCESS)
  const allTenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
    enabled: isPlatformAdmin,
    staleTime: 60_000,
  });
  const tenants = useMemo(() => {
    const byId = new Map((me.data?.tenants ?? []).map((t) => [t.id, t]));
    for (const t of allTenants.data ?? []) {
      if (!byId.has(t.id)) byId.set(t.id, { id: t.id, slug: t.slug, name: t.name, status: t.status });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [me.data, allTenants.data]);

  // pick the stored tenant if still reachable, else the first one
  useEffect(() => {
    if (!me.data) return;
    const ids = tenants.map((t) => t.id);
    const preferred = storedTenant();
    const next = preferred && ids.includes(preferred) ? preferred : (ids[0] ?? null);
    setActiveTenant(next);
    setTenantId(next);
  }, [me.data, tenants]);

  const selectTenant = useCallback(
    (id: string) => {
      remember(TENANT_KEY, id);
      setPlatformView(false); // picking a tenant means "show me this tenant"
      setActiveTenant(id);
      setTenantId(id);
      // everything tenant-scoped is now stale
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
    [queryClient, setPlatformView],
  );

  const value = useMemo<SessionValue | null>(() => {
    if (!me.data) return null;
    const tenant = tenants.find((t) => t.id === tenantId) ?? null;
    return {
      me: me.data, tenants, tenantId, tenant, selectTenant, isPlatformAdmin,
      platformView: isPlatformAdmin && (platformView || tenantId === null), setPlatformView,
    };
  }, [me.data, tenants, tenantId, selectTenant, isPlatformAdmin, platformView, setPlatformView]);

  if (!value) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Carregando…
      </div>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

/** Permissions at a scope ("platform" | "tenant:<id>" | "project:<id>"), for hiding UI. */
export function usePermissions(scope: string | null): Set<string> {
  const { tenantId } = useSession();
  const query = useQuery({
    queryKey: ["permissions", tenantId, scope],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/me/permissions", { params: { query: { scope: scope! } } }))
        .permissions,
    enabled: scope !== null,
    staleTime: 30_000,
  });
  return useMemo(() => new Set(query.data ?? []), [query.data]);
}
