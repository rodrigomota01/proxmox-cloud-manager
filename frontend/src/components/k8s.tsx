"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import { Icon } from "@/components/icons";
import { Button, Card, Dialog, ErrorBox, Field, Select, Status, type StatusTone, formatBytes } from "@/components/ui";
import { Meter } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useSession } from "@/lib/session";

export type K8sCluster = Schemas["K8sClusterOut"];
/** admin: /admin/kubernetes (every cluster); tenant: /kubernetes (the client's, read-only) */
export type K8sMode = "admin" | "tenant";
export type K8sSummary = Schemas["K8sSummaryOut"];

/** "2026-10-13" -> "13/10/2026" (a calendar date: no timezone shift). */
export function day(value: string | null | undefined): string {
  if (!value) return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export const cores = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v < 1 ? `${Math.round(v * 1000)}m` : `${v.toFixed(v < 10 ? 2 : 1)}`;

export const bytes = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : formatBytes(v);

/** Usage against allocatable when metrics exist; otherwise what pods reserved. */
export function UsageMeter({
  usage,
  requests,
  allocatable,
  format,
  what,
}: {
  usage: number | null | undefined;
  requests: number;
  allocatable: number;
  format: (v: number) => string;
  what: string;
}) {
  if (!allocatable) return <span className="text-xs text-slate-500">—</span>;
  const measured = usage !== null && usage !== undefined;
  const value = measured ? usage : requests;
  return (
    <Meter
      value={value / allocatable}
      label={`${format(value)} / ${format(allocatable)}`}
      title={measured ? `${what} em uso` : `${what} reservada pelos pods (sem metrics-server)`}
    />
  );
}

const EXPIRY: Record<K8sCluster["status"], { tone: StatusTone; label: string }> = {
  expired: { tone: "error", label: "Vencido" },
  critical: { tone: "error", label: "Vence em breve" },
  warning: { tone: "warn", label: "Vence em até 30 dias" },
  ok: { tone: "ok", label: "Em dia" },
  unknown: { tone: "unknown", label: "Sem data" },
};

export function ExpiryBadge({ c }: { c: K8sCluster }) {
  const s = EXPIRY[c.status];
  return <Status tone={s.tone}>{s.label}</Status>;
}

const HEALTH: Record<K8sSummary["health"], { tone: StatusTone; label: string; icon?: "ban" }> = {
  healthy: { tone: "ok", label: "Saudável" },
  warning: { tone: "warn", label: "Atenção" },
  critical: { tone: "error", label: "Crítico" },
  unreachable: { tone: "off", label: "Sem conexão", icon: "ban" },
};

export function HealthBadge({ s }: { s: K8sSummary | null | undefined }) {
  if (!s) return <Status tone="unknown">Não coletado</Status>;
  const h = HEALTH[s.health];
  return (
    <Status tone={h.tone} icon={h.icon}>
      {h.label}
    </Status>
  );
}

export function daysText(days: number | null): string {
  if (days === null) return "";
  if (days < 0) return `venceu há ${-days} dia${days === -1 ? "" : "s"}`;
  if (days === 0) return "vence hoje";
  return `em ${days} dia${days === 1 ? "" : "s"}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "nunca";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "agora";
  if (s < 5400) return `há ${Math.round(s / 60)} min`;
  if (s < 172800) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
}

/** Platform dashboard: clusters needing attention (health or certificate). */
export function K8sAttentionPreview() {
  const clusters = useQuery({
    queryKey: ["admin", "k8s-clusters"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/kubernetes/clusters")),
    refetchInterval: 60_000,
  });
  const due = (clusters.data ?? []).filter(
    (c) =>
      ["expired", "critical", "warning"].includes(c.status) ||
      (c.snapshot && c.snapshot.health !== "healthy"),
  );
  if (!due.length) return null;
  return (
    <Card
      title="Clusters Kubernetes que pedem atenção"
      actions={
        <Link href="/admin/kubernetes" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          Ver clusters
        </Link>
      }
    >
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {due.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <Link href={`/admin/kubernetes/${c.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              {c.name}
            </Link>
            <span className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-400">
              {c.snapshot && c.snapshot.health !== "healthy" && (
                <>
                  <span className="text-xs">{c.snapshot.reasons[0]}</span>
                  <HealthBadge s={c.snapshot} />
                </>
              )}
              {["expired", "critical", "warning"].includes(c.status) && (
                <>
                  <span className="text-xs">certificado {daysText(c.days_left)}</span>
                  <ExpiryBadge c={c} />
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Audited download, after a confirmation: the kubeconfig is cluster-admin. */
export function DownloadKubeconfig({ c }: { c: K8sCluster }) {
  const download = useMutation({
    mutationFn: async () => {
      const text = unwrap(
        await api.GET("/api/v1/admin/kubernetes/clusters/{cluster_id}/kubeconfig", {
          params: { path: { cluster_id: c.id } },
          parseAs: "text",
        }),
      ) as unknown as string;
      const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${c.name.replace(/[^A-Za-z0-9._-]/g, "_")}.kubeconfig`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  if (!c.has_kubeconfig) {
    return (
      <span className="text-xs text-slate-500" title={c.kubeconfig_error ?? undefined}>
        {c.kubeconfig_error ? "kubeconfig inválido" : "sem kubeconfig"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center">
      <Button
        variant="secondary"
        title="Baixar kubeconfig"
        disabled={download.isPending}
        onClick={() => {
          if (confirm(`Baixar o kubeconfig de "${c.name}"? Ele dá acesso de administrador ao cluster e o download fica registrado na auditoria.`)) {
            download.mutate();
          }
        }}
      >
        <Icon name="download" /> Kubeconfig
      </Button>
      {download.isError && <span className="ml-1 text-xs text-rose-600">{errorMessage(download.error)}</span>}
    </span>
  );
}

/** Platform admins: which client sees this cluster (read-only, never the kubeconfig). */
export function LinkTenantDialog({ cluster, onClose }: { cluster: K8sCluster | null; onClose: () => void }) {
  const { tenants } = useSession();
  const queryClient = useQueryClient();
  const link = useMutation({
    mutationFn: async ({ id, tenantId }: { id: string; tenantId: string | null }) =>
      unwrap(
        await api.PUT("/api/v1/admin/kubernetes/clusters/{cluster_id}/tenant", {
          params: { path: { cluster_id: id } },
          body: { tenant_id: tenantId },
        }),
      ),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "k8s-clusters"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "k8s-cluster", id] });
      queryClient.invalidateQueries({ queryKey: ["k8s-clusters"] });
      close();
    },
  });
  const close = () => {
    link.reset();
    onClose();
  };
  return (
    <Dialog open={cluster !== null} onClose={close} title={`Vincular ${cluster?.name ?? ""} a um cliente`}>
      {cluster && (
        <form
          key={cluster.id}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = String(new FormData(e.currentTarget).get("tenant_id") ?? "");
            link.mutate({ id: cluster.id, tenantId: value || null });
          }}
        >
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Os usuários do cliente passam a ver este cluster em <strong>Kubernetes</strong>: saúde, nós, namespaces,
            workloads, pods e rotas. Só leitura, e o kubeconfig nunca aparece para eles.
          </p>
          <Field label="Cliente">
            <Select name="tenant_id" defaultValue={cluster.tenant_id ?? ""} className="w-full">
              <option value="">Nenhum (só a plataforma vê)</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorBox message={link.isError ? errorMessage(link.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={link.isPending}>
              Salvar
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
