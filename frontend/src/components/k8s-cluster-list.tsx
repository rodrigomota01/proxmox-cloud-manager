"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import {
  ago,
  bytes,
  cores,
  day,
  daysText,
  DownloadKubeconfig,
  ExpiryBadge,
  HealthBadge,
  type K8sCluster,
  type K8sMode,
  LinkTenantDialog,
  ManagedState,
  rich,
  UsageMeter,
} from "@/components/k8s";
import { Icon } from "@/components/icons";
import { Menu, PageHeader, ResourceIcon, SearchInput, StatTile, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Textarea, tbl } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { type MessageKey, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";

function AddClusterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async (body: { name: string; kubeconfig: string }) =>
      unwrap(await api.POST("/api/v1/admin/kubernetes/clusters", { body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "k8s-clusters"] });
      close();
    },
  });
  const close = () => {
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={t("k8s.add.title")}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({ name: String(f.get("name")).trim(), kubeconfig: String(f.get("kubeconfig")) });
        }}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {rich(t("k8s.add.intro"), { table: <code>kubernetes_clusters</code> })}
        </p>
        <Field label={t("k8s.common.name")}>
          <Input name="name" required maxLength={100} placeholder="pluxee-prod-cluster" />
        </Field>
        <Field label="Kubeconfig" hint={t("k8s.add.kubeconfigHint")}>
          <Textarea name="kubeconfig" required rows={8} spellCheck={false} autoComplete="off" />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            {t("k8s.common.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t("k8s.add.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const HEALTH_FILTER: { value: string; label: MessageKey }[] = [
  { value: "", label: "k8s.healthFilter.any" },
  { value: "healthy", label: "k8s.healthFilter.healthy" },
  { value: "warning", label: "k8s.healthFilter.warning" },
  { value: "critical", label: "k8s.healthFilter.critical" },
  { value: "unreachable", label: "k8s.healthFilter.unreachable" },
  { value: "none", label: "k8s.healthFilter.none" },
];

/** Container-width breakpoints of the table: WIDE cells show from the width up, NARROW ones
 * (the folded version of the same data) only below it. */
const WIDE = { client: "hidden @[84rem]:table-cell", counts: "hidden @5xl:table-cell", usage: "hidden @6xl:table-cell" };
const NARROW = { client: "@[84rem]:hidden", counts: "@5xl:hidden", usage: "@6xl:hidden" };

/** Admin: every cluster, with registration, kubeconfig and the client link. Tenant: the
 * clusters linked to the client, read-only and without any kubeconfig action. */
export function K8sClusterList({ mode }: { mode: K8sMode }) {
  const t = useT();
  const { tenantId, tenant } = useSession();
  const admin = mode === "admin";
  const base = admin ? "/admin/kubernetes" : "/kubernetes";
  const [linking, setLinking] = useState<K8sCluster | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [health, setHealth] = useState("");
  const clusters = useQuery({
    queryKey: admin ? ["admin", "k8s-clusters"] : ["k8s-clusters", tenantId],
    queryFn: async () =>
      admin
        ? unwrap(await api.GET("/api/v1/admin/kubernetes/clusters"))
        : unwrap(await api.GET("/api/v1/kubernetes/clusters")),
    enabled: admin || tenantId !== null,
    refetchInterval: 30_000,
  });
  const data = clusters.data ?? [];
  const snaps = data.flatMap((c) => (c.snapshot ? [c.snapshot] : []));
  const count = (h: string) => snaps.filter((s) => s.health === h).length;
  const sum = (k: "nodes" | "nodes_ready" | "pods" | "pods_problem" | "namespaces") =>
    snaps.reduce((a, s) => a + s[k], 0);
  const q = filter.trim().toLowerCase();
  const rows = data.filter(
    (c) =>
      (!q || c.name.toLowerCase().includes(q) || (c.tenant_name ?? "").toLowerCase().includes(q)) &&
      (!health || (health === "none" ? !c.snapshot : c.snapshot?.health === health)),
  );
  const bad = count("critical") + count("unreachable");

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("k8s.list.title")}
        breadcrumbs={[{ label: "Kubernetes" }, { label: t("k8s.common.clusters") }]}
        description={
          admin ? (
          <>{rich(t("k8s.list.adminDescription"), { table: <code>kubernetes_clusters</code> })}</>
          ) : (
            t("k8s.list.tenantDescription", { client: tenant?.name ?? t("k8s.list.yourClient") })
          )
        }
        actions={
          <>
            <Link href={`${base}/new`}>
              <Button>
                <Icon name="plus" /> {t("k8s.common.createCluster")}
              </Button>
            </Link>
            {admin && (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                {t("k8s.list.registerExisting")}
              </Button>
            )}
          </>
        }
      />
      <ErrorBox message={clusters.isError ? errorMessage(clusters.error) : null} />

      {snaps.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            icon="kubernetes"
            tone={bad ? "error" : count("warning") ? "warn" : "ok"}
            label={t("k8s.common.clusters")}
            value={data.length}
            hint={t("k8s.list.clustersHint", {
              healthy: count("healthy"),
              warning: count("warning"),
              critical: count("critical"),
              unreachable: count("unreachable"),
            })}
          />
          <StatTile
            icon="server"
            tone={sum("nodes_ready") < sum("nodes") ? "warn" : undefined}
            label={t("k8s.common.nodesReady")}
            value={t("k8s.common.nodesReadyValue", { ready: sum("nodes_ready"), total: sum("nodes") })}
          />
          <StatTile
            icon="layers"
            tone={sum("pods_problem") ? "warn" : undefined}
            label="Pods"
            value={sum("pods")}
            hint={t("k8s.common.withProblems", { count: sum("pods_problem") })}
          />
          <StatTile icon="folder" label="Namespaces" value={sum("namespaces")} />
        </div>
      )}

      <Card flush>
        {clusters.data && data.length === 0 ? (
          admin ? (
            <Empty
              icon="kubernetes"
              title={t("k8s.common.noClusters")}
              action={
                <Button onClick={() => setAdding(true)}>
                  <Icon name="plus" /> {t("k8s.list.addCluster")}
                </Button>
              }
            >
              {t("k8s.list.emptyAdmin")}
            </Empty>
          ) : (
            <Empty
              icon="kubernetes"
              title={t("k8s.common.noClusters")}
              action={
                <Link href={`${base}/new`}>
                  <Button>
                    <Icon name="plus" /> {t("k8s.common.createCluster")}
                  </Button>
                </Link>
              }
            >
              {t("k8s.list.emptyTenant")}
            </Empty>
          )
        ) : (
          <>
            <Toolbar count={t("k8s.list.count", { shown: rows.length, total: data.length })}>
              <SearchInput value={filter} onChange={setFilter} placeholder={admin ? t("k8s.list.filterPlaceholder") : undefined} />
              <Select aria-label={t("k8s.list.health")} value={health} onChange={(e) => setHealth(e.target.value)}>
                {HEALTH_FILTER.map((h) => (
                  <option key={h.value} value={h.value}>
                    {t(h.label)}
                  </option>
                ))}
              </Select>
            </Toolbar>
            {/* Columns fold by the card's width (container queries), not the viewport's: below
                @6xl CPU and memory share a "Uso" column, below @5xl nodes and pods move under
                the health, and the client moves under the cluster name below @[84rem]. */}
            <div className={`${tbl.wrap} @container`}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Cluster</th>
                    {admin && <th className={`${tbl.th} ${WIDE.client}`}>{t("k8s.common.client")}</th>}
                    <th className={tbl.th}>{t("k8s.list.health")}</th>
                    <th className={`${tbl.th} ${WIDE.counts}`}>{t("k8s.common.nodes")}</th>
                    <th className={`${tbl.th} ${WIDE.counts}`}>Pods</th>
                    <th className={`${tbl.th} ${NARROW.usage}`}>{t("k8s.list.usage")}</th>
                    <th className={`${tbl.th} ${WIDE.usage}`}>CPU</th>
                    <th className={`${tbl.th} ${WIDE.usage}`}>{t("k8s.common.memory")}</th>
                    <th className={tbl.th}>{t("k8s.common.certificate")}</th>
                    {admin && (
                      <th className={tbl.th}>
                        <span className="sr-only">{t("k8s.common.actions")}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {rows.map((c) => {
                    const s = c.snapshot;
                    return (
                      <tr key={c.id} className={`${tbl.tr} align-top`}>
                        <td className={tbl.td}>
                          <div className="flex items-start gap-2">
                            <ResourceIcon kind="k8s" className="mt-0.5" />
                            <div className="min-w-0">
                              <Link href={`${base}/${c.id}`} className={tbl.link}>
                                {c.name}
                              </Link>
                              {admin && c.source === "manual" && (
                                <span className="ml-1.5">
                                  <Badge>manual</Badge>
                                </span>
                              )}
                              {admin && c.tenant_name && (
                                <div className={`text-xs text-slate-600 dark:text-slate-400 ${NARROW.client}`}>{c.tenant_name}</div>
                              )}
                              <div
                                className="max-w-[14rem] truncate font-mono text-xs text-slate-500"
                                title={c.server_url ?? c.api_server ?? undefined}
                              >
                                {c.server_url ?? c.api_server ?? "—"}
                              </div>
                              {s?.version && (
                                <div className="text-xs text-slate-500">
                                  {s.version}
                                  {s.ok_at && ` · ${s.ingresses} Ingress${s.gateway_api ? ` · ${s.httproutes} HTTPRoute` : ""}`}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        {admin && (
                          <td className={`${tbl.td} whitespace-nowrap ${WIDE.client}`}>
                            {c.tenant_name ?? <span className="text-slate-400">—</span>}
                          </td>
                        )}
                        <td className={`${tbl.td} whitespace-nowrap`}>
                          {c.managed && c.managed.state !== "active" ? <ManagedState c={c} /> : <HealthBadge s={s} />}
                          {s && s.reasons.length > 0 && (
                            <div className="mt-0.5 max-w-[16rem] whitespace-normal text-xs text-slate-600 dark:text-slate-400">{s.reasons[0]}</div>
                          )}
                          {s && (
                            <div className={`text-xs tabular-nums text-slate-600 dark:text-slate-400 ${NARROW.counts}`}>
                              {t("k8s.list.nodesPods", { ready: s.nodes_ready, total: s.nodes, pods: s.pods })}
                              {s.pods_problem > 0 && (
                                <span className="text-rose-600 dark:text-rose-400">{t("k8s.list.withProblemsParen", { count: s.pods_problem })}</span>
                              )}
                            </div>
                          )}
                          {s && <div className="text-xs text-slate-500">{t("k8s.common.readAgo", { ago: ago(s.ok_at) })}</div>}
                        </td>
                        <td className={`${tbl.td} tabular-nums ${WIDE.counts}`}>{s ? `${s.nodes_ready}/${s.nodes}` : "—"}</td>
                        <td className={`${tbl.td} tabular-nums ${WIDE.counts}`}>
                          {s ? s.pods : "—"}
                          {s && s.pods_problem > 0 && <div className="text-xs text-rose-600 dark:text-rose-400">{t("k8s.common.withProblems", { count: s.pods_problem })}</div>}
                        </td>
                        <td className={`${tbl.td} ${NARROW.usage}`}>
                          {s && s.nodes > 0 ? (
                            <div className="space-y-2">
                              <UsageMeter usage={s.cpu_usage} requests={s.cpu_requests} allocatable={s.cpu_allocatable} format={cores} what="CPU" stacked />
                              <UsageMeter usage={s.mem_usage} requests={s.mem_requests} allocatable={s.mem_allocatable} format={bytes} what={t("k8s.common.memory")} stacked />
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={`${tbl.td} ${WIDE.usage}`}>
                          {s && s.nodes > 0 ? (
                            <UsageMeter usage={s.cpu_usage} requests={s.cpu_requests} allocatable={s.cpu_allocatable} format={cores} what="CPU" stacked />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={`${tbl.td} ${WIDE.usage}`}>
                          {s && s.nodes > 0 ? (
                            <UsageMeter usage={s.mem_usage} requests={s.mem_requests} allocatable={s.mem_allocatable} format={bytes} what={t("k8s.common.memory")} stacked />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={`${tbl.td} whitespace-nowrap`}>
                          <ExpiryBadge c={c} />
                          <div className="text-xs tabular-nums text-slate-500">
                            {day(c.expires_on)}
                            {c.days_left !== null && ` · ${daysText(c.days_left)}`}
                          </div>
                          {c.dates_differ && (
                            <div className="text-xs font-medium text-amber-700 dark:text-amber-300">{t("k8s.list.datesDiffer")}</div>
                          )}
                        </td>
                        {admin && (
                          <td className={`${tbl.td} text-right`}>
                            <div className="flex items-center justify-end gap-1">
                              <DownloadKubeconfig c={c} labelClassName="hidden @7xl:inline" />
                              {c.source !== "managed" && (
                              <Menu
                                ariaLabel={t("k8s.list.actionsOf", { name: c.name })}
                                items={[
                                  {
                                    label: t(c.tenant_id ? "k8s.common.changeTenant" : "k8s.common.linkTenant"),
                                    onClick: () => setLinking(c),
                                  },
                                ]}
                              />
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && data.length > 0 && <Empty>{t("k8s.list.noMatch")}</Empty>}
          </>
        )}
      </Card>
      <Alert variant="info">
        {t("k8s.list.metricsNote")}
      </Alert>
      {admin && <AddClusterDialog open={adding} onClose={() => setAdding(false)} />}
      <LinkTenantDialog cluster={linking} onClose={() => setLinking(null)} />
    </div>
  );
}
