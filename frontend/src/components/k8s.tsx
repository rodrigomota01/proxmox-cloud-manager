"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Badge, Button, Card, formatBytes } from "@/components/ui";
import { Meter } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";

export type K8sCluster = Schemas["K8sClusterOut"];
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

const EXPIRY: Record<K8sCluster["status"], { tone: "red" | "amber" | "green" | "gray"; icon: string; label: string }> = {
  expired: { tone: "red", icon: "✕", label: "Vencido" },
  critical: { tone: "red", icon: "!", label: "Vence em breve" },
  warning: { tone: "amber", icon: "!", label: "Vence em até 30 dias" },
  ok: { tone: "green", icon: "✓", label: "Em dia" },
  unknown: { tone: "gray", icon: "?", label: "Sem data" },
};

export function ExpiryBadge({ c }: { c: K8sCluster }) {
  const s = EXPIRY[c.status];
  return (
    <Badge tone={s.tone}>
      <span aria-hidden className="mr-1">
        {s.icon}
      </span>
      {s.label}
    </Badge>
  );
}

const HEALTH: Record<K8sSummary["health"], { tone: "red" | "amber" | "green" | "gray"; icon: string; label: string }> = {
  healthy: { tone: "green", icon: "✓", label: "Saudável" },
  warning: { tone: "amber", icon: "!", label: "Atenção" },
  critical: { tone: "red", icon: "✕", label: "Crítico" },
  unreachable: { tone: "gray", icon: "⊘", label: "Sem conexão" },
};

export function HealthBadge({ s }: { s: K8sSummary | null | undefined }) {
  if (!s) return <Badge tone="gray">Não coletado</Badge>;
  const h = HEALTH[s.health];
  return (
    <Badge tone={h.tone}>
      <span aria-hidden className="mr-1">
        {h.icon}
      </span>
      {h.label}
    </Badge>
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
    <span>
      <Button
        variant="ghost"
        disabled={download.isPending}
        onClick={() => {
          if (confirm(`Baixar o kubeconfig de "${c.name}"? Ele dá acesso de administrador ao cluster e o download fica registrado na auditoria.`)) {
            download.mutate();
          }
        }}
      >
        Baixar kubeconfig
      </Button>
      {download.isError && <span className="ml-1 text-xs text-rose-600">{errorMessage(download.error)}</span>}
    </span>
  );
}
