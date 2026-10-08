"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { CostTiles, DailyBars, DailyCostBars } from "@/components/cost";
import { Icon } from "@/components/icons";
import { ago, bytes, cores, HealthBadge, UsageMeter } from "@/components/k8s";
import { NoTenant } from "@/components/no-tenant";
import { Menu, PageHeader, ResourceIcon, SearchInput, StatTile, Toolbar } from "@/components/page";
import { ScopeToggle } from "@/components/scope-toggle";
import { Alert, Badge, Button, Card, Empty, ErrorBox, PowerBadge, Select, tbl } from "@/components/ui";
import { mib } from "@/components/viz";
import { api, ApiError, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { money, monthLabel, num, recentMonths, RESOURCE_LABEL } from "@/lib/money";
import { useCostVisibility, useProjectNames } from "@/lib/queries";
import { usePermissions, useSession } from "@/lib/session";

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

/** The API reports only the user's projects without billing:view on the whole client. */
function useProjectScoped(tenantId: string) {
  const { isPlatformAdmin } = useSession();
  const tenantPerms = usePermissions(`tenant:${tenantId}`);
  return !isPlatformAdmin && !tenantPerms.has("billing:view");
}

const denied403 = (count: number, err: unknown) => !(err instanceof ApiError && err.status === 403) && count < 2;

function TenantCosts({ tenantId, month }: { tenantId: string; month: string }) {
  const { tenant } = useSession();
  const projectScoped = useProjectScoped(tenantId);
  const projectNames = useProjectNames();
  const [filter, setFilter] = useState("");
  const summary = useQuery({
    queryKey: ["billing", "summary", tenantId, month],
    queryFn: async () => unwrap(await api.GET("/api/v1/billing/summary", { params: { query: { month } } })),
    refetchInterval: 60_000,
    retry: denied403,
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

  const q = filter.trim().toLowerCase();
  const instances = (s?.instances ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));

  return (
    <>
      {denied ? (
        <Alert variant="warning" title="Sem acesso">
          Os custos ficam visíveis para quem tem algum papel no cliente ou em um dos seus projetos.
        </Alert>
      ) : (
        <ErrorBox message={summary.isError ? errorMessage(summary.error) : null} />
      )}
      {s && projectScoped && <Alert variant="info">Mostrando os custos dos projetos em que você tem acesso.</Alert>}
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
            <Card title="Por recurso" flush>
              <table className={tbl.table}>
                <tbody className={tbl.tbody}>
                  {BREAKDOWN.map((b) => (
                    <tr key={b.key} className={tbl.tr}>
                      <td className={tbl.td}>{b.label}</td>
                      <td className={`${tbl.td} text-right tabular-nums`}>{money(s.accrued[b.key], cur)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
                    <td className={tbl.td}>Total</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{money(s.accrued.total, cur)}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
          </div>

          <Card title="Por projeto" flush>
            {s.projects.length === 0 ? (
              <Empty icon="folder">Nenhum custo neste mês.</Empty>
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>Projeto</th>
                      <th className={`${tbl.th} text-right`}>No mês</th>
                      {s.current && <th className={`${tbl.th} text-right`}>Custo atual/mês</th>}
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {s.projects.map((p) => (
                      <tr key={p.project_id ?? "none"} className={tbl.tr}>
                        <td className={tbl.td}>
                          {p.name ? (
                            <span className="flex items-center gap-2 font-medium">
                              <ResourceIcon kind="project" />
                              {p.name}
                            </span>
                          ) : (
                            <span className="text-slate-500">sem projeto</span>
                          )}
                        </td>
                        <td className={`${tbl.td} text-right tabular-nums`}>{money(p.accrued, cur)}</td>
                        {s.current && <td className={`${tbl.td} text-right tabular-nums`}>{money(p.run_rate_monthly, cur)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Por instância"
            flush
            actions={
              s.instances.length > 0 && (
                <Button variant="secondary" onClick={() => exportCsv(s)}>
                  <Icon name="download" /> Exportar CSV
                </Button>
              )
            }
          >
            {s.instances.length === 0 ? (
              <Empty icon="monitor">Nenhuma instância com custo neste mês.</Empty>
            ) : (
              <>
                <Toolbar count={`${instances.length} de ${s.instances.length} instâncias`}>
                  <SearchInput value={filter} onChange={setFilter} />
                </Toolbar>
                <div className={tbl.wrap}>
                  <table className={`${tbl.table} min-w-[44rem]`}>
                    <thead className={tbl.thead}>
                      <tr>
                        <th className={tbl.th}>Instância</th>
                        <th className={tbl.th}>Recursos</th>
                        <th className={`${tbl.th} text-right`}>Horas (ligada)</th>
                        <th className={`${tbl.th} text-right`}>No mês</th>
                        {s.current && <th className={`${tbl.th} text-right`}>Custo atual/mês</th>}
                      </tr>
                    </thead>
                    <tbody className={tbl.tbody}>
                      {instances.map((i) => (
                        <tr key={i.instance_id} className={tbl.tr}>
                          <td className={tbl.td}>
                            <div className="flex items-start gap-2">
                              <ResourceIcon kind={i.kind === "container" ? "container" : "vm"} className="mt-0.5" />
                              <div>
                                {i.deleted ? (
                                  <span className="text-slate-500">{i.name}</span>
                                ) : (
                                  <Link href={`/instances/${i.instance_id}`} className={tbl.link}>
                                    {i.name}
                                  </Link>
                                )}
                                <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                                  {projectNames.get(i.project_id ?? "") ?? ""}
                                  {i.deleted ? <Badge>excluída</Badge> : <PowerBadge state={i.power_state} />}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className={`${tbl.td} text-xs tabular-nums text-slate-600 dark:text-slate-400`}>
                            {i.vcpus} vCPU · {mib(i.memory_mb)} · {i.disk_gb} GiB
                          </td>
                          <td className={`${tbl.td} text-right tabular-nums`}>
                            {num(i.hours).toFixed(1)} ({num(i.running_hours).toFixed(1)})
                          </td>
                          <td className={`${tbl.td} text-right font-medium tabular-nums`}>{money(i.accrued.total, cur)}</td>
                          {s.current && (
                            <td className={`${tbl.td} text-right tabular-nums`}>
                              {i.deleted ? "—" : money(i.run_rate_monthly, cur)}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {instances.length === 0 && <Empty>Nenhuma instância com esse nome.</Empty>}
              </>
            )}
          </Card>

          <Card
            title={`Tabela de preços${s.prices.price_table ? `: ${s.prices.price_table}` : ""}`}
            description={`Preço mensal (${s.prices.hours_per_month} h) por unidade alocada, cobrado por segundo de uso. vCPU e memória só contam com a instância ligada; disco e taxa por instância enquanto ela existir.`}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(s.prices.prices).map(([r, p]) => (
                <div key={r} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
                  <div className="text-xs text-slate-500">{RESOURCE_LABEL[r] ?? r}</div>
                  <div className="font-semibold tabular-nums">{money(p, cur, true)}/mês</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

const hrs = (v: string | number) => num(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** Consumed and allocated resources, without prices: the client's VMs (same project
 * rules as the costs) and the Kubernetes clusters linked to it. */
function TenantUsage({ tenantId, month }: { tenantId: string; month: string }) {
  const { tenant } = useSession();
  const projectScoped = useProjectScoped(tenantId);
  const projectNames = useProjectNames();
  const [filter, setFilter] = useState("");
  const usage = useQuery({
    queryKey: ["billing", "usage", tenantId, month],
    queryFn: async () => unwrap(await api.GET("/api/v1/billing/usage", { params: { query: { month } } })),
    refetchInterval: 60_000,
    retry: denied403,
  });
  const u = usage.data;
  const denied = usage.error instanceof ApiError && usage.error.status === 403;
  const q = filter.trim().toLowerCase();
  const instances = (u?.instances ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));

  function exportCsv(data: Schemas["UsageReportOut"]) {
    downloadCsv(`uso-${tenant?.slug ?? "cliente"}-${data.month}.csv`, [
      ["instancia", "projeto", "tipo", "vcpus", "memoria_mb", "disco_gb", "horas", "horas_ligada",
        "vcpu_horas", "memoria_gib_horas", "disco_gib_horas", "excluida"],
      ...data.instances.map((i) => [
        i.name, projectNames.get(i.project_id ?? "") ?? "", i.kind, i.vcpus, i.memory_mb, i.disk_gb,
        i.hours, i.running_hours, i.vcpu_hours, i.memory_gib_hours, i.disk_gib_hours, i.deleted ? "sim" : "não",
      ]),
    ]);
  }

  return (
    <>
      {denied ? (
        <Alert variant="warning" title="Sem acesso">
          O consumo fica visível para quem tem algum papel no cliente ou em um dos seus projetos.
        </Alert>
      ) : (
        <ErrorBox message={usage.isError ? errorMessage(usage.error) : null} />
      )}
      {u && projectScoped && <Alert variant="info">Mostrando as VMs dos projetos em que você tem acesso.</Alert>}
      {u && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              icon="monitor"
              label="Alocado agora"
              value={`${u.allocated.vcpus} vCPU · ${mib(u.allocated.memory_mb)}`}
              hint={`${u.allocated.disk_gb} GiB de disco · ${u.allocated.instances} VMs (${u.allocated.running} ligadas)`}
            />
            <StatTile icon="dashboard" label="vCPU·hora no mês" value={hrs(u.consumed.vcpu_hours)} hint="enquanto ligadas" />
            <StatTile icon="layers" label="Memória (GiB·hora)" value={hrs(u.consumed.memory_gib_hours)} hint="enquanto ligadas" />
            <StatTile icon="server" label="Disco (GiB·hora)" value={hrs(u.consumed.disk_gib_hours)} hint="enquanto existirem" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="vCPU·hora por dia" className="lg:col-span-2">
              <DailyBars
                month={u.month}
                days={u.days.map((d) => ({ date: d.date, value: num(d.vcpu_hours) }))}
                format={(v) => `${hrs(v)} vCPU·h`}
                what="vCPU·hora"
              />
            </Card>
            <Card title="Por projeto" flush>
              {u.projects.length === 0 ? (
                <Empty icon="folder">Nenhum consumo neste mês.</Empty>
              ) : (
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>Projeto</th>
                      <th className={`${tbl.th} text-right`}>vCPU·h</th>
                      <th className={`${tbl.th} text-right`}>GiB·h RAM</th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {u.projects.map((p) => (
                      <tr key={p.project_id ?? "none"} className={tbl.tr}>
                        <td className={tbl.td}>
                          {p.name ? (
                            <span className="flex items-center gap-2 font-medium">
                              <ResourceIcon kind="project" />
                              {p.name}
                            </span>
                          ) : (
                            <span className="text-slate-500">sem projeto</span>
                          )}
                          <div className="text-xs text-slate-500">{p.instances} VMs</div>
                        </td>
                        <td className={`${tbl.td} text-right tabular-nums`}>{hrs(p.vcpu_hours)}</td>
                        <td className={`${tbl.td} text-right tabular-nums`}>{hrs(p.memory_gib_hours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card
            title="Máquinas virtuais"
            description="Recursos alocados a cada VM e o consumo no mês: vCPU e memória contam com a VM ligada; disco enquanto ela existir."
            flush
            actions={
              u.instances.length > 0 && (
                <Button variant="secondary" onClick={() => exportCsv(u)}>
                  <Icon name="download" /> Exportar CSV
                </Button>
              )
            }
          >
            {u.instances.length === 0 ? (
              <Empty icon="monitor">Nenhuma VM neste mês.</Empty>
            ) : (
              <>
                <Toolbar count={`${instances.length} de ${u.instances.length} VMs`}>
                  <SearchInput value={filter} onChange={setFilter} />
                </Toolbar>
                <div className={tbl.wrap}>
                  <table className={`${tbl.table} min-w-[48rem]`}>
                    <thead className={tbl.thead}>
                      <tr>
                        <th className={tbl.th}>VM</th>
                        <th className={tbl.th}>Alocado</th>
                        <th className={`${tbl.th} text-right`}>Horas (ligada)</th>
                        <th className={`${tbl.th} text-right`}>vCPU·h</th>
                        <th className={`${tbl.th} text-right`}>GiB·h RAM</th>
                        <th className={`${tbl.th} text-right`}>GiB·h disco</th>
                      </tr>
                    </thead>
                    <tbody className={tbl.tbody}>
                      {instances.map((i) => (
                        <tr key={i.instance_id} className={tbl.tr}>
                          <td className={tbl.td}>
                            <div className="flex items-start gap-2">
                              <ResourceIcon kind={i.kind === "container" ? "container" : "vm"} className="mt-0.5" />
                              <div>
                                {i.deleted ? (
                                  <span className="text-slate-500">{i.name}</span>
                                ) : (
                                  <Link href={`/instances/${i.instance_id}`} className={tbl.link}>
                                    {i.name}
                                  </Link>
                                )}
                                <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                                  {projectNames.get(i.project_id ?? "") ?? ""}
                                  {i.deleted ? <Badge>excluída</Badge> : <PowerBadge state={i.power_state} />}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className={`${tbl.td} text-xs tabular-nums text-slate-600 dark:text-slate-400`}>
                            {i.vcpus} vCPU · {mib(i.memory_mb)} · {i.disk_gb} GiB
                          </td>
                          <td className={`${tbl.td} text-right tabular-nums`}>
                            {hrs(i.hours)} ({hrs(i.running_hours)})
                          </td>
                          <td className={`${tbl.td} text-right font-medium tabular-nums`}>{hrs(i.vcpu_hours)}</td>
                          <td className={`${tbl.td} text-right tabular-nums`}>{hrs(i.memory_gib_hours)}</td>
                          <td className={`${tbl.td} text-right tabular-nums`}>{hrs(i.disk_gib_hours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {instances.length === 0 && <Empty>Nenhuma VM com esse nome.</Empty>}
              </>
            )}
          </Card>

          {u.clusters.length > 0 && (
            <Card
              title="Clusters Kubernetes"
              description="Capacidade alocada e consumo na última coleta. Sem metrics-server, mostra o que os pods reservaram."
              flush
            >
              <div className={tbl.wrap}>
                <table className={`${tbl.table} min-w-[48rem]`}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>Cluster</th>
                      <th className={tbl.th}>Saúde</th>
                      <th className={`${tbl.th} text-right`}>Nós</th>
                      <th className={tbl.th}>CPU (cores)</th>
                      <th className={tbl.th}>Memória</th>
                      <th className={`${tbl.th} text-right`}>Pods</th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {u.clusters.map((c) => (
                      <tr key={c.cluster_id} className={tbl.tr}>
                        <td className={tbl.td}>
                          <div className="flex items-start gap-2">
                            <ResourceIcon kind="k8s" className="mt-0.5" />
                            <div>
                              <Link href={`/kubernetes/${c.cluster_id}`} className={tbl.link}>
                                {c.name}
                              </Link>
                              <div className="text-xs text-slate-500">coletado {ago(c.collected_at)}</div>
                            </div>
                          </div>
                        </td>
                        <td className={tbl.td}>
                          <HealthBadge s={c.health ? { health: c.health } : null} />
                        </td>
                        <td className={`${tbl.td} text-right tabular-nums`}>
                          {c.nodes_ready}/{c.nodes}
                        </td>
                        <td className={`${tbl.td} w-48`}>
                          <UsageMeter
                            usage={c.cpu_usage}
                            requests={c.cpu_requests}
                            allocatable={c.cpu_allocatable}
                            format={cores}
                            what="CPU"
                          />
                        </td>
                        <td className={`${tbl.td} w-48`}>
                          <UsageMeter
                            usage={c.mem_usage}
                            requests={c.mem_requests}
                            allocatable={c.mem_allocatable}
                            format={bytes}
                            what="Memória"
                          />
                        </td>
                        <td className={`${tbl.td} text-right tabular-nums`}>{c.pods}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

type View = "costs" | "usage";
const VIEW_TABS = [
  { key: "costs", label: "Custos" },
  { key: "usage", label: "Uso de recursos" },
] as const;

/** A client's billing as its visibility allows: costs + usage, usage only, or nothing. */
function TenantBilling({ tenantId }: { tenantId: string }) {
  const { tenant } = useSession();
  const visibility = useCostVisibility();
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const [view, setView] = useState<View>("costs");
  const full = visibility === "full";
  const shown: View = full ? view : "usage";
  return (
    <div className="space-y-6">
      <PageHeader
        title={full ? "Custos e uso" : "Uso de recursos"}
        breadcrumbs={[{ label: full ? "Custos" : "Consumo" }, { label: tenant?.name ?? "Cliente" }]}
        description={
          <>
            Cliente <strong className="font-medium text-slate-900 dark:text-slate-100">{tenant?.name}</strong> ·{" "}
            {monthLabel(month)}
          </>
        }
        actions={
          visibility !== "none" && (
            <>
              <MonthPicker value={month} onChange={setMonth} />
              <ScopeToggle />
            </>
          )
        }
        tabs={full ? VIEW_TABS : undefined}
        activeTab={shown}
        onTab={setView}
      />
      {visibility === "none" && (
        <Alert variant="info" title="Indisponível">
          Os custos e o consumo deste cliente não estão disponíveis no console.
        </Alert>
      )}
      {visibility &&
        visibility !== "none" &&
        (shown === "costs" ? (
          <TenantCosts tenantId={tenantId} month={month} />
        ) : (
          <TenantUsage tenantId={tenantId} month={month} />
        ))}
    </div>
  );
}

/** Platform admins: cost of every client; picking one opens its detail. */
function PlatformCosts() {
  const { selectTenant } = useSession();
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const [filter, setFilter] = useState("");
  const summary = useQuery({
    queryKey: ["admin", "billing", "summary", month],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/billing/summary", { params: { query: { month } } })),
    refetchInterval: 60_000,
  });
  const s = summary.data;
  const cur = s?.currency ?? "BRL";
  const q = filter.trim().toLowerCase();
  const tenants = (s?.tenants ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q),
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Custos"
        breadcrumbs={[{ label: "Custos" }, { label: "Toda a plataforma" }]}
        description={<>Toda a plataforma · {monthLabel(month)}</>}
        actions={
          <>
            <MonthPicker value={month} onChange={setMonth} />
            <ScopeToggle />
          </>
        }
      />
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
            flush
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
                <Icon name="download" /> Exportar CSV
              </Button>
            }
          >
            {s.tenants.length === 0 ? (
              <Empty icon="building">Nenhum cliente.</Empty>
            ) : (
              <>
                <Toolbar count={`${tenants.length} de ${s.tenants.length} clientes`}>
                  <SearchInput value={filter} onChange={setFilter} placeholder="Filtrar cliente…" />
                </Toolbar>
                <div className={tbl.wrap}>
                  <table className={`${tbl.table} min-w-[40rem]`}>
                    <thead className={tbl.thead}>
                      <tr>
                        <th className={tbl.th}>Cliente</th>
                        <th className={tbl.th}>Tabela de preços</th>
                        <th className={`${tbl.th} text-right`}>No mês</th>
                        {s.current && <th className={`${tbl.th} text-right`}>Custo atual/mês</th>}
                        {s.current && <th className={`${tbl.th} text-right`}>Previsão</th>}
                        <th className={tbl.th}>
                          <span className="sr-only">Ações</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className={tbl.tbody}>
                      {tenants.map((t) => (
                        <tr key={t.tenant_id} className={tbl.tr}>
                          <td className={tbl.td}>
                            <div className="flex items-start gap-2">
                              <ResourceIcon kind="tenant" className="mt-0.5" />
                              <div>
                                <button type="button" onClick={() => selectTenant(t.tenant_id)} className={tbl.link}>
                                  {t.name}
                                </button>
                                <div className="text-xs text-slate-500">{t.slug}</div>
                              </div>
                            </div>
                          </td>
                          <td className={`${tbl.td} text-slate-600 dark:text-slate-400`}>
                            {t.price_table ?? "—"}
                            {!t.custom_price_table && t.price_table && <span className="text-xs"> (padrão)</span>}
                            {t.cost_visibility !== "full" && (
                              <div className="mt-0.5">
                                <Badge tone="amber">
                                  {t.cost_visibility === "usage" ? "cliente vê só o uso" : "oculto para o cliente"}
                                </Badge>
                              </div>
                            )}
                          </td>
                          <td className={`${tbl.td} text-right font-medium tabular-nums`}>{money(t.accrued, cur)}</td>
                          {s.current && <td className={`${tbl.td} text-right tabular-nums`}>{money(t.run_rate_monthly, cur)}</td>}
                          {s.current && <td className={`${tbl.td} text-right tabular-nums`}>{money(t.forecast, cur)}</td>}
                          <td className={`${tbl.td} w-12 text-right`}>
                            <Menu
                              ariaLabel={`Ações de ${t.name}`}
                              items={[{ label: "Detalhar custos", onClick: () => selectTenant(t.tenant_id) }]}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {tenants.length === 0 && <Empty>Nenhum cliente com esse nome.</Empty>}
              </>
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
  return <TenantBilling tenantId={tenantId} />;
}
