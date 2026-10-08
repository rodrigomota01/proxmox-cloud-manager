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
  UsageMeter,
} from "@/components/k8s";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Textarea } from "@/components/ui";
import { Stat } from "@/components/usage-panel";
import { api, errorMessage, unwrap } from "@/lib/api/client";

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

export default function AdminKubernetesPage() {
  const [adding, setAdding] = useState(false);
  const clusters = useQuery({
    queryKey: ["admin", "k8s-clusters"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/kubernetes/clusters")),
    refetchInterval: 30_000,
  });
  const data = clusters.data ?? [];
  const snaps = data.flatMap((c) => (c.snapshot ? [c.snapshot] : []));
  const count = (h: string) => snaps.filter((s) => s.health === h).length;
  const sum = (k: "nodes" | "nodes_ready" | "pods" | "pods_problem" | "namespaces") =>
    snaps.reduce((a, s) => a + s[k], 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Clusters Kubernetes</h1>
          <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            Saúde e carga lidas da API de cada cluster a cada minuto, só leitura. Clusters vêm da tabela{" "}
            <code>kubernetes_clusters</code> ou do cadastro manual. O vencimento é o mais próximo entre a data da
            tabela e a do certificado no kubeconfig.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>Adicionar cluster</Button>
      </div>
      <ErrorBox message={clusters.isError ? errorMessage(clusters.error) : null} />

      {snaps.length > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="Clusters"
            value={data.length}
            hint={`${count("healthy")} saudáveis · ${count("warning")} atenção · ${count("critical")} críticos · ${count("unreachable")} sem conexão`}
          />
          <Stat label="Nós prontos" value={`${sum("nodes_ready")} de ${sum("nodes")}`} />
          <Stat label="Pods" value={sum("pods")} hint={`${sum("pods_problem")} com problema`} />
          <Stat label="Namespaces" value={sum("namespaces")} />
        </div>
      )}

      <Card>
        {clusters.data && data.length === 0 ? (
          <Empty>Nenhum cluster. Adicione um ou cadastre na tabela kubernetes_clusters.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[68rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">Cluster</th>
                  <th className="py-1 pr-3 font-medium">Saúde</th>
                  <th className="py-1 pr-3 font-medium">Nós</th>
                  <th className="py-1 pr-3 font-medium">Pods</th>
                  <th className="py-1 pr-3 font-medium">CPU</th>
                  <th className="py-1 pr-3 font-medium">Memória</th>
                  <th className="py-1 pr-3 font-medium">Certificado</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.map((c) => {
                  const s = c.snapshot;
                  return (
                    <tr key={c.id} className="align-top">
                      <td className="py-2 pr-3">
                        <Link href={`/admin/kubernetes/${c.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                          {c.name}
                        </Link>
                        {c.source === "manual" && (
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
                      </td>
                      <td className="py-2 pr-3">
                        <HealthBadge s={s} />
                        {s && s.reasons.length > 0 && (
                          <div className="mt-0.5 max-w-[16rem] text-xs text-slate-600 dark:text-slate-400">{s.reasons[0]}</div>
                        )}
                        {s && <div className="text-xs text-slate-500">lido {ago(s.ok_at)}</div>}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{s ? `${s.nodes_ready}/${s.nodes}` : "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {s ? s.pods : "—"}
                        {s && s.pods_problem > 0 && <div className="text-xs text-rose-600">{s.pods_problem} com problema</div>}
                      </td>
                      <td className="py-2 pr-3">
                        {s && s.nodes > 0 ? (
                          <UsageMeter usage={s.cpu_usage} requests={s.cpu_requests} allocatable={s.cpu_allocatable} format={cores} what="CPU" />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {s && s.nodes > 0 ? (
                          <UsageMeter usage={s.mem_usage} requests={s.mem_requests} allocatable={s.mem_allocatable} format={bytes} what="Memória" />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{day(c.expires_on)}</span>
                          <ExpiryBadge c={c} />
                        </div>
                        <div className="text-xs text-slate-500">{daysText(c.days_left)}</div>
                        {c.dates_differ && (
                          <div className="text-xs font-medium text-amber-700 dark:text-amber-300">⚠ tabela e certificado diferentes</div>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <DownloadKubeconfig c={c} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-slate-500">
        CPU e memória: uso real quando o cluster tem metrics-server; sem ele, o quanto os pods reservaram (requests).
      </p>
      <AddClusterDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
