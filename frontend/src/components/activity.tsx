"use client";

/** One line of activity history: who did what to which resource, when, and how it went. */
import Link from "next/link";

import { JobBadge, formatDate } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";

type Job = Schemas["JobOut"];

const POWER: Record<string, string> = {
  start: "Ligou",
  shutdown: "Desligou",
  stop: "Forçou o desligamento de",
  reboot: "Reiniciou",
  suspend: "Suspendeu",
  resume: "Retomou",
};
const TYPE: Record<string, string> = {
  "instance.create": "Criou",
  "instance.delete": "Excluiu",
  "cluster.sync": "Sincronizou o cluster",
  "alert.notify": "Testou o canal de notificação",
};

export function actionLabel(job: Job): string {
  if (job.type === "instance.power") return POWER[String(job.payload.action ?? "")] ?? "Alterou a energia de";
  return TYPE[job.type] ?? job.type;
}

export const ACTIVITY_FILTERS = [
  { value: "", label: "Todas as operações" },
  { value: "instance.power", label: "Energia" },
  { value: "instance.create", label: "Criações" },
  { value: "instance.delete", label: "Exclusões" },
] as const;

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "agora há pouco";
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
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
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
          {job.requested_by_name ?? "sistema"} ·{" "}
          <time dateTime={job.created_at} title={formatDate(job.created_at)}>
            {relativeTime(job.created_at)}
          </time>
          {took && <> · levou {took}</>}
          {job.attempts > 1 && <> · {job.attempts} tentativas</>}
        </div>
        {job.status === "failed" && job.error_message && (
          <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">{job.error_message}</div>
        )}
      </div>
      <JobBadge status={job.status} />
    </li>
  );
}
