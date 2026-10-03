"use client";

/**
 * Data-viz primitives (dataviz method): one axis per chart, thin 2px lines, recessive
 * grid, a crosshair + tooltip listing every series, a legend from two series up, and
 * status colors only for thresholds — always next to the written value.
 */
import { useEffect, useMemo, useRef, useState } from "react";

// --- formatting ------------------------------------------------------------------------

export const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

export function mib(mbValue: number): string {
  return mbValue >= 1024 ? `${(mbValue / 1024).toFixed(1)} GiB` : `${Math.round(mbValue)} MiB`;
}

export function rate(bytesPerSecond: number): string {
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = bytesPerSecond;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function uptime(seconds: number): string {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}

// --- allocation ------------------------------------------------------------------------

/** What VMs were *given* versus the physical capacity — configuration, not consumption.
 * Deliberately not a bar: a full red bar reads as "saturated" when the host may be idle.
 * Overcommit above 1× is normal for CPU; `warnAbove` flags it only where it is risky (RAM). */
export function Allocation({
  ratio,
  label,
  title,
  warnAbove,
}: {
  ratio: number;
  label: string;
  title?: string;
  warnAbove?: number;
}) {
  const warn = warnAbove !== undefined && ratio > warnAbove;
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-slate-700 dark:text-slate-300" title={title}>
      {warn && (
        <span aria-label="sobrecomprometida" className="mr-0.5" style={{ color: "var(--viz-serious)" }}>
          ⚠
        </span>
      )}
      {label}
      <span className="ml-1.5 text-slate-500">{ratioLabel(ratio)}</span>
    </span>
  );
}

export const ratioLabel = (r: number) => `${r.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}×`;

// --- meter -----------------------------------------------------------------------------

const SERIOUS = 0.75;
const CRITICAL = 0.9;

/** A single ratio against a limit. The value is always written; above the thresholds
 * the fill switches to a status color *and* a warning icon appears (never color alone). */
export function Meter({
  value,
  label,
  title,
}: {
  value: number; // 0..1 (may exceed 1 for overcommit)
  label?: string;
  title?: string;
}) {
  const clamped = Math.max(0, Math.min(value, 1));
  const level = value >= CRITICAL ? "critical" : value >= SERIOUS ? "serious" : null;
  const fill = level === "critical" ? "var(--viz-critical)" : level === "serious" ? "var(--viz-serious)" : "var(--viz-series-1)";
  return (
    <div className="flex min-w-[9rem] items-center gap-2" title={title}>
      <div
        className="h-2.5 flex-1 overflow-hidden rounded-full"
        style={{ background: "var(--viz-meter-track)" }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label={title}
      >
        <div className="h-full rounded-full transition-[width]" style={{ width: `${clamped * 100}%`, background: fill }} />
      </div>
      <span className="min-w-[3.5rem] shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-slate-700 dark:text-slate-300">
        {level && (
          <span aria-label={level === "critical" ? "crítico" : "alto"} className="mr-0.5">
            ⚠
          </span>
        )}
        {label ?? pct(value)}
      </span>
    </div>
  );
}

// --- range picker ----------------------------------------------------------------------

export type Range = "hour" | "day" | "week";
const RANGES: { value: Range; label: string }[] = [
  { value: "hour", label: "1h" },
  { value: "day", label: "24h" },
  { value: "week", label: "7d" },
];

export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div role="radiogroup" aria-label="Período" className="inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-700">
      {RANGES.map((r) => (
        <button
          key={r.value}
          role="radio"
          aria-checked={value === r.value}
          onClick={() => onChange(r.value)}
          className={`rounded px-3 py-1 text-xs font-medium ${
            value === r.value
              ? "bg-indigo-600 text-white"
              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// --- time series -----------------------------------------------------------------------

export type Series = {
  name: string;
  values: number[];
  color: "var(--viz-series-1)" | "var(--viz-series-2)";
};

const HEIGHT = 160;
const PAD = { top: 8, right: 8, bottom: 22, left: 56 };

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

function timeLabel(t: number, range: Range): string {
  const d = new Date(t * 1000);
  return range === "week"
    ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
    : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function TimeSeriesChart({
  title,
  times,
  series,
  format,
  yMax,
  range,
}: {
  title: string;
  times: number[];
  series: Series[];
  format: (v: number) => string;
  yMax?: number; // fixed top (e.g. 1 for percentages); otherwise from the data
  range: Range;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const top = useMemo(
    () => yMax ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values))),
    [series, yMax],
  );
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const n = times.length;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (Math.min(v, top) / top) * plotH;

  const path = (values: number[]) =>
    values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = (values: number[]) =>
    `${path(values)}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  }

  const ticks = [0, 0.5, 1].map((f) => f * top);
  const xTicks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [];

  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {series.length > 1 && (
          <span className="flex gap-3 text-xs text-slate-600 dark:text-slate-400">
            {series.map((s) => (
              <span key={s.name} className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div ref={wrap} className="relative">
        {n === 0 ? (
          <div className="flex items-center justify-center text-xs text-slate-500" style={{ height: HEIGHT }}>
            Sem dados no período (a VM estava desligada?)
          </div>
        ) : (
          <svg width={width} height={HEIGHT} role="img" aria-label={title} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--viz-axis)" className="tabular-nums">
                  {format(t)}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={x(i)} y={HEIGHT - 6} fontSize={10} fill="var(--viz-axis)" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
                {timeLabel(times[i], range)}
              </text>
            ))}
            {series.length === 1 && <path d={area(series[0].values)} fill={series[0].color} opacity={0.12} />}
            {series.map((s) => (
              <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            ))}
            {hover !== null && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
                {series.map((s) => (
                  <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke="var(--viz-surface)" strokeWidth={2} />
                ))}
              </>
            )}
            <rect
              x={PAD.left}
              y={PAD.top}
              width={plotW}
              height={plotH}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hover !== null && n > 0 && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900"
            style={x(hover) > width / 2 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }}
          >
            <div className="mb-1 text-slate-500">
              {new Date(times[hover] * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
            </div>
            {series.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                <span className="font-semibold tabular-nums">{format(s.values[hover])}</span>
                <span className="text-slate-500">{s.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

// --- sortable tables -------------------------------------------------------------------

export type SortState<K extends string> = { key: K; desc: boolean };

export function useSorted<T, K extends string>(
  rows: T[],
  keys: Record<K, (row: T) => number | string>,
  initial: SortState<K>,
) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const get = keys[sort.key];
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, sort]);
  const toggle = (key: K) =>
    setSort((cur) => (cur.key === key ? { key, desc: !cur.desc } : { key, desc: key !== "name" }));
  return { sorted, sort, toggle };
}

export function SortHeader<K extends string>({
  label,
  k,
  sort,
  toggle,
  align = "left",
}: {
  label: string;
  k: K;
  sort: SortState<K>;
  toggle: (k: K) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  return (
    <th
      className={`py-2 pr-4 font-medium ${align === "right" ? "text-right" : ""}`}
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        onClick={() => toggle(k)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-900 dark:hover:text-slate-100 ${active ? "text-slate-900 dark:text-slate-100" : ""}`}
      >
        {label}
        <span aria-hidden className="text-[10px]">{active ? (sort.desc ? "▼" : "▲") : "↕"}</span>
      </button>
    </th>
  );
}
