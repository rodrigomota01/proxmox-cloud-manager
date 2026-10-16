"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  ago,
  bytes,
  cores,
  day,
  daysText,
  DownloadKubeconfig,
  ExpiryBadge,
  DestroyClusterButton,
  HealthBadge,
  K8S_STEPS,
  type K8sMode,
  ManagedState,
  LinkTenantDialog,
  rich,
  UsageMeter,
} from "@/components/k8s";
import { Menu, PageHeader, ResourceIcon, SearchInput, StatTile, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Select, Status, Textarea, tbl } from "@/components/ui";
import { SortHeader, useSorted } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { type MessageKey, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";

type Detail = Schemas["K8sClusterDetail"];

const TABS = [
  { key: "overview", label: "k8s.detail.tabs.overview" },
  { key: "namespaces", label: "k8s.detail.tabs.namespaces" },
  { key: "workloads", label: "k8s.detail.tabs.workloads" },
  { key: "pods", label: "k8s.detail.tabs.pods" },
  { key: "services", label: "k8s.detail.tabs.services" },
  { key: "routes", label: "k8s.detail.tabs.routes" },
] as const satisfies readonly { key: string; label: MessageKey }[];
type Tab = (typeof TABS)[number]["key"];

const { th, thead, tbody, td } = tbl;
const tr = `${tbl.tr} align-top`;

function age(iso: string | null | undefined): string {
  return iso ? ago(iso, false) : "—";
}

/** Name over its namespace, the way every list of this page shows a resource. */
function NameCell({ name, sub }: { name: string | null; sub?: React.ReactNode }) {
  return (
    <>
      <div className="font-medium">{name ?? "—"}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </>
  );
}

/** The console's "Namespace: ▾" selector, in the toolbar of the filtered tabs. */
function NamespaceSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (ns: string) => void }) {
  const t = useT();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-medium text-slate-600 dark:text-slate-300">Namespace:</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Namespace">
        <option value="">{t("k8s.detail.allNamespaces")}</option>
        {options.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** A cluster the platform created: lifecycle, steps, pools and what was installed. */
function ManagedCard({ d }: { d: Detail }) {
  const t = useT();
  const m = d.managed;
  if (!m) return null;
  const current = K8S_STEPS.findIndex(([k]) => k === m.state_message);
  return (
    <div className="space-y-4">
      {m.state === "error" && (
        <Alert variant="danger" title={t("k8s.detail.createFailed")}>
          <p className="font-mono text-xs break-all">{m.state_message}</p>
          <p className="mt-1">{t("k8s.detail.createFailedNote")}</p>
        </Alert>
      )}
      {m.state === "provisioning" && (
        <Card title={t("k8s.detail.creating")} description={t("k8s.detail.creatingDescription")}>
          <ol className="space-y-1.5 text-sm">
            {K8S_STEPS.slice(1).map(([key, label], i) => {
              const idx = i + 1;
              const tone = idx < current ? "ok" : idx === current ? "progress" : "off";
              return (
                <li key={key}>
                  <Status tone={tone}>{t(label)}</Status>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
      <Card title={t("k8s.detail.managedTitle")}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Kubernetes", m.kubernetes_version],
            ["API", m.api_endpoint ? `https://${m.api_endpoint}:6443` : "—"],
            [t("k8s.detail.lbIp"), m.lb_ip ?? "—"],
            [t("k8s.detail.createdAt"), day(m.created_at)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-slate-500">{k}</dt>
              <dd className="font-mono">{v}</dd>
            </div>
          ))}
        </dl>
        <table className={`${tbl.table} mt-4`}>
          <thead className={thead}>
            <tr>
              <th className={th}>Pool</th>
              <th className={th}>{t("k8s.detail.role")}</th>
              <th className={`${th} text-right`}>{t("k8s.common.nodes")}</th>
              <th className={th}>{t("k8s.detail.nodeSize")}</th>
            </tr>
          </thead>
          <tbody className={tbody}>
            {m.pools.map((p) => (
              <tr key={p.id} className={tr}>
                <td className={`${td} font-medium`}>{p.name}</td>
                <td className={td}>{p.role === "control-plane" ? "control plane" : "worker"}</td>
                <td className={`${td} text-right tabular-nums`}>{p.count}</td>
                <td className={`${td} tabular-nums`}>
                  {p.vcpus} vCPU · {(p.memory_mb / 1024).toFixed(0)} GiB · {p.disk_gb} GiB
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-500">
          {rich(t("k8s.detail.componentsNote"), {
            components: Object.entries(m.components)
              .map(([k, v]) => `${k.replace("_", "-")} ${v}`)
              .join(" · "),
            httproute: <code>HTTPRoute</code>,
            gateway: <code>public</code>,
            namespace: <code>gateway</code>,
            prod: <code>letsencrypt</code>,
            staging: <code>letsencrypt-staging</code>,
          })}
        </p>
      </Card>
    </div>
  );
}

function Overview({ d }: { d: Detail }) {
  const t = useT();
  const s = d.snapshot;
  if (!s) {
    return (
      <div className="space-y-4">
        <ManagedCard d={d} />
        {(!d.managed || d.managed.state === "active") && (
          <Empty icon="kubernetes" title={t("k8s.detail.notCollected")}>
            {t("k8s.detail.firstRead")}
          </Empty>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ManagedCard d={d} />
      {s.health !== "healthy" && (
        <Alert variant={s.health === "critical" ? "danger" : "warning"} title={t("k8s.detail.attention")}>
          <ul className="list-inside list-disc space-y-0.5">
            {s.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
            {s.error && <li className="font-mono text-xs">{s.error}</li>}
          </ul>
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon="server"
          tone={s.nodes_ready < s.nodes ? "warn" : "ok"}
          label={t("k8s.common.nodesReady")}
          value={t("k8s.common.nodesReadyValue", { ready: s.nodes_ready, total: s.nodes })}
        />
        <StatTile
          icon="layers"
          tone={s.pods_problem ? "warn" : undefined}
          label="Pods"
          value={s.pods}
          hint={t("k8s.detail.podsHint", { running: s.pods_running, problems: s.pods_problem })}
        />
        <StatTile
          icon="dashboard"
          tone={s.workloads_unready ? "warn" : undefined}
          label="Workloads"
          value={s.workloads}
          hint={s.workloads_unready ? t("k8s.detail.workloadsUnready", { count: s.workloads_unready }) : t("k8s.detail.allReady")}
        />
        <StatTile
          icon="folder"
          label="Namespaces"
          value={s.namespaces}
          hint={t(s.gateway_api ? "k8s.detail.namespacesHintRoutes" : "k8s.detail.namespacesHint", {
            services: s.services,
            ingresses: s.ingresses,
            httproutes: s.httproutes,
          })}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t(s.metrics ? "k8s.detail.cpuInUse" : "k8s.detail.cpuReservedNoMetrics")}>
          <UsageMeter usage={s.cpu_usage} requests={s.cpu_requests} allocatable={s.cpu_allocatable} format={cores} what="CPU" />
          <p className="mt-2 text-xs text-slate-500">
            {t("k8s.detail.cpuReservedNote", { requests: cores(s.cpu_requests), allocatable: cores(s.cpu_allocatable) })}
          </p>
        </Card>
        <Card title={t(s.metrics ? "k8s.detail.memInUse" : "k8s.detail.memReservedNoMetrics")}>
          <UsageMeter usage={s.mem_usage} requests={s.mem_requests} allocatable={s.mem_allocatable} format={bytes} what={t("k8s.common.memory")} />
          <p className="mt-2 text-xs text-slate-500">
            {t("k8s.detail.memReservedNote", { requests: bytes(s.mem_requests), allocatable: bytes(s.mem_allocatable) })}
          </p>
        </Card>
      </div>
      <Card title={t("k8s.common.nodes")} description={t("k8s.detail.nodesCount", { count: d.k8s_nodes.length })} flush>
        <div className={tbl.wrap}>
          <table className={`${tbl.table} min-w-[56rem]`}>
            <thead className={thead}>
              <tr>
                <th className={th}>{t("k8s.detail.node")}</th>
                <th className={th}>{t("k8s.common.state")}</th>
                <th className={th}>CPU</th>
                <th className={th}>{t("k8s.common.memory")}</th>
                <th className={`${th} text-right`}>Pods</th>
                <th className={th}>{t("k8s.detail.version")}</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {d.k8s_nodes.map((n) => (
                <tr key={n.name} className={tr}>
                  <td className={td}>
                    <NameCell name={n.name} sub={`${n.roles.join(", ")} · ${n.ip ?? "—"}`} />
                  </td>
                  <td className={td}>
                    {n.ready ? <Status tone="ok">{t("k8s.detail.ready")}</Status> : <Status tone="error">{t("k8s.detail.down")}</Status>}
                    {n.unschedulable && <div className="text-xs text-amber-700 dark:text-amber-300">{t("k8s.detail.cordoned")}</div>}
                    {n.pressure.length > 0 && <div className="text-xs text-amber-700 dark:text-amber-300">⚠ {n.pressure.join(", ")}</div>}
                  </td>
                  <td className={td}>
                    <UsageMeter usage={n.cpu_usage} requests={n.cpu_requests} allocatable={n.cpu_allocatable} format={cores} what="CPU" />
                  </td>
                  <td className={td}>
                    <UsageMeter usage={n.mem_usage} requests={n.mem_requests} allocatable={n.mem_allocatable} format={bytes} what={t("k8s.common.memory")} />
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {n.pods}/{n.pods_capacity}
                  </td>
                  <td className={`${td} text-xs text-slate-600 dark:text-slate-400`}>
                    {n.version}
                    <div className="text-slate-500">{n.os}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Namespaces({ d, pick }: { d: Detail; pick: (ns: string) => void }) {
  const t = useT();
  const metrics = d.snapshot?.metrics ?? false;
  const [q, setQ] = useState("");
  const rows = d.namespaces.filter((n) => !q || n.name.includes(q));
  const { sorted, sort, toggle } = useSorted<Detail["namespaces"][number], "name" | "pods" | "problems" | "cpu" | "mem">(
    rows,
    {
      name: (n) => n.name,
      pods: (n) => n.pods,
      problems: (n) => n.problems,
      cpu: (n) => n.cpu_usage ?? n.cpu_requests,
      mem: (n) => n.mem_usage ?? n.mem_requests,
    },
    { key: "mem", desc: true },
  );
  return (
    <Card flush>
      <Toolbar count={t("k8s.detail.namespacesCount", { shown: rows.length, total: d.namespaces.length })}>
        <SearchInput value={q} onChange={setQ} />
      </Toolbar>
      <div className={tbl.wrap}>
        <table className={`${tbl.table} min-w-[52rem]`}>
          <thead className={thead}>
            <tr>
              <SortHeader label="Namespace" k="name" sort={sort} toggle={toggle} />
              <SortHeader label="Pods" k="pods" sort={sort} toggle={toggle} align="right" />
              <SortHeader label={t("k8s.detail.problems")} k="problems" sort={sort} toggle={toggle} align="right" />
              <th className={`${th} text-right`}>Workloads</th>
              <th className={`${th} text-right`}>Services</th>
              <th className={`${th} text-right`}>{t("k8s.common.routes")}</th>
              <SortHeader label={t(metrics ? "k8s.detail.cpuInUse" : "k8s.detail.cpuReserved")} k="cpu" sort={sort} toggle={toggle} align="right" />
              <SortHeader label={t(metrics ? "k8s.detail.memInUse" : "k8s.detail.memReserved")} k="mem" sort={sort} toggle={toggle} align="right" />
            </tr>
          </thead>
          <tbody className={tbody}>
            {sorted.map((n) => (
              <tr key={n.name} className={tbl.tr}>
                <td className={td}>
                  <span className="flex items-center gap-2">
                    <ResourceIcon kind="ns" />
                    <button onClick={() => pick(n.name)} className={tbl.link} title={t("k8s.detail.viewPods")}>
                      {n.name}
                    </button>
                    {n.phase !== "Active" && <span className="text-xs text-slate-500">({n.phase})</span>}
                  </span>
                </td>
                <td className={`${td} text-right tabular-nums`}>
                  {n.running}/{n.pods}
                </td>
                <td className={`${td} text-right tabular-nums ${n.problems ? "font-medium text-rose-600 dark:text-rose-400" : ""}`}>{n.problems}</td>
                <td className={`${td} text-right tabular-nums`}>{n.workloads}</td>
                <td className={`${td} text-right tabular-nums`}>{n.services}</td>
                <td className={`${td} text-right text-xs tabular-nums`} title="Ingress · HTTPRoute">
                  {n.ingresses} · {n.httproutes}
                </td>
                <td className={`${td} text-right tabular-nums`}>{cores(n.cpu_usage ?? n.cpu_requests)}</td>
                <td className={`${td} text-right tabular-nums`}>{bytes(n.mem_usage ?? n.mem_requests)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <Empty>{t("k8s.detail.noNamespaceMatch")}</Empty>}
    </Card>
  );
}

function Workloads({ d, ns, nsSelect }: { d: Detail; ns: string; nsSelect: React.ReactNode }) {
  const t = useT();
  const [q, setQ] = useState("");
  const inNs = d.workloads.filter((w) => !ns || w.namespace === ns);
  const rows = inNs.filter((w) => !q || (w.name ?? "").includes(q));
  return (
    <Card flush>
      <Toolbar count={t("k8s.detail.workloadsCount", { count: rows.length })}>
        {nsSelect}
        <SearchInput value={q} onChange={setQ} />
      </Toolbar>
      {rows.length === 0 ? (
        <Empty icon="dashboard">{t("k8s.detail.noWorkloads")}</Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={`${tbl.table} min-w-[48rem]`}>
            <thead className={thead}>
              <tr>
                <th className={th}>{t("k8s.common.name")}</th>
                <th className={th}>{t("k8s.common.type")}</th>
                <th className={`${th} text-right`}>{t("k8s.detail.readyReplicas")}</th>
                <th className={th}>{t("k8s.detail.images")}</th>
                <th className={th}>{t("k8s.common.age")}</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {rows.map((w) => (
                <tr key={`${w.kind}/${w.namespace}/${w.name}`} className={tr}>
                  <td className={td}>
                    <NameCell name={w.name} sub={w.namespace} />
                  </td>
                  <td className={`${td} text-xs`}>
                    <Badge>{w.kind}</Badge>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {w.ready < w.desired ? (
                      <Status tone="warn">
                        {w.ready}/{w.desired}
                      </Status>
                    ) : (
                      `${w.ready}/${w.desired}`
                    )}
                  </td>
                  <td className={`${td} max-w-[24rem] font-mono text-xs text-slate-600 dark:text-slate-400`}>{w.images.join(", ")}</td>
                  <td className={`${td} text-xs text-slate-500`}>{age(w.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Pods({ d, ns, nsSelect }: { d: Detail; ns: string; nsSelect: React.ReactNode }) {
  const t = useT();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [q, setQ] = useState("");
  const rows = d.pods.filter(
    (p) => (!ns || p.namespace === ns) && (!onlyProblems || p.problem) && (!q || p.name.includes(q)),
  );
  return (
    <Card flush>
      <Toolbar count={t("k8s.detail.podsCount", { count: rows.length })}>
        {nsSelect}
        <SearchInput value={q} onChange={setQ} placeholder={t("k8s.detail.searchPod")} />
        <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          {t("k8s.detail.onlyProblems")}
        </label>
      </Toolbar>
      {d.pods_truncated && (
        <div className="px-5 pt-3">
          <Alert variant="warning">{t("k8s.detail.podsTruncated")}</Alert>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty icon="layers">{t("k8s.detail.noPods")}</Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={`${tbl.table} min-w-[60rem]`}>
            <thead className={thead}>
              <tr>
                <th className={th}>Pod</th>
                <th className={th}>{t("k8s.common.state")}</th>
                <th className={`${th} text-right`}>{t("k8s.detail.readyContainers")}</th>
                <th className={`${th} text-right`}>{t("k8s.detail.restarts")}</th>
                <th className={`${th} text-right`}>CPU</th>
                <th className={`${th} text-right`}>{t("k8s.common.memory")}</th>
                <th className={th}>{t("k8s.detail.node")}</th>
                <th className={th}>{t("k8s.common.age")}</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {rows.slice(0, 500).map((p) => (
                <tr key={`${p.namespace}/${p.name}`} className={tr}>
                  <td className={td}>
                    <NameCell
                      name={p.name}
                      sub={
                        <>
                          {p.namespace}
                          {p.owner && ` · ${p.owner}`}
                        </>
                      }
                    />
                  </td>
                  <td className={td}>
                    {p.problem ? (
                      <Status tone="error">{p.status}</Status>
                    ) : p.status === "Running" ? (
                      <Status tone="ok">{p.status}</Status>
                    ) : p.status === "Succeeded" || p.status === "Completed" ? (
                      <Status tone="off" icon="checkCircle">
                        {p.status}
                      </Status>
                    ) : (
                      <Status tone="unknown">{p.status}</Status>
                    )}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{p.ready}</td>
                  <td className={`${td} text-right tabular-nums ${p.restarts > 5 ? "font-medium text-amber-700 dark:text-amber-300" : ""}`}>
                    {p.restarts}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{cores(p.cpu_usage)}</td>
                  <td className={`${td} text-right tabular-nums`}>{bytes(p.mem_usage)}</td>
                  <td className={`${td} text-xs text-slate-600 dark:text-slate-400`}>{p.node ?? "—"}</td>
                  <td className={`${td} text-xs text-slate-500`}>{age(p.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 500 && (
            <p className="px-5 py-3 text-xs text-slate-500">{t("k8s.detail.podsLimited", { total: rows.length })}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function Services({ d, ns, nsSelect }: { d: Detail; ns: string; nsSelect: React.ReactNode }) {
  const t = useT();
  const [q, setQ] = useState("");
  const rows = d.services.filter((s) => (!ns || s.namespace === ns) && (!q || (s.name ?? "").includes(q)));
  return (
    <Card flush>
      <Toolbar count={t("k8s.detail.servicesCount", { count: rows.length })}>
        {nsSelect}
        <SearchInput value={q} onChange={setQ} />
      </Toolbar>
      {rows.length === 0 ? (
        <Empty>{t("k8s.detail.noServices")}</Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={`${tbl.table} min-w-[48rem]`}>
            <thead className={thead}>
              <tr>
                <th className={th}>Service</th>
                <th className={th}>{t("k8s.common.type")}</th>
                <th className={th}>Cluster IP</th>
                <th className={th}>{t("k8s.detail.external")}</th>
                <th className={th}>{t("k8s.detail.ports")}</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {rows.map((s) => (
                <tr key={`${s.namespace}/${s.name}`} className={tr}>
                  <td className={td}>
                    <NameCell name={s.name} sub={s.namespace} />
                  </td>
                  <td className={`${td} text-xs`}>
                    <Badge>{s.type}</Badge>
                  </td>
                  <td className={`${td} font-mono text-xs`}>{s.cluster_ip}</td>
                  <td className={`${td} font-mono text-xs`}>{s.external.join(", ") || "—"}</td>
                  <td className={`${td} font-mono text-xs`}>{s.ports.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type RouteKind = "all" | "ingress" | "httproute";

/** Ingress and Gateway API HTTPRoute side by side, each tagged with its kind. */
function Routes({ d, ns, nsSelect }: { d: Detail; ns: string; nsSelect: React.ReactNode }) {
  const t = useT();
  const [kind, setKind] = useState<RouteKind>("all");
  const ingresses = d.ingresses.filter((i) => !ns || i.namespace === ns);
  const routes = d.httproutes.filter((r) => !ns || r.namespace === ns);
  const showIng = kind !== "httproute" && ingresses.length > 0;
  const showHttp = kind !== "ingress" && routes.length > 0;
  return (
    <Card flush>
      <Toolbar count={`${ingresses.length} Ingress · ${routes.length} HTTPRoute`}>
        {nsSelect}
        <Select value={kind} onChange={(e) => setKind(e.target.value as RouteKind)} aria-label={t("k8s.detail.routeType")}>
          <option value="all">{t("k8s.detail.allTypes")}</option>
          <option value="ingress">{t("k8s.detail.onlyIngress")}</option>
          <option value="httproute">{t("k8s.detail.onlyHttpRoute")}</option>
        </Select>
      </Toolbar>
      {!d.snapshot?.gateway_api && kind !== "ingress" && (
        <p className="px-5 pt-3 text-xs text-slate-500">{t("k8s.detail.noGatewayApi")}</p>
      )}
      {!showIng && !showHttp ? (
        <Empty icon="globe">{t("k8s.detail.noRoutes")}</Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={`${tbl.table} min-w-[56rem]`}>
            <thead className={thead}>
              <tr>
                <th className={th}>{t("k8s.common.type")}</th>
                <th className={th}>{t("k8s.common.name")}</th>
                <th className={th}>{t("k8s.detail.rules")}</th>
                <th className={th}>{t("k8s.detail.entry")}</th>
                <th className={th}>{t("k8s.detail.address")}</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {showHttp &&
                routes.map((r) => (
                  <tr key={`http/${r.namespace}/${r.name}`} className={tr}>
                    <td className={td}>
                      <Badge tone="blue">HTTPRoute</Badge>
                    </td>
                    <td className={td}>
                      <NameCell name={r.name} sub={r.namespace} />
                      {r.problem && (
                        <div className="mt-0.5 text-xs">
                          <Status tone="error">{r.problem}</Status>
                        </div>
                      )}
                    </td>
                    <td className={`${td} font-mono text-xs`}>
                      {(r.hostnames.length ? r.hostnames : ["*"]).map((h) =>
                        r.rules.map((rule, n) => (
                          <div key={`${h}-${n}`}>
                            {r.tls ? "🔒 https" : "http"}://{h}
                            {rule.path} → {rule.backends}
                          </div>
                        )),
                      )}
                    </td>
                    <td className={`${td} font-mono text-xs`}>{r.parents.join(", ") || "—"}</td>
                    <td className={`${td} font-mono text-xs`}>{r.address.join(", ") || "—"}</td>
                  </tr>
                ))}
              {showIng &&
                ingresses.map((i) => (
                  <tr key={`ing/${i.namespace}/${i.name}`} className={tr}>
                    <td className={td}>
                      <Badge>Ingress</Badge>
                    </td>
                    <td className={td}>
                      <NameCell name={i.name} sub={i.namespace} />
                    </td>
                    <td className={`${td} font-mono text-xs`}>
                      {i.rules.map((r, n) => (
                        <div key={n}>
                          {r.tls ? "🔒 https" : "http"}://{r.host ?? "*"}
                          {r.path} → {r.service}
                        </div>
                      ))}
                    </td>
                    <td className={`${td} font-mono text-xs`}>{i.ingress_class ?? "—"}</td>
                    <td className={`${td} font-mono text-xs`}>{i.address.filter(Boolean).join(", ") || "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500 dark:border-slate-800">
        {t("k8s.detail.routesNote")}
      </p>
    </Card>
  );
}

/** Platform admins: link to a client and, for manual clusters, kubeconfig and removal. */
function AdminActions({ d }: { d: Detail }) {
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);
  const [linking, setLinking] = useState(false);
  const replace = useMutation({
    mutationFn: async (kubeconfig: string) =>
      unwrap(
        await api.PUT("/api/v1/admin/kubernetes/clusters/{cluster_id}/kubeconfig", {
          params: { path: { cluster_id: d.id } },
          body: { kubeconfig },
        }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "k8s-cluster", d.id] });
      setReplacing(false);
    },
  });
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE("/api/v1/admin/kubernetes/clusters/{cluster_id}", {
          params: { path: { cluster_id: d.id } },
        }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "k8s-clusters"] });
      router.push("/admin/kubernetes");
    },
  });
  return (
    <>
      <Menu
        label={t("k8s.common.actions")}
        items={[
          { label: t(d.tenant_id ? "k8s.common.changeTenant" : "k8s.common.linkTenant"), onClick: () => setLinking(true) },
          d.source === "manual" && { label: t("k8s.detail.replaceKubeconfig"), onClick: () => setReplacing(true) },
          d.source === "manual" && {
            label: t("k8s.detail.removeRegistration"),
            danger: true,
            onClick: () =>
              confirm(t("k8s.detail.removeConfirm", { name: d.name })) && remove.mutate(),
          },
        ]}
      />
      {remove.isError && <span className="text-xs text-rose-600">{errorMessage(remove.error)}</span>}
      <LinkTenantDialog cluster={linking ? d : null} onClose={() => setLinking(false)} />
      <Dialog open={replacing} onClose={() => setReplacing(false)} title={t("k8s.detail.replaceKubeconfigTitle", { name: d.name })}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            replace.mutate(String(new FormData(e.currentTarget).get("kubeconfig")));
          }}
        >
          <Field label="Kubeconfig" hint={t("k8s.detail.kubeconfigHint")}>
            <Textarea name="kubeconfig" required rows={8} spellCheck={false} autoComplete="off" />
          </Field>
          <ErrorBox message={replace.isError ? errorMessage(replace.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setReplacing(false)}>
              {t("k8s.common.cancel")}
            </Button>
            <Button type="submit" disabled={replace.isPending}>
              {t("k8s.common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** One cluster. Admin: everything plus kubeconfig and the client link; tenant: the same
 * read-only picture of a cluster linked to the client, without any kubeconfig action. */
export function K8sClusterDetail({ mode }: { mode: K8sMode }) {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const { tenantId } = useSession();
  const admin = mode === "admin";
  const base = admin ? "/admin/kubernetes" : "/kubernetes";
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.some((x) => x.key === params.get("tab")) ? (params.get("tab") as Tab) : "overview";
  const ns = params.get("ns") ?? "";
  const go = (next: { tab?: Tab; ns?: string }) => {
    const q = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    const n = next.ns ?? ns;
    if (nextTab !== "overview") q.set("tab", nextTab);
    if (n) q.set("ns", n);
    router.replace(`${base}/${id}${q.size ? `?${q}` : ""}`);
  };
  const cluster = useQuery({
    queryKey: admin ? ["admin", "k8s-cluster", id] : ["k8s-cluster", tenantId, id],
    queryFn: async () =>
      admin
        ? unwrap(await api.GET("/api/v1/admin/kubernetes/clusters/{cluster_id}", { params: { path: { cluster_id: id } } }))
        : unwrap(await api.GET("/api/v1/kubernetes/clusters/{cluster_id}", { params: { path: { cluster_id: id } } })),
    enabled: admin || tenantId !== null,
    refetchInterval: 30_000,
  });
  const d = cluster.data;
  const namespaces = useMemo(() => (d?.namespaces ?? []).map((n) => n.name).sort(), [d]);

  const crumbs = [
    { label: "Kubernetes" },
    { label: t("k8s.common.clusters"), href: base },
  ];
  if (cluster.isError) {
    return (
      <>
        <PageHeader title="Cluster" breadcrumbs={crumbs} kind="k8s" />
        <ErrorBox message={errorMessage(cluster.error)} />
      </>
    );
  }
  if (!d) return null;
  const s = d.snapshot;
  const tabs = TABS.map((x) => ({
    ...x,
    label: t(x.label),
    count:
      x.key === "namespaces"
        ? d.namespaces.length
        : x.key === "workloads"
          ? d.workloads.length
          : x.key === "pods"
            ? d.pods.length
            : x.key === "services"
              ? d.services.length
              : x.key === "routes"
                ? d.ingresses.length + d.httproutes.length
                : undefined,
  }));
  const nsSelect = <NamespaceSelect value={ns} options={namespaces} onChange={(n) => go({ ns: n })} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={d.name}
        breadcrumbs={[...crumbs, { label: d.name }]}
        kind="k8s"
        status={
          <span className="flex items-center gap-2">
            {d.managed && d.managed.state !== "active" ? <ManagedState c={d} /> : <HealthBadge s={s} />}
            {admin && d.source === "manual" && <Badge>manual</Badge>}
            {d.source === "managed" && <Badge tone="brand">{t("k8s.detail.createdByPlatform")}</Badge>}
          </span>
        }
        actions={
          d.source === "managed" ? (
            <>
              <DownloadKubeconfig c={d} tenant={!admin} />
              <DestroyClusterButton c={d} admin={admin} onDone={() => router.push(base)} />
            </>
          ) : (
            admin && (
              <>
                <DownloadKubeconfig c={d} />
                <AdminActions d={d} />
              </>
            )
          )
        }
        tabs={tabs}
        activeTab={tab}
        onTab={(next) => go({ tab: next })}
      >
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
          {admin && (
            <span className="flex items-center gap-1.5">
              <ResourceIcon kind="tenant" />
              {d.tenant_name ?? <span className="text-slate-500">{t("k8s.detail.noTenant")}</span>}
            </span>
          )}
          <span className="font-mono">{d.server_url ?? d.api_server}</span>
          {s?.version && <span>{s.version}</span>}
          {s && (
            <span>
              {t("k8s.common.readAgo", { ago: ago(s.ok_at) })}
              {s.health === "unreachable" && s.ok_at && t("k8s.detail.lastReadData")}
            </span>
          )}
          <span className="flex items-center gap-2">
            {t("k8s.common.certificate")}: {day(d.expires_on)} <ExpiryBadge c={d} /> <span className="text-xs">{daysText(d.days_left)}</span>
          </span>
        </p>
      </PageHeader>

      {tab === "overview" && <Overview d={d} />}
      {tab === "namespaces" && <Namespaces d={d} pick={(n) => go({ tab: "pods", ns: n })} />}
      {tab === "workloads" && <Workloads d={d} ns={ns} nsSelect={nsSelect} />}
      {tab === "pods" && <Pods d={d} ns={ns} nsSelect={nsSelect} />}
      {tab === "services" && <Services d={d} ns={ns} nsSelect={nsSelect} />}
      {tab === "routes" && <Routes d={d} ns={ns} nsSelect={nsSelect} />}
    </div>
  );
}
