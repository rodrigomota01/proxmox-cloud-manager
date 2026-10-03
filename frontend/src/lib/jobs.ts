"use client";

/**
 * Follows a job until it finishes (polling; WebSocket events arrive in Phase 3), then
 * invalidates the queries that depend on its outcome.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { api, unwrap } from "@/lib/api/client";

const ACTIVE = new Set(["pending", "running"]);

export function useJob(
  jobId: string | null,
  { admin = false, invalidate = [] as readonly (readonly unknown[])[] } = {},
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["job", admin, jobId],
    queryFn: async () =>
      admin
        ? unwrap(await api.GET("/api/v1/admin/jobs/{job_id}", { params: { path: { job_id: jobId! } } }))
        : unwrap(await api.GET("/api/v1/jobs/{job_id}", { params: { path: { job_id: jobId! } } })),
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data && !ACTIVE.has(q.state.data.status) ? false : 1000),
  });

  const status = query.data?.status;
  const done = status !== undefined && !ACTIVE.has(status);
  useEffect(() => {
    if (done) invalidate.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
  }, [done]); // once, when the job ends

  return { job: query.data, done };
}
