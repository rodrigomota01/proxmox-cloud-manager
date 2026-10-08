"use client";

/** Tenant-scoped queries. Keys start with the resource and include the tenant. */
import { useQuery } from "@tanstack/react-query";

import { api, unwrap } from "@/lib/api/client";
import { useSession } from "@/lib/session";

export function useProjects() {
  const { tenantId } = useSession();
  return useQuery({
    queryKey: ["projects", tenantId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects", { params: { query: { limit: 200 } } })).items,
    enabled: tenantId !== null,
    staleTime: 60_000,
  });
}

export function useProjectNames(): Map<string, string> {
  const projects = useProjects();
  return new Map((projects.data ?? []).map((p) => [p.id, p.name]));
}

/** Admin: every zone, labelled "Region · Zone", for select inputs. */
export function useAdminZones() {
  const q = useQuery({
    queryKey: ["admin", "regions"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/regions")),
    staleTime: 60_000,
  });
  return (q.data ?? []).flatMap((r) =>
    r.zones.map((z) => ({ id: z.id, label: `${r.name} · ${z.name}`, active: r.active && z.active })),
  );
}

export type CostVisibility = "full" | "usage" | "none";

/** What this user sees of the client's billing: costs, resource usage only, or nothing.
 * Set per client by a platform admin; platform admins always get "full". */
export function useCostVisibility(): CostVisibility | undefined {
  const { tenantId } = useSession();
  const q = useQuery({
    queryKey: ["billing", "access", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/billing/access")).cost_visibility,
    enabled: tenantId !== null,
    staleTime: 60_000,
  });
  return q.data;
}
