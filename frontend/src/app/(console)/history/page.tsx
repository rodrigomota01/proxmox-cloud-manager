"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ACTIVITY_FILTERS, ActivityRow } from "@/components/activity";
import { NoTenant } from "@/components/no-tenant";
import { Button, Card, Empty, ErrorBox, Select } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useSession } from "@/lib/session";

type JobType = "instance.power" | "instance.create" | "instance.delete";
type Status = "pending" | "running" | "succeeded" | "failed";

export default function HistoryPage() {
  const { tenantId } = useSession();
  const [type, setType] = useState<JobType | "">("");
  const [status, setStatus] = useState<Status | "">("");

  const jobs = useInfiniteQuery({
    queryKey: ["jobs", tenantId, "history", type, status],
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET("/api/v1/jobs", {
          params: {
            query: {
              limit: 30,
              cursor: pageParam ?? undefined,
              type: type || undefined,
              status: status || undefined,
            },
          },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    enabled: tenantId !== null,
    refetchInterval: 10_000,
  });

  if (!tenantId) return <NoTenant />;
  const items = jobs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Histórico de operações</h1>
        <div className="flex gap-2">
          <Select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value as JobType | "")}>
            {ACTIVITY_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
          <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
            <option value="">Qualquer situação</option>
            <option value="succeeded">Concluídas</option>
            <option value="failed">Falharam</option>
            <option value="running">Executando</option>
            <option value="pending">Na fila</option>
          </Select>
        </div>
      </div>
      <ErrorBox message={jobs.isError ? errorMessage(jobs.error) : null} />
      <Card>
        {jobs.isSuccess && items.length === 0 && <Empty>Nenhuma operação encontrada.</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((job) => (
            <ActivityRow key={job.id} job={job} />
          ))}
        </ul>
        {jobs.hasNextPage && (
          <div className="pt-4 text-center">
            <Button variant="secondary" onClick={() => jobs.fetchNextPage()} disabled={jobs.isFetchingNextPage}>
              Carregar mais
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
