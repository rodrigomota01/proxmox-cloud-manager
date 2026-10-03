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
