"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
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
  HealthBadge,
  UsageMeter,
} from "@/components/k8s";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { Stat } from "@/components/usage-panel";
import { SortHeader, useSorted } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";

type Detail = Schemas["K8sClusterDetail"];

const TABS = [
  { key: "overview", label: "Visão geral" },
  { key: "namespaces", label: "Namespaces" },
  { key: "workloads", label: "Workloads" },
  { key: "pods", label: "Pods" },
  { key: "services", label: "Services" },
  { key: "routes", label: "Rotas" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const th = "py-1 pr-4 font-medium";
const thead = "text-left text-xs uppercase tracking-wide text-slate-500";
const tbody = "divide-y divide-slate-100 dark:divide-slate-800";

function age(iso: string | null | undefined): string {
  return iso ? ago(iso).replace("há ", "") : "—";
}

function Overview({ d }: { d: Detail }) {
  const s = d.snapshot;
  if (!s) return <Empty>Ainda não coletado. A primeira leitura acontece em até um minuto.</Empty>;
  return (
    <div className="space-y-4">
      {s.health !== "healthy" && (
        <Card title="O que pede atenção">
          <ul className="list-inside list-disc space-y-1 text-sm">
            {s.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
            {s.error && <li className="font-mono text-xs text-slate-500">{s.error}</li>}
          </ul>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Nós prontos" value={`${s.nodes_ready} de ${s.nodes}`} />
        <Stat label="Pods" value={s.pods} hint={`${s.pods_running} rodando · ${s.pods_problem} com problema`} />
        <Stat label="Workloads" value={s.workloads} hint={s.workloads_unready ? `${s.workloads_unready} sem todas as réplicas` : "todos prontos"} />
        <Stat
          label="Namespaces"
          value={s.namespaces}
          hint={`${s.services} services · ${s.ingresses} ingress${s.gateway_api ? ` · ${s.httproutes} HTTPRoute` : ""}`}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={s.metrics ? "CPU em uso" : "CPU reservada (sem metrics-server)"}>
          <UsageMeter usage={s.cpu_usage} requests={s.cpu_requests} allocatable={s.cpu_allocatable} format={cores} what="CPU" />
          <p className="mt-2 text-xs text-slate-500">
            Reservado pelos pods: {cores(s.cpu_requests)} de {cores(s.cpu_allocatable)} cores alocáveis
          </p>
        </Card>
        <Card title={s.metrics ? "Memória em uso" : "Memória reservada (sem metrics-server)"}>
          <UsageMeter usage={s.mem_usage} requests={s.mem_requests} allocatable={s.mem_allocatable} format={bytes} what="Memória" />
          <p className="mt-2 text-xs text-slate-500">
            Reservado pelos pods: {bytes(s.mem_requests)} de {bytes(s.mem_allocatable)} alocáveis
          </p>
        </Card>
      </div>
      <Card title="Nós">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Nó</th>
                <th className={th}>Estado</th>
                <th className={th}>CPU</th>
                <th className={th}>Memória</th>
                <th className={`${th} text-right`}>Pods</th>
                <th className={th}>Versão</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {d.k8s_nodes.map((n) => (
                <tr key={n.name} className="align-top">
                  <td className="py-2 pr-4">
                    <div className="font-medium">{n.name}</div>
                    <div className="text-xs text-slate-500">
                      {n.roles.join(", ")} · {n.ip ?? "—"}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    {n.ready ? <Badge tone="green">✓ Pronto</Badge> : <Badge tone="red">✕ Fora do ar</Badge>}
                    {n.unschedulable && <div className="text-xs text-amber-700 dark:text-amber-300">sem novos pods (cordon)</div>}
                    {n.pressure.length > 0 && <div className="text-xs text-amber-700 dark:text-amber-300">⚠ {n.pressure.join(", ")}</div>}
                  </td>
                  <td className="py-2 pr-4">
                    <UsageMeter usage={n.cpu_usage} requests={n.cpu_requests} allocatable={n.cpu_allocatable} format={cores} what="CPU" />
                  </td>
                  <td className="py-2 pr-4">
                    <UsageMeter usage={n.mem_usage} requests={n.mem_requests} allocatable={n.mem_allocatable} format={bytes} what="Memória" />
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {n.pods}/{n.pods_capacity}
                  </td>
                  <td className="py-2 pr-4 text-xs text-slate-600 dark:text-slate-400">
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
  const metrics = d.snapshot?.metrics ?? false;
  const { sorted, sort, toggle } = useSorted<Detail["namespaces"][number], "name" | "pods" | "problems" | "cpu" | "mem">(
    d.namespaces,
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
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className={thead}>
            <tr>
              <SortHeader label="Namespace" k="name" sort={sort} toggle={toggle} />
              <SortHeader label="Pods" k="pods" sort={sort} toggle={toggle} align="right" />
              <SortHeader label="Problemas" k="problems" sort={sort} toggle={toggle} align="right" />
              <th className={`${th} text-right`}>Workloads</th>
              <th className={`${th} text-right`}>Services</th>
              <th className={`${th} text-right`}>Rotas</th>
              <SortHeader label={metrics ? "CPU em uso" : "CPU reservada"} k="cpu" sort={sort} toggle={toggle} align="right" />
              <SortHeader label={metrics ? "Memória em uso" : "Memória reservada"} k="mem" sort={sort} toggle={toggle} align="right" />
            </tr>
          </thead>
          <tbody className={tbody}>
            {sorted.map((n) => (
              <tr key={n.name}>
                <td className="py-1.5 pr-4">
                  <button onClick={() => pick(n.name)} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    {n.name}
                  </button>
                  {n.phase !== "Active" && <span className="ml-1 text-xs text-slate-500">({n.phase})</span>}
                </td>
                <td className="py-1.5 pr-4 text-right tabular-nums">
                  {n.running}/{n.pods}
                </td>
                <td className={`py-1.5 pr-4 text-right tabular-nums ${n.problems ? "font-medium text-rose-600" : ""}`}>{n.problems}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{n.workloads}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{n.services}</td>
                <td className="py-1.5 pr-4 text-right text-xs tabular-nums" title="Ingress · HTTPRoute">
                  {n.ingresses} · {n.httproutes}
                </td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{cores(n.cpu_usage ?? n.cpu_requests)}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{bytes(n.mem_usage ?? n.mem_requests)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Workloads({ d, ns }: { d: Detail; ns: string }) {
  const rows = d.workloads.filter((w) => !ns || w.namespace === ns);
  if (!rows.length) return <Empty>Nenhum workload.</Empty>;
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Nome</th>
              <th className={th}>Tipo</th>
              <th className={`${th} text-right`}>Prontas</th>
              <th className={th}>Imagens</th>
              <th className={th}>Idade</th>
            </tr>
          </thead>
          <tbody className={tbody}>
            {rows.map((w) => (
              <tr key={`${w.kind}/${w.namespace}/${w.name}`} className="align-top">
                <td className="py-1.5 pr-4">
                  <div className="font-medium">{w.name}</div>
                  <div className="text-xs text-slate-500">{w.namespace}</div>
                </td>
                <td className="py-1.5 pr-4 text-xs">{w.kind}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums">
                  {w.ready < w.desired ? (
                    <span className="font-medium text-amber-700 dark:text-amber-300">⚠ {w.ready}/{w.desired}</span>
                  ) : (
                    `${w.ready}/${w.desired}`
                  )}
                </td>
                <td className="max-w-[24rem] py-1.5 pr-4 font-mono text-xs text-slate-600 dark:text-slate-400">
                  {w.images.join(", ")}
                </td>
                <td className="py-1.5 pr-4 text-xs text-slate-500">{age(w.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Pods({ d, ns }: { d: Detail; ns: string }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [q, setQ] = useState("");
  const rows = d.pods.filter(
    (p) => (!ns || p.namespace === ns) && (!onlyProblems || p.problem) && (!q || p.name.includes(q)),
  );
  return (
    <Card
      actions={
        <>
          <Input placeholder="Buscar pod" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
            <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
            Só com problema
          </label>
        </>
      }
      title={`${rows.length} pod(s)`}
    >
      {d.pods_truncated && <p className="mb-2 text-xs text-amber-700">Mostrando os primeiros 5000 pods (problemas primeiro).</p>}
      {rows.length === 0 ? (
        <Empty>Nenhum pod.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Pod</th>
                <th className={th}>Estado</th>
                <th className={`${th} text-right`}>Prontos</th>
                <th className={`${th} text-right`}>Reinícios</th>
                <th className={`${th} text-right`}>CPU</th>
                <th className={`${th} text-right`}>Memória</th>
                <th className={th}>Nó</th>
                <th className={th}>Idade</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {rows.slice(0, 500).map((p) => (
                <tr key={`${p.namespace}/${p.name}`} className="align-top">
                  <td className="py-1.5 pr-4">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-slate-500">
                      {p.namespace}
                      {p.owner && ` · ${p.owner}`}
                    </div>
                  </td>
                  <td className="py-1.5 pr-4">
                    {p.problem ? (
                      <Badge tone="red">✕ {p.status}</Badge>
                    ) : p.status === "Running" ? (
                      <Badge tone="green">{p.status}</Badge>
                    ) : (
                      <Badge>{p.status}</Badge>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{p.ready}</td>
                  <td className={`py-1.5 pr-4 text-right tabular-nums ${p.restarts > 5 ? "font-medium text-amber-700 dark:text-amber-300" : ""}`}>
                    {p.restarts}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{cores(p.cpu_usage)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{bytes(p.mem_usage)}</td>
                  <td className="py-1.5 pr-4 text-xs text-slate-600 dark:text-slate-400">{p.node ?? "—"}</td>
                  <td className="py-1.5 pr-4 text-xs text-slate-500">{age(p.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 500 && <p className="mt-2 text-xs text-slate-500">Mostrando 500 de {rows.length}. Use a busca ou o filtro de namespace.</p>}
        </div>
      )}
    </Card>
  );
}

function Services({ d, ns }: { d: Detail; ns: string }) {
  const rows = d.services.filter((s) => !ns || s.namespace === ns);
  if (!rows.length) return <Empty>Nenhum service.</Empty>;
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Service</th>
              <th className={th}>Tipo</th>
              <th className={th}>Cluster IP</th>
              <th className={th}>Externo</th>
              <th className={th}>Portas</th>
            </tr>
          </thead>
          <tbody className={tbody}>
            {rows.map((s) => (
              <tr key={`${s.namespace}/${s.name}`} className="align-top">
                <td className="py-1.5 pr-4">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-500">{s.namespace}</div>
                </td>
                <td className="py-1.5 pr-4 text-xs">{s.type}</td>
                <td className="py-1.5 pr-4 font-mono text-xs">{s.cluster_ip}</td>
                <td className="py-1.5 pr-4 font-mono text-xs">{s.external.join(", ") || "—"}</td>
                <td className="py-1.5 pr-4 font-mono text-xs">{s.ports.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type RouteKind = "all" | "ingress" | "httproute";

/** Ingress and Gateway API HTTPRoute side by side, each tagged with its kind. */
function Routes({ d, ns }: { d: Detail; ns: string }) {
  const [kind, setKind] = useState<RouteKind>("all");
  const ingresses = d.ingresses.filter((i) => !ns || i.namespace === ns);
  const routes = d.httproutes.filter((r) => !ns || r.namespace === ns);
  const showIng = kind !== "httproute" && ingresses.length > 0;
  const showHttp = kind !== "ingress" && routes.length > 0;
  return (
    <Card
      title={`${ingresses.length} Ingress · ${routes.length} HTTPRoute`}
      actions={
        <Select value={kind} onChange={(e) => setKind(e.target.value as RouteKind)} aria-label="Tipo de rota">
          <option value="all">Todos os tipos</option>
          <option value="ingress">Só Ingress</option>
          <option value="httproute">Só HTTPRoute</option>
        </Select>
      }
    >
      {!d.snapshot?.gateway_api && kind !== "ingress" && (
        <p className="mb-2 text-xs text-slate-500">Este cluster não tem a Gateway API instalada (sem HTTPRoute).</p>
      )}
      {!showIng && !showHttp ? (
        <Empty>Nenhuma rota.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Tipo</th>
                <th className={th}>Nome</th>
                <th className={th}>Regras</th>
                <th className={th}>Entrada</th>
                <th className={th}>Endereço</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {showHttp &&
                routes.map((r) => (
                  <tr key={`http/${r.namespace}/${r.name}`} className="align-top">
                    <td className="py-1.5 pr-4">
                      <Badge tone="blue">HTTPRoute</Badge>
                    </td>
                    <td className="py-1.5 pr-4">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-slate-500">{r.namespace}</div>
                      {r.problem && <div className="text-xs font-medium text-rose-600">✕ {r.problem}</div>}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-xs">
                      {(r.hostnames.length ? r.hostnames : ["*"]).map((h) =>
                        r.rules.map((rule, n) => (
                          <div key={`${h}-${n}`}>
                            {r.tls ? "🔒 https" : "http"}://{h}
                            {rule.path} → {rule.backends}
                          </div>
                        )),
                      )}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-xs">{r.parents.join(", ") || "—"}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs">{r.address.join(", ") || "—"}</td>
                  </tr>
                ))}
              {showIng &&
                ingresses.map((i) => (
                  <tr key={`ing/${i.namespace}/${i.name}`} className="align-top">
                    <td className="py-1.5 pr-4">
                      <Badge>Ingress</Badge>
                    </td>
                    <td className="py-1.5 pr-4">
                      <div className="font-medium">{i.name}</div>
                      <div className="text-xs text-slate-500">{i.namespace}</div>
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-xs">
                      {i.rules.map((r, n) => (
                        <div key={n}>
                          {r.tls ? "🔒 https" : "http"}://{r.host ?? "*"}
                          {r.path} → {r.service}
                        </div>
                      ))}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-xs">{i.ingress_class ?? "—"}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs">{i.address.filter(Boolean).join(", ") || "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Entrada: a classe do Ingress, ou o Gateway (namespace/nome:listener) a que o HTTPRoute se liga. HTTPS e endereço
        do HTTPRoute vêm do listener do Gateway.
      </p>
    </Card>
  );
}

function ManualActions({ d }: { d: Detail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);
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
      <Button variant="ghost" onClick={() => setReplacing(true)}>
        Trocar kubeconfig
      </Button>
      <Button
        variant="ghost"
        onClick={() =>
          confirm(`Remover "${d.name}" da plataforma? Nada é feito no cluster; só o cadastro sai daqui.`) && remove.mutate()
        }
      >
        Remover cadastro
      </Button>
      {remove.isError && <span className="text-xs text-rose-600">{errorMessage(remove.error)}</span>}
      <Dialog open={replacing} onClose={() => setReplacing(false)} title={`Trocar kubeconfig de ${d.name}`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            replace.mutate(String(new FormData(e.currentTarget).get("kubeconfig")));
          }}
        >
          <Field label="Kubeconfig" hint="YAML ou base64.">
            <Textarea name="kubeconfig" required rows={8} spellCheck={false} autoComplete="off" />
          </Field>
          <ErrorBox message={replace.isError ? errorMessage(replace.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setReplacing(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={replace.isPending}>
              Salvar
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export default function K8sClusterPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.some((t) => t.key === params.get("tab")) ? (params.get("tab") as Tab) : "overview";
  const ns = params.get("ns") ?? "";
  const go = (next: { tab?: Tab; ns?: string }) => {
    const q = new URLSearchParams();
    const t = next.tab ?? tab;
    const n = next.ns ?? ns;
    if (t !== "overview") q.set("tab", t);
    if (n) q.set("ns", n);
    router.replace(`/admin/kubernetes/${id}${q.size ? `?${q}` : ""}`);
  };
  const cluster = useQuery({
    queryKey: ["admin", "k8s-cluster", id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/kubernetes/clusters/{cluster_id}", { params: { path: { cluster_id: id } } })),
    refetchInterval: 30_000,
  });
  const d = cluster.data;
  const namespaces = useMemo(() => (d?.namespaces ?? []).map((n) => n.name).sort(), [d]);
  const filtered = tab !== "overview" && tab !== "namespaces";

  if (cluster.isError) return <ErrorBox message={errorMessage(cluster.error)} />;
  if (!d) return null;
  const s = d.snapshot;

  return (
    <div className="space-y-4">
      <Link href="/admin/kubernetes" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Clusters Kubernetes
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {d.name}
            <HealthBadge s={s} />
            {d.source === "manual" && <Badge>manual</Badge>}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            <span className="font-mono">{d.server_url ?? d.api_server}</span>
            {s?.version && ` · ${s.version}`}
            {s && ` · lido ${ago(s.ok_at)}`}
            {s?.health === "unreachable" && s.ok_at && " (dados da última leitura)"}
          </p>
          <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            Certificado: {day(d.expires_on)} <ExpiryBadge c={d} /> <span className="text-xs">{daysText(d.days_left)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <DownloadKubeconfig c={d} />
          {d.source === "manual" && <ManualActions d={d} />}
        </div>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800" aria-label="Seções">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => go({ tab: t.key })}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? "border-indigo-600 font-medium text-indigo-700 dark:text-indigo-300"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {filtered && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">Namespace</span>
          <Select value={ns} onChange={(e) => go({ ns: e.target.value })} aria-label="Namespace">
            <option value="">Todos</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
      )}

      {tab === "overview" && <Overview d={d} />}
      {tab === "namespaces" && <Namespaces d={d} pick={(n) => go({ tab: "pods", ns: n })} />}
      {tab === "workloads" && <Workloads d={d} ns={ns} />}
      {tab === "pods" && <Pods d={d} ns={ns} />}
      {tab === "services" && <Services d={d} ns={ns} />}
      {tab === "routes" && <Routes d={d} ns={ns} />}
    </div>
  );
}
