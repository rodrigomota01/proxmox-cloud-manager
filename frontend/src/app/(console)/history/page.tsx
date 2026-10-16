"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ACTIVITY_FILTERS, ActivityRow } from "@/components/activity";
import { NoTenant } from "@/components/no-tenant";
import { PageHeader } from "@/components/page";
import { Button, Card, Empty, ErrorBox, Select } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";

type JobType = "instance.power" | "instance.create" | "instance.delete";
type Status = "pending" | "running" | "succeeded" | "failed";

export default function HistoryPage() {
  const { tenantId } = useSession();
  const t = useT();
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
    <>
      <PageHeader
        title={t("alerts.history.title")}
        description={t("alerts.history.description")}
        actions={
          <>
            <Select aria-label={t("alerts.history.type")} value={type} onChange={(e) => setType(e.target.value as JobType | "")}>
              {ACTIVITY_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {t(f.label)}
                </option>
              ))}
            </Select>
            <Select aria-label={t("alerts.history.status")} value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
              <option value="">{t("alerts.history.anyStatus")}</option>
              <option value="succeeded">{t("alerts.history.succeeded")}</option>
              <option value="failed">{t("alerts.history.failed")}</option>
              <option value="running">{t("alerts.history.running")}</option>
              <option value="pending">{t("alerts.history.pending")}</option>
            </Select>
          </>
        }
      />
      <div className="max-w-4xl space-y-4">
        <ErrorBox message={jobs.isError ? errorMessage(jobs.error) : null} />
        <Card>
          {jobs.isSuccess && items.length === 0 && <Empty>{t("alerts.history.empty")}</Empty>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((job) => (
              <ActivityRow key={job.id} job={job} />
            ))}
          </ul>
          {jobs.hasNextPage && (
            <div className="pt-4 text-center">
              <Button variant="secondary" onClick={() => jobs.fetchNextPage()} disabled={jobs.isFetchingNextPage}>
                {t("alerts.common.loadMore")}
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
