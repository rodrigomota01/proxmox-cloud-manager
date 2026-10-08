"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { CostTiles, DailyCostBars } from "@/components/cost";
import { NoTenant } from "@/components/no-tenant";
import { ScopeToggle } from "@/components/scope-toggle";
import { Badge, Button, Card, Empty, ErrorBox, PowerBadge, Select } from "@/components/ui";
import { mib } from "@/components/viz";
import { api, ApiError, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { money, monthLabel, num, recentMonths, RESOURCE_LABEL } from "@/lib/money";
import { useProjectNames } from "@/lib/queries";
import { useSession } from "@/lib/session";

function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <Select aria-label="Mês" value={value} onChange={(e) => onChange(e.target.value)}>
      {recentMonths().map((m) => (
        <option key={m} value={m}>
          {monthLabel(m)}
        </option>
      ))}
    </Select>
  );
}

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) => r.map((c) => (typeof c === "string" && /[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";"))
    .join("\n");
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const BREAKDOWN = [
  { key: "vcpu", label: "vCPU" },
  { key: "memory", label: "Memória" },
  { key: "disk", label: "Disco" },
  { key: "instance", label: "Taxa por instância" },
] as const;

function TenantCosts({ tenantId }: { tenantId: string }) {
  const { tenant } = useSession();
  const projectNames = useProjectNames();
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const summary = useQuery({
    queryKey: ["billing", "summary", tenantId, month],
    queryFn: async () => unwrap(await api.GET("/api/v1/billing/summary", { params: { query: { month } } })),
    refetchInterval: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
  });
  const s = summary.data;
  const cur = s?.currency ?? "BRL";
  const denied = summary.error instanceof ApiError && summary.error.status === 403;

  function exportCsv(data: Schemas["CostSummaryOut"]) {
    downloadCsv(`custos-${tenant?.slug ?? "cliente"}-${data.month}.csv`, [
      ["instancia", "projeto", "tipo", "vcpus", "memoria_mb", "disco_gb", "horas", "horas_ligada",
        "custo_vcpu", "custo_memoria", "custo_disco", "custo_instancia", "total", "custo_atual_mensal", "excluida"],
      ...data.instances.map((i) => [
        i.name, projectNames.get(i.project_id ?? "") ?? "", i.kind, i.vcpus, i.memory_mb, i.disk_gb,
        i.hours, i.running_hours, i.accrued.vcpu, i.accrued.memory, i.accrued.disk, i.accrued.instance,
        i.accrued.total, i.run_rate_monthly, i.deleted ? "sim" : "não",
      ]),
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Custos · {tenant?.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker value={month} onChange={setMonth} />
          <ScopeToggle />
        </div>
      </div>
      {denied ? (
        <Card title="Sem acesso">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Os custos ficam visíveis para administradores do cliente e dos projetos.
          </p>
        </Card>
      ) : (
        <ErrorBox message={summary.isError ? errorMessage(summary.error) : null} />
      )}
      {s && (
        <>
          <CostTiles
            currency={cur}
            accrued={s.accrued.total}
            runRate={s.run_rate.total}
            runRateHourly={s.run_rate_hourly}
            forecast={s.forecast}
            current={s.current}
            month={s.month}
          />

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Custo por dia" className="lg:col-span-2">
              <DailyCostBars month={s.month} days={s.days} currency={cur} />
            </Card>
            <Card title="Por recurso">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {BREAKDOWN.map((b) => (
                    <tr key={b.key}>
                      <td className="py-1.5">{b.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(s.accrued[b.key], cur)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-1.5">Total</td>
                    <td className="py-1.5 text-right tabular-nums">{money(s.accrued.total, cur)}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
          </div>

          <Card title="Por projeto">
            {s.projects.length === 0 ? (
              <Empty>Nenhum custo neste mês.</Empty>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">Projeto</th>
                    <th className="py-1 text-right font-medium">No mês</th>
                    {s.current && <th className="py-1 text-right font-medium">Custo atual/mês</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {s.projects.map((p) => (
                    <tr key={p.project_id ?? "none"}>
                      <td className="py-1.5">{p.name ?? <span className="text-slate-500">sem projeto</span>}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(p.accrued, cur)}</td>
                      {s.current && <td className="py-1.5 text-right tabular-nums">{money(p.run_rate_monthly, cur)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card
            title="Por instância"
            actions={
              s.instances.length > 0 && (
                <Button variant="secondary" onClick={() => exportCsv(s)}>
                  Exportar CSV
                </Button>
              )
            }
          >
            {s.instances.length === 0 ? (
              <Empty>Nenhuma instância com custo neste mês.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-1 font-medium">Instância</th>
                      <th className="py-1 font-medium">Recursos</th>
                      <th className="py-1 text-right font-medium">Horas (ligada)</th>
                      <th className="py-1 text-right font-medium">No mês</th>
                      {s.current && <th className="py-1 text-right font-medium">Custo atual/mês</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {s.instances.map((i) => (
                      <tr key={i.instance_id}>
                        <td className="py-1.5">
                          {i.deleted ? (
                            <span className="text-slate-500">{i.name}</span>
                          ) : (
                            <Link href={`/instances/${i.instance_id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                              {i.name}
                            </Link>
                          )}
                          <div className="flex items-center gap-1.5 text-xs text-slate-500">
                            {projectNames.get(i.project_id ?? "") ?? ""}
                            {i.deleted ? <Badge>excluída</Badge> : <PowerBadge state={i.power_state} />}
                          </div>
                        </td>
                        <td className="py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400">
                          {i.vcpus} vCPU · {mib(i.memory_mb)} · {i.disk_gb} GiB
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {num(i.hours).toFixed(1)} ({num(i.running_hours).toFixed(1)})
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{money(i.accrued.total, cur)}</td>
                        {s.current && (
                          <td className="py-1.5 text-right tabular-nums">
                            {i.deleted ? "—" : money(i.run_rate_monthly, cur)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`Tabela de preços${s.prices.price_table ? `: ${s.prices.price_table}` : ""}`}>
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
              Preço mensal ({s.prices.hours_per_month} h) por unidade alocada, cobrado por segundo de uso. vCPU e
              memória só contam com a instância ligada; disco e taxa por instância enquanto ela existir.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(s.prices.prices).map(([r, p]) => (
                <div key={r} className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700">
                  <div className="text-xs text-slate-500">{RESOURCE_LABEL[r] ?? r}</div>
                  <div className="font-medium tabular-nums">{money(p, cur, true)}/mês</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** Platform admins: cost of every client; picking one opens its detail. */
function PlatformCosts() {
  const { selectTenant } = useSession();
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const summary = useQuery({
    queryKey: ["admin", "billing", "summary", month],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/billing/summary", { params: { query: { month } } })),
    refetchInterval: 60_000,
  });
  const s = summary.data;
  const cur = s?.currency ?? "BRL";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Custos · toda a plataforma</h1>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker value={month} onChange={setMonth} />
          <ScopeToggle />
        </div>
      </div>
      <ErrorBox message={summary.isError ? errorMessage(summary.error) : null} />
      {s && (
        <>
          <CostTiles
            currency={cur}
            accrued={s.accrued.total}
            runRate={s.run_rate_monthly}
            runRateHourly={s.run_rate_hourly}
            forecast={s.forecast}
            current={s.current}
            month={s.month}
          />
          <Card title="Custo por dia">
            <DailyCostBars month={s.month} days={s.days} currency={cur} />
          </Card>
          <Card
            title="Custo por cliente"
            actions={
              <Button
                variant="secondary"
                onClick={() =>
                  downloadCsv(`custos-clientes-${s.month}.csv`, [
                    ["cliente", "identificador", "tabela_de_precos", "no_mes", "custo_atual_mensal", "previsao"],
                    ...s.tenants.map((t) => [t.name, t.slug, t.price_table ?? "", t.accrued, t.run_rate_monthly, t.forecast ?? ""]),
                  ])
                }
              >
                Exportar CSV
              </Button>
            }
          >
            {s.tenants.length === 0 ? (
              <Empty>Nenhum cliente.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-1 font-medium">Cliente</th>
                      <th className="py-1 font-medium">Tabela de preços</th>
                      <th className="py-1 text-right font-medium">No mês</th>
                      {s.current && <th className="py-1 text-right font-medium">Custo atual/mês</th>}
                      {s.current && <th className="py-1 text-right font-medium">Previsão</th>}
                      <th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {s.tenants.map((t) => (
                      <tr key={t.tenant_id}>
                        <td className="py-1.5 font-medium">{t.name}</td>
                        <td className="py-1.5 text-slate-600 dark:text-slate-400">
                          {t.price_table ?? "—"}
                          {!t.custom_price_table && t.price_table && <span className="text-xs"> (padrão)</span>}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{money(t.accrued, cur)}</td>
                        {s.current && <td className="py-1.5 text-right tabular-nums">{money(t.run_rate_monthly, cur)}</td>}
                        {s.current && <td className="py-1.5 text-right tabular-nums">{money(t.forecast, cur)}</td>}
                        <td className="py-1.5 text-right">
                          <Button variant="ghost" onClick={() => selectTenant(t.tenant_id)}>
                            Detalhar
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default function CostsPage() {
  const { tenantId, platformView } = useSession();
  if (platformView) return <PlatformCosts />;
  if (!tenantId) return <NoTenant />;
  return <TenantCosts tenantId={tenantId} />;
}
