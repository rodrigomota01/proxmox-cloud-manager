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
  tenantId: string | null;
  tenant: Me["tenants"][number] | null;
  selectTenant: (id: string) => void;
  isPlatformAdmin: boolean;
};

const SessionContext = createContext<SessionValue | null>(null);
const TENANT_KEY = "cm.tenant";

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

  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => unwrap(await api.GET("/api/v1/me")),
    enabled: authenticated,
    staleTime: 60_000,
  });

  // pick the stored tenant if still a member, else the first one
  useEffect(() => {
    if (!me.data) return;
    const ids = me.data.tenants.map((t) => t.id);
    const preferred = storedTenant();
    const next = preferred && ids.includes(preferred) ? preferred : (ids[0] ?? null);
    setActiveTenant(next);
    setTenantId(next);
  }, [me.data]);

  const selectTenant = useCallback(
    (id: string) => {
      try {
        window.localStorage.setItem(TENANT_KEY, id);
      } catch {
        /* storage unavailable: selection lasts for this page only */
      }
      setActiveTenant(id);
      setTenantId(id);
      // everything tenant-scoped is now stale
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
    [queryClient],
  );

  const value = useMemo<SessionValue | null>(() => {
    if (!me.data) return null;
    const tenant = me.data.tenants.find((t) => t.id === tenantId) ?? null;
    return {
      me: me.data,
      tenantId,
      tenant,
      selectTenant,
      isPlatformAdmin: me.data.platform_roles.some((r) =>
        ["SUPER_ADMIN", "PLATFORM_ADMIN"].includes(r),
      ),
    };
  }, [me.data, tenantId, selectTenant]);

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
