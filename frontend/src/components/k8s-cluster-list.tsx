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
  UsageMeter,
} from "@/components/k8s";
import { Icon } from "@/components/icons";
import { Menu, PageHeader, ResourceIcon, SearchInput, StatTile, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Textarea, tbl } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useSession } from "@/lib/session";

function AddClusterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    <Dialog open={open} onClose={close} title="Adicionar cluster Kubernetes">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({ name: String(f.get("name")).trim(), kubeconfig: String(f.get("kubeconfig")) });
        }}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Para clusters que não estão na tabela <code>kubernetes_clusters</code>. O kubeconfig fica
          criptografado e a plataforma só lê o cluster (nunca altera nada).
        </p>
        <Field label="Nome">
          <Input name="name" required maxLength={100} placeholder="pluxee-prod-cluster" />
        </Field>
        <Field label="Kubeconfig" hint="Cole o YAML (ex.: ~/.kube/config) ou o base64 dele.">
          <Textarea name="kubeconfig" required rows={8} spellCheck={false} autoComplete="off" />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Adicionar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const HEALTH_FILTER = [
  { value: "", label: "Qualquer saúde" },
  { value: "healthy", label: "Saudáveis" },
  { value: "warning", label: "Atenção" },
  { value: "critical", label: "Críticos" },
  { value: "unreachable", label: "Sem conexão" },
  { value: "none", label: "Não coletados" },
];

/** Admin: every cluster, with registration, kubeconfig and the client link. Tenant: the
 * clusters linked to the client, read-only and without any kubeconfig action. */
export function K8sClusterList({ mode }: { mode: K8sMode }) {
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
        title="Clusters Kubernetes"
        breadcrumbs={[{ label: "Kubernetes" }, { label: "Clusters" }]}
        description={
          admin ? (
          <>
            Saúde e carga lidas da API de cada cluster a cada minuto, só leitura. Clusters vêm da tabela{" "}
            <code>kubernetes_clusters</code> ou do cadastro manual. O vencimento é o mais próximo entre a data da
            tabela e a do certificado no kubeconfig.
          </>
          ) : (
            `Clusters de ${tenant?.name ?? "seu cliente"}: saúde, carga e workloads lidos a cada minuto, só leitura.`
          )
        }
        actions={
          admin && (
            <Button onClick={() => setAdding(true)}>
              <Icon name="plus" /> Adicionar cluster
            </Button>
          )
        }
      />
      <ErrorBox message={clusters.isError ? errorMessage(clusters.error) : null} />

      {snaps.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            icon="kubernetes"
            tone={bad ? "error" : count("warning") ? "warn" : "ok"}
            label="Clusters"
            value={data.length}
            hint={`${count("healthy")} saudáveis · ${count("warning")} atenção · ${count("critical")} críticos · ${count("unreachable")} sem conexão`}
          />
          <StatTile
            icon="server"
            tone={sum("nodes_ready") < sum("nodes") ? "warn" : undefined}
            label="Nós prontos"
            value={`${sum("nodes_ready")} de ${sum("nodes")}`}
          />
          <StatTile
            icon="layers"
            tone={sum("pods_problem") ? "warn" : undefined}
            label="Pods"
            value={sum("pods")}
            hint={`${sum("pods_problem")} com problema`}
          />
          <StatTile icon="folder" label="Namespaces" value={sum("namespaces")} />
        </div>
      )}

      <Card flush>
        {clusters.data && data.length === 0 ? (
          admin ? (
            <Empty
              icon="kubernetes"
              title="Nenhum cluster"
              action={
                <Button onClick={() => setAdding(true)}>
                  <Icon name="plus" /> Adicionar cluster
                </Button>
              }
            >
              Adicione um ou cadastre na tabela kubernetes_clusters.
            </Empty>
          ) : (
            <Empty icon="kubernetes" title="Nenhum cluster vinculado">
              Nenhum cluster Kubernetes está vinculado a este cliente. Fale com o administrador da plataforma.
            </Empty>
          )
        ) : (
          <>
            <Toolbar count={`${rows.length} de ${data.length} clusters`}>
              <SearchInput value={filter} onChange={setFilter} placeholder={admin ? "Filtrar por nome ou cliente…" : undefined} />
              <Select aria-label="Saúde" value={health} onChange={(e) => setHealth(e.target.value)}>
                {HEALTH_FILTER.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </Select>
            </Toolbar>
            <div className={tbl.wrap}>
              <table className={`${tbl.table} min-w-[68rem]`}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Cluster</th>
                    {admin && <th className={tbl.th}>Cliente</th>}
                    <th className={tbl.th}>Saúde</th>
                    <th className={tbl.th}>Nós</th>
                    <th className={tbl.th}>Pods</th>
                    <th className={tbl.th}>CPU</th>
                    <th className={tbl.th}>Memória</th>
                    <th className={tbl.th}>Certificado</th>
                    {admin && (
                      <th className={tbl.th}>
                        <span className="sr-only">Ações</span>
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
                              <div className="font-mono text-xs text-slate-500">{c.server_url ?? c.api_server ?? "—"}</div>
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
                          <td className={tbl.td}>
                            {c.tenant_name ?? <span className="text-slate-400">—</span>}
                          </td>
                        )}
                        <td className={tbl.td}>
                          <HealthBadge s={s} />
                          {s && s.reasons.length > 0 && (
                            <div className="mt-0.5 max-w-[16rem] text-xs text-slate-600 dark:text-slate-400">{s.reasons[0]}</div>
                          )}
                          {s && <div className="text-xs text-slate-500">lido {ago(s.ok_at)}</div>}
                        </td>
                        <td className={`${tbl.td} tabular-nums`}>{s ? `${s.nodes_ready}/${s.nodes}` : "—"}</td>
                        <td className={`${tbl.td} tabular-nums`}>
                          {s ? s.pods : "—"}
                          {s && s.pods_problem > 0 && <div className="text-xs text-rose-600 dark:text-rose-400">{s.pods_problem} com problema</div>}
                        </td>
                        <td className={tbl.td}>
                          {s && s.nodes > 0 ? (
                            <UsageMeter usage={s.cpu_usage} requests={s.cpu_requests} allocatable={s.cpu_allocatable} format={cores} what="CPU" />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={tbl.td}>
                          {s && s.nodes > 0 ? (
                            <UsageMeter usage={s.mem_usage} requests={s.mem_requests} allocatable={s.mem_allocatable} format={bytes} what="Memória" />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={tbl.td}>
                          <ExpiryBadge c={c} />
                          <div className="text-xs tabular-nums text-slate-500">
                            {day(c.expires_on)}
                            {c.days_left !== null && ` · ${daysText(c.days_left)}`}
                          </div>
                          {c.dates_differ && (
                            <div className="text-xs font-medium text-amber-700 dark:text-amber-300">⚠ tabela e certificado diferentes</div>
                          )}
                        </td>
                        {admin && (
                          <td className={`${tbl.td} text-right`}>
                            <div className="flex items-center justify-end gap-1">
                              <DownloadKubeconfig c={c} />
                              <Menu
                                ariaLabel={`Ações de ${c.name}`}
                                items={[
                                  {
                                    label: c.tenant_id ? "Trocar cliente vinculado" : "Vincular a um cliente",
                                    onClick: () => setLinking(c),
                                  },
                                ]}
                              />
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && data.length > 0 && <Empty>Nenhum cluster com esses filtros.</Empty>}
          </>
        )}
      </Card>
      <Alert variant="info">
        CPU e memória: uso real quando o cluster tem metrics-server; sem ele, o quanto os pods reservaram (requests).
      </Alert>
      {admin && <AddClusterDialog open={adding} onClose={() => setAdding(false)} />}
      <LinkTenantDialog cluster={linking} onClose={() => setLinking(null)} />
    </div>
  );
}
