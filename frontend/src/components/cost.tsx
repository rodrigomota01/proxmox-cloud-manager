"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { StatTile } from "@/components/page";
import { Card, tbl } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
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
          : `Máximo diário: ${format(max)}`}
      </div>
      <div
        className="flex h-32 items-end gap-[2px] border-b border-[var(--viz-axis)]"
        role="img"
        aria-label={`${what} por dia em ${monthLabel(month)}`}
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
  return (
    <DailyBars
      month={month}
      days={days.map((d) => ({ date: d.date, value: num(d.cost) }))}
      format={(v) => money(v, currency)}
      what="Custo"
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
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatTile
        icon="coins"
        label={current ? "Custo no mês até agora" : `Custo em ${monthLabel(month)}`}
        value={money(accrued, currency)}
        hint={current ? monthLabel(month) : "mês encerrado"}
      />
      <StatTile
        icon="power"
        label="Custo atual"
        value={current ? `${money(runRate, currency)}/mês` : "—"}
        hint={current ? `${money(runRateHourly, currency, true)}/hora com as instâncias de agora` : undefined}
      />
      <StatTile
        icon="history"
        label="Previsão para o mês"
        value={forecast !== null ? money(forecast, currency) : "—"}
        hint={current ? "acumulado + custo atual até o fim do mês" : undefined}
      />
    </div>
  );
}

/** Tenant dashboard: cost so far, run rate and forecast. Hidden without billing:view. */
export function TenantCostPreview({ tenantId }: { tenantId: string }) {
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
      title="Custos"
      actions={
        <Link href="/costs" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          Ver detalhes
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
  const summary = useQuery({
    queryKey: ["admin", "billing", "summary", "current"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/billing/summary")),
    refetchInterval: 60_000,
  });
  const s = summary.data;
  if (!s) return null;
  const top = s.tenants.filter((t) => num(t.accrued) > 0 || num(t.run_rate_monthly) > 0).slice(0, 5);
  return (
    <Card
      title="Custos de todos os clientes"
      actions={
        <Link href="/costs" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          Custo por cliente
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
                  <th className={tbl.th}>Cliente</th>
                  <th className={`${tbl.th} text-right`}>No mês</th>
                  <th className={`${tbl.th} text-right`}>Custo atual/mês</th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {top.map((t) => (
                  <tr key={t.tenant_id} className={tbl.tr}>
                    <td className={`${tbl.td} font-medium`}>{t.name}</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{money(t.accrued, s.currency)}</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{money(t.run_rate_monthly, s.currency)}</td>
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
