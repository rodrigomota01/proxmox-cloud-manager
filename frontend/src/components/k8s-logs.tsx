"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/icons";
import { SearchInput } from "@/components/page";
import { Alert, Button, Dialog, ErrorBox, Select } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";

/** What the logs dialog opens on: one pod (with its workload, when it has one, so the
 * other pods can be added) or a whole workload. */
export type LogTarget = { namespace: string; workload: string | null; pod: string | null };

type Logs = Schemas["K8sLogsOut"];

const TAILS = [100, 500, 1000, 5000];
const SINCE: [number | null, string][] = [
  [null, ""], [300, "5 min"], [900, "15 min"], [3600, "1 h"], [6 * 3600, "6 h"], [86400, "24 h"],
];
const COLORS = [
  "text-sky-400", "text-emerald-400", "text-amber-400", "text-fuchsia-400", "text-cyan-400",
  "text-lime-400", "text-orange-400", "text-violet-400", "text-rose-400", "text-teal-400",
];

/** "2026-10-16T10:00:00.123456789Z" -> local "10:00:00.123" (Date takes 3 fraction digits). */
function clock(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts.replace(/(\.\d{3})\d+/, "$1"));
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function PodLogs({
  clusterId,
  target,
  workloadPods,
  onClose,
}: {
  clusterId: string;
  target: LogTarget;
  /** the workload's pods as the last collection saw them; the live read adds the new ones */
  workloadPods: string[];
  onClose: () => void;
}) {
  const t = useT();
  // null: every pod of the workload; otherwise the pods picked
  const [picked, setPicked] = useState<string[] | null>(target.pod ? [target.pod] : null);
  const [container, setContainer] = useState("");
  const [tail, setTail] = useState(500);
  const [since, setSince] = useState<number | null>(null);
  const [previous, setPrevious] = useState(false);
  const [stamps, setStamps] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [q, setQ] = useState("");
  const [seen, setSeen] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);

  const query = {
    namespace: target.namespace,
    ...(picked === null ? { workload: target.workload ?? "" } : { pod: picked }),
    ...(container && { container }),
    tail_lines: tail,
    ...(since && { since_seconds: since }),
    previous,
  };
  const logs = useQuery({
    queryKey: ["admin", "k8s-logs", clusterId, query],
    queryFn: async (): Promise<Logs> =>
      unwrap(
        await api.GET("/api/v1/admin/kubernetes/clusters/{cluster_id}/logs", {
          params: { path: { cluster_id: clusterId }, query },
        }),
      ),
    // every read goes to the cluster and to the audit trail: only when asked
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const data = logs.data;

  useEffect(() => {
    if (!data) return;
    setSeen((s) => [...new Set([...s, ...data.pods.map((p) => p.name)])]);
  }, [data]);

  // the chips: the workload's pods (stable order, stable colours)
  const chips = useMemo(
    () => (target.workload ? [...new Set([...workloadPods, ...seen])].sort() : seen),
    [target.workload, workloadPods, seen],
  );
  const color = (pod: string) => COLORS[Math.max(chips.indexOf(pod), 0) % COLORS.length];
  const containers = useMemo(() => [...new Set((data?.pods ?? []).flatMap((p) => p.containers))], [data]);
  const lines = useMemo(() => {
    const needle = q.toLowerCase();
    return (data?.lines ?? []).filter((l) => !needle || l.text.toLowerCase().includes(needle));
  }, [data, q]);
  const many = (data?.pods.length ?? 0) > 1;

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data]);

  const pick = (pod: string, add: boolean) => {
    if (!add) return setPicked(picked?.length === 1 && picked[0] === pod ? null : [pod]);
    const current = picked ?? chips;
    const next = current.includes(pod) ? current.filter((p) => p !== pod) : [...current, pod];
    setPicked(next.length === 0 || (target.workload && next.length === chips.length) ? null : next);
  };

  const download = () => {
    const text = lines.map((l) => `${l.ts ?? ""} ${many ? `[${l.pod}] ` : ""}${l.text}`).join("\n");
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${(target.workload ?? target.pod ?? "logs").replace("/", "-").toLowerCase()}.log`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  const name = target.workload && picked === null ? target.workload : (picked ?? []).join(", ");
  return (
    <Dialog open onClose={onClose} title={t("k8s.logs.title", { name: `${target.namespace}/${name}` })} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            {t("k8s.logs.container")}
            <Select value={container} onChange={(e) => setContainer(e.target.value)}>
              <option value="">{t("k8s.logs.defaultContainer")}</option>
              {[...new Set([...containers, ...(container ? [container] : [])])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            {t("k8s.logs.lines")}
            <Select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              {TAILS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            {t("k8s.logs.since")}
            <Select value={since ?? ""} onChange={(e) => setSince(e.target.value ? Number(e.target.value) : null)}>
              {SINCE.map(([v, label]) => (
                <option key={v ?? ""} value={v ?? ""}>
                  {label || t("k8s.logs.sinceAll")}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-1.5" title={t("k8s.logs.previousHint")}>
            <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
            {t("k8s.logs.previous")}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={stamps} onChange={(e) => setStamps(e.target.checked)} />
            {t("k8s.logs.timestamps")}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            {t("k8s.logs.wrap")}
          </label>
          <span className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={() => logs.refetch()} disabled={logs.isFetching}>
              <Icon name="refresh" className={`h-4 w-4 ${logs.isFetching ? "animate-spin" : ""}`} />
              {t("k8s.logs.refresh")}
            </Button>
            <Button variant="secondary" onClick={download} disabled={!lines.length}>
              <Icon name="download" />
              {t("k8s.logs.download")}
            </Button>
          </span>
        </div>

        {target.workload && chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs" title={t("k8s.logs.podsHint")}>
            <span className="mr-1 text-slate-500">{t("k8s.logs.pods")}:</span>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className={`rounded-full border px-2.5 py-0.5 ${picked === null ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300" : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"}`}
            >
              {t("k8s.logs.allPods")} ({chips.length})
            </button>
            {chips.map((pod) => {
              const on = picked === null || picked.includes(pod);
              const info = data?.pods.find((p) => p.name === pod);
              return (
                <button
                  key={pod}
                  type="button"
                  onClick={(e) => pick(pod, e.ctrlKey || e.metaKey)}
                  title={info?.error ?? `${info?.status ?? ""} · ${info?.lines ?? 0}`}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono ${on ? "border-slate-400 bg-slate-900 text-slate-100 dark:border-slate-600" : "border-slate-300 text-slate-400 line-through dark:border-slate-700"}`}
                >
                  <span className={`text-[0.6rem] ${on ? color(pod) : ""}`}>●</span>
                  {pod}
                  {info?.error && <Icon name="warning" className="h-3 w-3 text-amber-500" />}
                </button>
              );
            })}
          </div>
        )}

        {logs.isError && <ErrorBox message={errorMessage(logs.error)} />}
        {data?.pods_truncated && <Alert variant="warning">{t("k8s.logs.podsTruncated")}</Alert>}
        {data?.pods
          .filter((p) => p.error || p.partial)
          .map((p) => (
            <p key={p.name} className="font-mono text-xs text-amber-700 dark:text-amber-300">
              {p.name}: {p.error ?? t("k8s.logs.partial")}
            </p>
          ))}

        <div className="flex items-center gap-3">
          <SearchInput value={q} onChange={setQ} placeholder={t("k8s.logs.filter")} className="w-72" />
          <span className="text-xs text-slate-500">
            {logs.isFetching
              ? t("k8s.logs.reading")
              : data &&
                `${t("k8s.logs.count", { shown: lines.length, count: data.lines.length })} · ${t("k8s.logs.fetchedAt", { time: clock(data.fetched_at) })}`}
          </span>
        </div>

        <div
          ref={box}
          className="h-[60vh] overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-200"
        >
          {data && lines.length === 0 ? (
            <p className="text-slate-500">{data.lines.length ? t("k8s.logs.noMatch") : t("k8s.logs.empty")}</p>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}>
                {stamps && (
                  <span className="mr-2 text-slate-500 select-none" title={l.ts ?? ""}>
                    {clock(l.ts)}
                  </span>
                )}
                {many && <span className={`mr-2 select-none ${color(l.pod)}`}>{l.pod}</span>}
                {l.text}
              </div>
            ))
          )}
        </div>
        <p className="text-xs text-slate-500">{t("k8s.logs.notStored")}</p>
      </div>
    </Dialog>
  );
}
