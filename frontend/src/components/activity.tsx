"use client";

/** One line of activity history: who did what to which resource, when, and how it went. */
import Link from "next/link";

import { JobBadge, formatDate } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";
import { getLocale, translate, useT, type MessageKey } from "@/lib/i18n";

type Job = Schemas["JobOut"];

const POWER: Record<string, MessageKey> = {
  start: "alerts.activity.start",
  shutdown: "alerts.activity.shutdown",
  stop: "alerts.activity.stop",
  reboot: "alerts.activity.reboot",
  suspend: "alerts.activity.suspend",
  resume: "alerts.activity.resume",
};
const TYPE: Record<string, MessageKey> = {
  "instance.create": "alerts.activity.create",
  "instance.delete": "alerts.activity.delete",
  "cluster.sync": "alerts.activity.clusterSync",
  "alert.notify": "alerts.activity.alertNotify",
};

/** Call while rendering: the text follows the current language. */
export function actionLabel(job: Job): string {
  if (job.type === "instance.power")
    return translate(POWER[String(job.payload.action ?? "")] ?? "alerts.activity.power");
  return TYPE[job.type] ? translate(TYPE[job.type]) : job.type;
}

/** Labels are message keys, translated where the options are rendered. */
export const ACTIVITY_FILTERS = [
  { value: "", label: "alerts.activity.filterAll" },
  { value: "instance.power", label: "alerts.activity.filterPower" },
  { value: "instance.create", label: "alerts.activity.filterCreate" },
  { value: "instance.delete", label: "alerts.activity.filterDelete" },
] as const satisfies readonly { value: string; label: MessageKey }[];

export function relativeTime(value: string): string {
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return translate("alerts.activity.justNow");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 86_400 * 7) return rtf.format(Math.round(seconds / 86_400), "day");
  return formatDate(value);
}

export function duration(job: Job): string | null {
  if (!job.started_at || !job.finished_at) return null;
  const s = Math.max(0, Math.round((Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`;
}

export function ActivityRow({ job, showResource = true }: { job: Job; showResource?: boolean }) {
  const t = useT();
  const took = duration(job);
  const isInstance = job.resource_type === "instance" && job.resource_id;
  const gone = job.type === "instance.delete" && job.status === "succeeded";
  return (
    <li className="flex items-start justify-between gap-4 py-3 text-sm">
      <div className="min-w-0">
        <div>
          <span className="font-medium">{actionLabel(job)}</span>
          {showResource && job.resource_name && (
            <>
              {" "}
              {isInstance && !gone ? (
                <Link
                  href={`/instances/${job.resource_id}`}
                  className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  {job.resource_name}
                </Link>
              ) : (
                <span className="font-medium">{job.resource_name}</span>
              )}
            </>
          )}
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          {job.requested_by_name ?? t("alerts.activity.system")} ·{" "}
          <time dateTime={job.created_at} title={formatDate(job.created_at)}>
            {relativeTime(job.created_at)}
          </time>
          {took && <> · {t("alerts.activity.took", { duration: took })}</>}
          {job.attempts > 1 && <> · {t("alerts.activity.attempts", { count: job.attempts })}</>}
        </div>
        {job.status === "failed" && job.error_message && (
          <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">{job.error_message}</div>
        )}
      </div>
      <JobBadge status={job.status} />
    </li>
  );
}
