"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { StatTile } from "@/components/page";
import { Card, tbl } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { money, monthLabel, num } from "@/lib/money";

/** One bar per day of the month (days without a value stay empty). */
export function DailyBars({
  month,
  days,
  format,
  what,
}: {
  month: string;
  days: { date: string; value: number }[];
  format: (v: number) => string;
  what: string;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const [y, m] = month.split("-").map(Number);
  const count = new Date(y, m, 0).getDate();
  const byDay = new Map(days.map((d) => [Number(d.date.slice(8, 10)), d.value]));
  const values = Array.from({ length: count }, (_, i) => byDay.get(i + 1) ?? 0);
  const max = Math.max(...values);
  const h = hover !== null ? values[hover] : null;
  return (
    <div>
      <div className="mb-1 h-5 text-xs tabular-nums text-slate-600 dark:text-slate-400" aria-live="polite">
        {h !== null && hover !== null
          ? `${String(hover + 1).padStart(2, "0")}/${String(m).padStart(2, "0")}: ${format(h)}`
          : t("costs.daily.max", { value: format(max) })}
      </div>
      <div
        className="flex h-32 items-end gap-[2px] border-b border-[var(--viz-axis)]"
        role="img"
        aria-label={t("costs.daily.perDay", { what, month: monthLabel(month) })}
        onMouseLeave={() => setHover(null)}
      >
        {values.map((v, i) => (
          <div
            key={i}
            className="flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            title={`${i + 1}: ${format(v)}`}
          >
            <div
              className="w-full rounded-t-[4px]"
              style={{
                height: max ? `${Math.max((v / max) * 100, v ? 2 : 0)}%` : 0,
                background: "var(--viz-series-1)",
                opacity: hover === null || hover === i ? 1 : 0.55,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-slate-500">
        <span>1</span>
        <span>{Math.ceil(count / 2)}</span>
        <span>{count}</span>
      </div>
    </div>
  );
}

/** Cost per day of the month. */
export function DailyCostBars({
  month,
  days,
  currency,
}: {
  month: string;
  days: Schemas["DayCostOut"][];
  currency: string;
}) {
  const t = useT();
  return (
    <DailyBars
      month={month}
      days={days.map((d) => ({ date: d.date, value: num(d.cost) }))}
      format={(v) => money(v, currency)}
      what={t("costs.daily.cost")}
    />
  );
}

/** Accrued / run rate / forecast tiles shared by the dashboard previews and /costs. */
export function CostTiles({
  currency,
  accrued,
  runRate,
  runRateHourly,
  forecast,
  current,
  month,
}: {
  currency: string;
  accrued: string;
  runRate: string;
  runRateHourly: string;
  forecast: string | null;
  current: boolean;
  month: string;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatTile
        icon="coins"
        label={current ? t("costs.tiles.accruedCurrent") : t("costs.tiles.accruedIn", { month: monthLabel(month) })}
        value={money(accrued, currency)}
        hint={current ? monthLabel(month) : t("costs.tiles.monthClosed")}
      />
      <StatTile
        icon="power"
        label={t("costs.tiles.runRate")}
        value={current ? t("costs.tiles.perMonth", { value: money(runRate, currency) }) : "—"}
        hint={current ? t("costs.tiles.perHourNow", { value: money(runRateHourly, currency, true) }) : undefined}
      />
      <StatTile
        icon="history"
        label={t("costs.tiles.forecast")}
        value={forecast !== null ? money(forecast, currency) : "—"}
        hint={current ? t("costs.tiles.forecastHint") : undefined}
      />
    </div>
  );
}

/** Tenant dashboard: cost so far, run rate and forecast. Hidden without billing:view. */
export function TenantCostPreview({ tenantId }: { tenantId: string }) {
  const t = useT();
  const summary = useQuery({
    queryKey: ["billing", "summary", tenantId, "current"],
    queryFn: async () => unwrap(await api.GET("/api/v1/billing/summary")),
    refetchInterval: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
  });
  const s = summary.data;
  if (!s) return null;
  return (
    <Card
      title={t("costs.preview.title")}
      actions={
        <Link href="/costs" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
          {t("costs.preview.details")}
        </Link>
      }
    >
      <CostTiles
        currency={s.currency}
        accrued={s.accrued.total}
        runRate={s.run_rate.total}
        runRateHourly={s.run_rate_hourly}
        forecast={s.forecast}
        current={s.current}
        month={s.month}
      />
    </Card>
  );
}

/** Platform overview: the whole platform, top clients by cost. */
export function PlatformCostPreview() {
  const t = useT();
  const summary = useQuery({
    queryKey: ["admin", "billing", "summary", "current"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/billing/summary")),
    refetchInterval: 60_000,
  });
  const s = summary.data;
  if (!s) return null;
  const top = s.tenants.filter((x) => num(x.accrued) > 0 || num(x.run_rate_monthly) > 0).slice(0, 5);
  return (
    <Card
      title={t("costs.preview.platformTitle")}
      actions={
        <Link href="/costs" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
          {t("costs.preview.perClient")}
        </Link>
      }
    >
      <div className="space-y-4">
        <CostTiles
          currency={s.currency}
          accrued={s.accrued.total}
          runRate={s.run_rate_monthly}
          runRateHourly={s.run_rate_hourly}
          forecast={s.forecast}
          current={s.current}
          month={s.month}
        />
        {top.length > 0 && (
          <div className={`${tbl.wrap} -mx-5`}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>{t("costs.table.client")}</th>
                  <th className={`${tbl.th} text-right`}>{t("costs.table.thisMonth")}</th>
                  <th className={`${tbl.th} text-right`}>{t("costs.table.runRateMonth")}</th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {top.map((x) => (
                  <tr key={x.tenant_id} className={tbl.tr}>
                    <td className={`${tbl.td} font-medium`}>{x.name}</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{money(x.accrued, s.currency)}</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{money(x.run_rate_monthly, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
