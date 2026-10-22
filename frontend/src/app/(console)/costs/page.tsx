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
import { money, monthLabel, num, recentMonths, resourceLabel } from "@/lib/money";
import { useCostVisibility, useProjectNames } from "@/lib/queries";
import { usePermissions, useSession } from "@/lib/session";
import { getLocale, useT, type MessageKey } from "@/lib/i18n";

function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const t = useT();
  return (
    <Select aria-label={t("costs.month")} value={value} onChange={(e) => onChange(e.target.value)}>
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

const BREAKDOWN: { key: "vcpu" | "memory" | "disk" | "instance"; label: MessageKey }[] = [
  { key: "vcpu", label: "costs.resources.vcpu" },
  { key: "memory", label: "costs.breakdown.memory" },
  { key: "disk", label: "costs.breakdown.disk" },
  { key: "instance", label: "costs.resources.instance" },
];

/** The API reports only the user's projects without billing:view on the whole client. */
function useProjectScoped(tenantId: string) {
  const { isPlatformAdmin } = useSession();
  const tenantPerms = usePermissions(`tenant:${tenantId}`);
  return !isPlatformAdmin && !tenantPerms.has("billing:view");
}

const denied403 = (count: number, err: unknown) => !(err instanceof ApiError && err.status === 403) && count < 2;

function TenantCosts({ tenantId, month }: { tenantId: string; month: string }) {
  const t = useT();
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
  const cur = s?.currency ?? "USD";
  const denied = summary.error instanceof ApiError && summary.error.status === 403;

  function exportCsv(data: Schemas["CostSummaryOut"]) {
    const tenantSlug = tenant?.slug ?? t("costs.csv.fallbackSlug");
    downloadCsv(t("costs.csv.costsFile", { tenant: tenantSlug, month: data.month }), [
      [t("costs.csv.instance"), t("costs.csv.project"), t("costs.csv.kind"), "vcpus", t("costs.csv.memoryMb"),
        t("costs.csv.diskGb"), t("costs.csv.hours"), t("costs.csv.runningHours"), t("costs.csv.costVcpu"),
        t("costs.csv.costMemory"), t("costs.csv.costDisk"), t("costs.csv.costInstance"), "total",
        t("costs.csv.runRateMonthly"), t("costs.csv.deleted")],
      ...data.instances.map((i) => [
        i.name, projectNames.get(i.project_id ?? "") ?? "", i.kind, i.vcpus, i.memory_mb, i.disk_gb,
        i.hours, i.running_hours, i.accrued.vcpu, i.accrued.memory, i.accrued.disk, i.accrued.instance,
        i.accrued.total, i.run_rate_monthly, i.deleted ? t("costs.csv.yes") : t("costs.csv.no"),
      ]),
    ]);
  }

  const q = filter.trim().toLowerCase();
  const instances = (s?.instances ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));

  return (
    <>
      {denied ? (
        <Alert variant="warning" title={t("costs.noAccess")}>
          {t("costs.tenant.noAccessBody")}
        </Alert>
      ) : (
        <ErrorBox message={summary.isError ? errorMessage(summary.error) : null} />
      )}
      {s && projectScoped && <Alert variant="info">{t("costs.tenant.projectScoped")}</Alert>}
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
            <Card title={t("costs.tenant.costPerDay")} className="lg:col-span-2">
              <DailyCostBars month={s.month} days={s.days} currency={cur} />
            </Card>
            <Card title={t("costs.tenant.byResource")} flush>
              <table className={tbl.table}>
                <tbody className={tbl.tbody}>
                  {BREAKDOWN.map((b) => (
                    <tr key={b.key} className={tbl.tr}>
                      <td className={tbl.td}>{t(b.label)}</td>
                      <td className={`${tbl.td} text-right tabular-nums`}>{money(s.accrued[b.key], cur)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
                    <td className={tbl.td}>{t("costs.tenant.total")}</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{money(s.accrued.total, cur)}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
          </div>

          <Card title={t("costs.tenant.byProject")} flush>
            {s.projects.length === 0 ? (
              <Empty icon="folder">{t("costs.tenant.noCosts")}</Empty>
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>{t("costs.table.project")}</th>
                      <th className={`${tbl.th} text-right`}>{t("costs.table.thisMonth")}</th>
                      {s.current && <th className={`${tbl.th} text-right`}>{t("costs.table.runRateMonth")}</th>}
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
                            <span className="text-slate-500">{t("costs.noProject")}</span>
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
            title={t("costs.tenant.byInstance")}
            flush
            actions={
              s.instances.length > 0 && (
                <Button variant="secondary" onClick={() => exportCsv(s)}>
                  <Icon name="download" /> {t("costs.exportCsv")}
                </Button>
              )
            }
          >
            {s.instances.length === 0 ? (
              <Empty icon="monitor">{t("costs.tenant.noInstances")}</Empty>
            ) : (
              <>
                <Toolbar count={t("costs.tenant.instancesCount", { shown: instances.length, total: s.instances.length })}>
                  <SearchInput value={filter} onChange={setFilter} />
                </Toolbar>
                <div className={tbl.wrap}>
                  <table className={`${tbl.table} min-w-[44rem]`}>
                    <thead className={tbl.thead}>
                      <tr>
                        <th className={tbl.th}>{t("costs.tenant.instance")}</th>
                        <th className={tbl.th}>{t("costs.tenant.resources")}</th>
                        <th className={`${tbl.th} text-right`}>{t("costs.table.hoursRunning")}</th>
                        <th className={`${tbl.th} text-right`}>{t("costs.table.thisMonth")}</th>
                        {s.current && <th className={`${tbl.th} text-right`}>{t("costs.table.runRateMonth")}</th>}
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
                                  {i.deleted ? <Badge>{t("costs.deleted")}</Badge> : <PowerBadge state={i.power_state} />}
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
                {instances.length === 0 && <Empty>{t("costs.tenant.noInstanceMatch")}</Empty>}
              </>
            )}
          </Card>

          <Card
            title={
              s.prices.price_table
                ? t("costs.tenant.priceTableNamed", { name: s.prices.price_table })
                : t("costs.tenant.priceTable")
            }
            description={t("costs.tenant.priceTableDescription", { hours: s.prices.hours_per_month })}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(s.prices.prices).map(([r, p]) => (
                <div key={r} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
                  <div className="text-xs text-slate-500">{resourceLabel(r)}</div>
                  <div className="font-semibold tabular-nums">{t("costs.tiles.perMonth", { value: money(p, cur, true) })}</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

const hrs = (v: string | number) => num(v).toLocaleString(getLocale(), { maximumFractionDigits: 1 });

/** Consumed and allocated resources, without prices: the client's VMs (same project
 * rules as the costs) and the Kubernetes clusters linked to it. */
function TenantUsage({ tenantId, month }: { tenantId: string; month: string }) {
  const t = useT();
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
    const tenantSlug = tenant?.slug ?? t("costs.csv.fallbackSlug");
    downloadCsv(t("costs.csv.usageFile", { tenant: tenantSlug, month: data.month }), [
      [t("costs.csv.instance"), t("costs.csv.project"), t("costs.csv.kind"), "vcpus", t("costs.csv.memoryMb"),
        t("costs.csv.diskGb"), t("costs.csv.hours"), t("costs.csv.runningHours"), t("costs.csv.vcpuHours"),
        t("costs.csv.memoryGibHours"), t("costs.csv.diskGibHours"), t("costs.csv.deleted")],
      ...data.instances.map((i) => [
        i.name, projectNames.get(i.project_id ?? "") ?? "", i.kind, i.vcpus, i.memory_mb, i.disk_gb,
        i.hours, i.running_hours, i.vcpu_hours, i.memory_gib_hours, i.disk_gib_hours,
        i.deleted ? t("costs.csv.yes") : t("costs.csv.no"),
      ]),
    ]);
  }

  return (
    <>
      {denied ? (
        <Alert variant="warning" title={t("costs.noAccess")}>
          {t("costs.usage.noAccessBody")}
        </Alert>
      ) : (
        <ErrorBox message={usage.isError ? errorMessage(usage.error) : null} />
      )}
      {u && projectScoped && <Alert variant="info">{t("costs.usage.projectScoped")}</Alert>}
      {u && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              icon="monitor"
              label={t("costs.usage.allocatedNow")}
              value={`${u.allocated.vcpus} vCPU · ${mib(u.allocated.memory_mb)}`}
              hint={t("costs.usage.allocatedHint", {
                disk: u.allocated.disk_gb,
                instances: u.allocated.instances,
                running: u.allocated.running,
              })}
            />
            <StatTile icon="dashboard" label={t("costs.usage.vcpuHoursMonth")} value={hrs(u.consumed.vcpu_hours)} hint={t("costs.usage.whileRunning")} />
            <StatTile icon="layers" label={t("costs.usage.memoryHours")} value={hrs(u.consumed.memory_gib_hours)} hint={t("costs.usage.whileRunning")} />
            <StatTile icon="server" label={t("costs.usage.diskHours")} value={hrs(u.consumed.disk_gib_hours)} hint={t("costs.usage.whileExisting")} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={t("costs.usage.vcpuHoursPerDay")} className="lg:col-span-2">
              <DailyBars
                month={u.month}
                days={u.days.map((d) => ({ date: d.date, value: num(d.vcpu_hours) }))}
                format={(v) => `${hrs(v)} vCPU·h`}
                what={t("costs.usage.vcpuHour")}
              />
            </Card>
            <Card title={t("costs.tenant.byProject")} flush>
              {u.projects.length === 0 ? (
                <Empty icon="folder">{t("costs.usage.noUsage")}</Empty>
              ) : (
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>{t("costs.table.project")}</th>
                      <th className={`${tbl.th} text-right`}>vCPU·h</th>
                      <th className={`${tbl.th} text-right`}>{t("costs.usage.ramHours")}</th>
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
                            <span className="text-slate-500">{t("costs.noProject")}</span>
                          )}
                          <div className="text-xs text-slate-500">{t("costs.usage.vmsCount", { count: p.instances })}</div>
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
            title={t("costs.usage.vmsTitle")}
            description={t("costs.usage.vmsDescription")}
            flush
            actions={
              u.instances.length > 0 && (
                <Button variant="secondary" onClick={() => exportCsv(u)}>
                  <Icon name="download" /> {t("costs.exportCsv")}
                </Button>
              )
            }
          >
            {u.instances.length === 0 ? (
              <Empty icon="monitor">{t("costs.usage.noVms")}</Empty>
            ) : (
              <>
                <Toolbar count={t("costs.usage.vmsFiltered", { shown: instances.length, total: u.instances.length })}>
                  <SearchInput value={filter} onChange={setFilter} />
                </Toolbar>
                <div className={tbl.wrap}>
                  <table className={`${tbl.table} min-w-[48rem]`}>
                    <thead className={tbl.thead}>
                      <tr>
                        <th className={tbl.th}>VM</th>
                        <th className={tbl.th}>{t("costs.usage.allocated")}</th>
                        <th className={`${tbl.th} text-right`}>{t("costs.table.hoursRunning")}</th>
                        <th className={`${tbl.th} text-right`}>vCPU·h</th>
                        <th className={`${tbl.th} text-right`}>{t("costs.usage.ramHours")}</th>
                        <th className={`${tbl.th} text-right`}>{t("costs.usage.diskGibHours")}</th>
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
                                  {i.deleted ? <Badge>{t("costs.deleted")}</Badge> : <PowerBadge state={i.power_state} />}
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
                {instances.length === 0 && <Empty>{t("costs.usage.noVmMatch")}</Empty>}
              </>
            )}
          </Card>

          {u.clusters.length > 0 && (
            <Card
              title={t("costs.usage.clustersTitle")}
              description={t("costs.usage.clustersDescription")}
              flush
            >
              <div className={tbl.wrap}>
                <table className={`${tbl.table} min-w-[48rem]`}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>Cluster</th>
                      <th className={tbl.th}>{t("costs.usage.health")}</th>
                      <th className={`${tbl.th} text-right`}>{t("costs.usage.nodes")}</th>
                      <th className={tbl.th}>{t("costs.usage.cpuCores")}</th>
                      <th className={tbl.th}>{t("costs.usage.memory")}</th>
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
                              <div className="text-xs text-slate-500">{t("costs.usage.collected", { ago: ago(c.collected_at) })}</div>
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
                            what={t("costs.usage.memory")}
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
const VIEW_TABS: { key: View; label: MessageKey }[] = [
  { key: "costs", label: "costs.billing.costs" },
  { key: "usage", label: "costs.billing.resourceUsage" },
];

/** A client's billing as its visibility allows: costs + usage, usage only, or nothing. */
function TenantBilling({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { tenant } = useSession();
  const visibility = useCostVisibility();
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const [view, setView] = useState<View>("costs");
  const full = visibility === "full";
  const shown: View = full ? view : "usage";
  return (
    <div className="space-y-6">
      <PageHeader
        title={full ? t("costs.billing.costsAndUsage") : t("costs.billing.resourceUsage")}
        breadcrumbs={[
          { label: full ? t("costs.billing.costs") : t("costs.billing.consumption") },
          { label: tenant?.name ?? t("costs.billing.client") },
        ]}
        description={
          <>
            {t("costs.billing.client")} <strong className="font-medium text-slate-900 dark:text-slate-100">{tenant?.name}</strong> ·{" "}
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
        tabs={full ? VIEW_TABS.map((tab) => ({ key: tab.key, label: t(tab.label) })) : undefined}
        activeTab={shown}
        onTab={setView}
      />
      {visibility === "none" && (
        <Alert variant="info" title={t("costs.billing.unavailable")}>
          {t("costs.billing.unavailableBody")}
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
  const t = useT();
  const { selectTenant } = useSession();
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const [filter, setFilter] = useState("");
  const summary = useQuery({
    queryKey: ["admin", "billing", "summary", month],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/billing/summary", { params: { query: { month } } })),
    refetchInterval: 60_000,
  });
  const s = summary.data;
  const cur = s?.currency ?? "USD";
  const q = filter.trim().toLowerCase();
  const tenants = (s?.tenants ?? []).filter(
    (row) => !q || row.name.toLowerCase().includes(q) || row.slug.toLowerCase().includes(q),
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("costs.platform.title")}
        breadcrumbs={[{ label: t("costs.platform.title") }, { label: t("costs.platform.wholePlatform") }]}
        description={<>{t("costs.platform.wholePlatform")} · {monthLabel(month)}</>}
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
          <Card title={t("costs.tenant.costPerDay")}>
            <DailyCostBars month={s.month} days={s.days} currency={cur} />
          </Card>
          <Card
            title={t("costs.preview.perClient")}
            flush
            actions={
              <Button
                variant="secondary"
                onClick={() =>
                  downloadCsv(t("costs.csv.clientsFile", { month: s.month }), [
                    [t("costs.csv.client"), t("costs.csv.slug"), t("costs.csv.priceTable"), t("costs.csv.accrued"),
                      t("costs.csv.runRateMonthly"), t("costs.csv.forecast")],
                    ...s.tenants.map((row) => [row.name, row.slug, row.price_table ?? "", row.accrued, row.run_rate_monthly, row.forecast ?? ""]),
                  ])
                }
              >
                <Icon name="download" /> {t("costs.exportCsv")}
              </Button>
            }
          >
            {s.tenants.length === 0 ? (
              <Empty icon="building">{t("costs.platform.noClients")}</Empty>
            ) : (
              <>
                <Toolbar count={t("costs.platform.clientsCount", { shown: tenants.length, total: s.tenants.length })}>
                  <SearchInput value={filter} onChange={setFilter} placeholder={t("costs.platform.filterClient")} />
                </Toolbar>
                <div className={tbl.wrap}>
                  <table className={`${tbl.table} min-w-[40rem]`}>
                    <thead className={tbl.thead}>
                      <tr>
                        <th className={tbl.th}>{t("costs.table.client")}</th>
                        <th className={tbl.th}>{t("costs.table.priceTable")}</th>
                        <th className={`${tbl.th} text-right`}>{t("costs.table.thisMonth")}</th>
                        {s.current && <th className={`${tbl.th} text-right`}>{t("costs.table.runRateMonth")}</th>}
                        {s.current && <th className={`${tbl.th} text-right`}>{t("costs.table.forecast")}</th>}
                        <th className={tbl.th}>
                          <span className="sr-only">{t("common.actions")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className={tbl.tbody}>
                      {tenants.map((row) => (
                        <tr key={row.tenant_id} className={tbl.tr}>
                          <td className={tbl.td}>
                            <div className="flex items-start gap-2">
                              <ResourceIcon kind="tenant" className="mt-0.5" />
                              <div>
                                <button type="button" onClick={() => selectTenant(row.tenant_id)} className={tbl.link}>
                                  {row.name}
                                </button>
                                <div className="text-xs text-slate-500">{row.slug}</div>
                              </div>
                            </div>
                          </td>
                          <td className={`${tbl.td} text-slate-600 dark:text-slate-400`}>
                            {row.price_table ?? "—"}
                            {!row.custom_price_table && row.price_table && <span className="text-xs"> {t("costs.platform.default")}</span>}
                            {row.cost_visibility !== "full" && (
                              <div className="mt-0.5">
                                <Badge tone="amber">
                                  {row.cost_visibility === "usage" ? t("costs.platform.usageOnly") : t("costs.platform.hidden")}
                                </Badge>
                              </div>
                            )}
                          </td>
                          <td className={`${tbl.td} text-right font-medium tabular-nums`}>{money(row.accrued, cur)}</td>
                          {s.current && <td className={`${tbl.td} text-right tabular-nums`}>{money(row.run_rate_monthly, cur)}</td>}
                          {s.current && <td className={`${tbl.td} text-right tabular-nums`}>{money(row.forecast, cur)}</td>}
                          <td className={`${tbl.td} w-12 text-right`}>
                            <Menu
                              ariaLabel={t("costs.platform.actionsFor", { name: row.name })}
                              items={[{ label: t("costs.platform.drillDown"), onClick: () => selectTenant(row.tenant_id) }]}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {tenants.length === 0 && <Empty>{t("costs.platform.noClientMatch")}</Empty>}
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
