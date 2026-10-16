"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Fragment, useState } from "react";

import { Icon } from "@/components/icons";
import { Button, Card, Dialog, ErrorBox, Field, Input, Select, Status, type StatusTone, formatBytes } from "@/components/ui";
import { Meter } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { type MessageKey, translate, useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";

export type K8sCluster = Schemas["K8sClusterOut"];
/** admin: /admin/kubernetes (every cluster); tenant: /kubernetes (the client's, read-only) */
export type K8sMode = "admin" | "tenant";
export type K8sSummary = Schemas["K8sSummaryOut"];

/** A translated text with elements in its `{placeholders}` (bold names, code). */
export function rich(text: string, parts: Record<string, React.ReactNode>): React.ReactNode {
  return text.split(/\{(\w+)\}/).map((piece, i) => (
    <Fragment key={i}>{i % 2 ? (parts[piece] ?? `{${piece}}`) : piece}</Fragment>
  ));
}

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
  stacked,
}: {
  usage: number | null | undefined;
  requests: number;
  allocatable: number;
  format: (v: number) => string;
  what: string;
  stacked?: boolean;
}) {
  const t = useT();
  if (!allocatable) return <span className="text-xs text-slate-500">—</span>;
  const measured = usage !== null && usage !== undefined;
  const value = measured ? usage : requests;
  return (
    <Meter
      value={value / allocatable}
      label={`${format(value)} / ${format(allocatable)}`}
      title={t(measured ? "k8s.usage.inUse" : "k8s.usage.reserved", { what })}
      stacked={stacked}
    />
  );
}

const EXPIRY: Record<K8sCluster["status"], { tone: StatusTone; label: MessageKey }> = {
  expired: { tone: "error", label: "k8s.expiry.expired" },
  critical: { tone: "error", label: "k8s.expiry.critical" },
  warning: { tone: "warn", label: "k8s.expiry.warning" },
  ok: { tone: "ok", label: "k8s.expiry.ok" },
  unknown: { tone: "unknown", label: "k8s.expiry.unknown" },
};

export function ExpiryBadge({ c }: { c: K8sCluster }) {
  const t = useT();
  const s = EXPIRY[c.status];
  return <Status tone={s.tone}>{t(s.label)}</Status>;
}

const HEALTH: Record<K8sSummary["health"], { tone: StatusTone; label: MessageKey; icon?: "ban" }> = {
  healthy: { tone: "ok", label: "k8s.health.healthy" },
  warning: { tone: "warn", label: "k8s.health.warning" },
  critical: { tone: "error", label: "k8s.health.critical" },
  unreachable: { tone: "off", label: "k8s.health.unreachable", icon: "ban" },
};

export function HealthBadge({ s }: { s: Pick<K8sSummary, "health"> | null | undefined }) {
  const t = useT();
  if (!s) return <Status tone="unknown">{t("k8s.health.notCollected")}</Status>;
  const h = HEALTH[s.health];
  return (
    <Status tone={h.tone} icon={h.icon}>
      {t(h.label)}
    </Status>
  );
}

export function daysText(days: number | null): string {
  if (days === null) return "";
  if (days < 0) return translate(days === -1 ? "k8s.expiry.expiredAgoOne" : "k8s.expiry.expiredAgoOther", { n: -days });
  if (days === 0) return translate("k8s.expiry.today");
  return translate(days === 1 ? "k8s.expiry.inOne" : "k8s.expiry.inOther", { n: days });
}

/** Time since `iso`: "há 5 min" (`suffix`), or just "5 min" for an age column. */
export function ago(iso: string | null | undefined, suffix = true): string {
  if (!iso) return translate("k8s.time.never");
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return translate("k8s.time.now");
  if (s < 5400) return translate(suffix ? "k8s.time.minutesAgo" : "k8s.time.minutes", { n: Math.round(s / 60) });
  if (s < 172800) return translate(suffix ? "k8s.time.hoursAgo" : "k8s.time.hours", { n: Math.round(s / 3600) });
  return translate(suffix ? "k8s.time.daysAgo" : "k8s.time.days", { n: Math.round(s / 86400) });
}

/** Platform dashboard: clusters needing attention (health or certificate). */
export function K8sAttentionPreview() {
  const t = useT();
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
      title={t("k8s.attention.title")}
      actions={
        <Link href="/admin/kubernetes" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
          {t("k8s.attention.viewClusters")}
        </Link>
      }
    >
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {due.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <Link href={`/admin/kubernetes/${c.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
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
                  <span className="text-xs">{t("k8s.attention.certificate", { days: daysText(c.days_left) })}</span>
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
/** `labelClassName` hides the text (e.g. below a container width), leaving the icon. */
export function DownloadKubeconfig({
  c,
  tenant = false,
  labelClassName,
}: {
  c: K8sCluster;
  tenant?: boolean;
  labelClassName?: string;
}) {
  const t = useT();
  const download = useMutation({
    mutationFn: async () => {
      const opts = { params: { path: { cluster_id: c.id } }, parseAs: "text" as const };
      const text = unwrap(
        tenant
          ? await api.GET("/api/v1/kubernetes/clusters/{cluster_id}/kubeconfig", opts)
          : await api.GET("/api/v1/admin/kubernetes/clusters/{cluster_id}/kubeconfig", opts),
      ) as unknown as string;
      const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${c.name.replace(/[^A-Za-z0-9._-]/g, "_")}.kubeconfig`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  // tenants never see has_kubeconfig; a cluster the platform created has one once active
  if (tenant ? c.managed?.state !== "active" : !c.has_kubeconfig) {
    return (
      <span className="text-xs text-slate-500" title={c.kubeconfig_error ?? undefined}>
        {t(c.kubeconfig_error ? "k8s.kubeconfig.invalid" : "k8s.kubeconfig.missing")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center">
      <Button
        variant="secondary"
        title={t("k8s.kubeconfig.download")}
        aria-label={t("k8s.kubeconfig.download")}
        disabled={download.isPending}
        onClick={() => {
          if (confirm(t("k8s.kubeconfig.confirm", { name: c.name }))) {
            download.mutate();
          }
        }}
      >
        <Icon name="download" /> <span className={labelClassName}>Kubeconfig</span>
      </Button>
      {download.isError && <span className="ml-1 text-xs text-rose-600">{errorMessage(download.error)}</span>}
    </span>
  );
}

/** Platform admins: which client sees this cluster (read-only, never the kubeconfig). */
export function LinkTenantDialog({ cluster, onClose }: { cluster: K8sCluster | null; onClose: () => void }) {
  const t = useT();
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
    <Dialog open={cluster !== null} onClose={close} title={t("k8s.linkTenant.title", { name: cluster?.name ?? "" })}>
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
            {rich(t("k8s.linkTenant.intro"), { section: <strong>Kubernetes</strong> })}
          </p>
          <Field label={t("k8s.common.client")}>
            <Select name="tenant_id" defaultValue={cluster.tenant_id ?? ""} className="w-full">
              <option value="">{t("k8s.linkTenant.none")}</option>
              {tenants.map((tn) => (
                <option key={tn.id} value={tn.id}>
                  {tn.name}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorBox message={link.isError ? errorMessage(link.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              {t("k8s.common.cancel")}
            </Button>
            <Button type="submit" disabled={link.isPending}>
              {t("k8s.common.save")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}


/** Steps of k8s.create, as recorded in state_message while provisioning. */
export const K8S_STEPS: [string, MessageKey][] = [
  ["queued", "k8s.steps.queued"],
  ["lb_ip", "k8s.steps.lbIp"],
  ["vms", "k8s.steps.vms"],
  ["agent", "k8s.steps.agent"],
  ["prepare", "k8s.steps.prepare"],
  ["init", "k8s.steps.init"],
  ["join", "k8s.steps.join"],
  ["addons", "k8s.steps.addons"],
  ["kubeconfig", "k8s.steps.kubeconfig"],
];
const STEP_LABEL: Record<string, MessageKey> = Object.fromEntries(K8S_STEPS);

/** Lifecycle of a cluster the platform created; nothing for an active one. */
export function ManagedState({ c }: { c: K8sCluster }) {
  const t = useT();
  const m = c.managed;
  if (!m || m.state === "active") return null;
  if (m.state === "error") return <Status tone="error">{t("k8s.managed.failed")}</Status>;
  if (m.state === "deleting") return <Status tone="progress">{t("k8s.managed.deleting")}</Status>;
  return (
    <Status tone="progress">
      {t(m.state === "provisioning" ? (STEP_LABEL[m.state_message ?? "queued"] ?? "k8s.managed.creating") : "k8s.managed.updating")}
    </Status>
  );
}

/** Destroys a cluster the platform created, with its VMs, after typing its name. */
export function DestroyClusterButton({ c, admin, onDone }: { c: K8sCluster; admin: boolean; onDone: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const destroy = useMutation({
    mutationFn: async () =>
      admin
        ? unwrap(
            await api.POST("/api/v1/admin/kubernetes/clusters/{cluster_id}/destroy", {
              params: { path: { cluster_id: c.id } },
              body: { confirm: confirmName },
            }),
          )
        : unwrap(
            await api.DELETE("/api/v1/kubernetes/clusters/{cluster_id}", {
              params: { path: { cluster_id: c.id } },
              body: { confirm: confirmName },
            }),
          ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: admin ? ["admin", "k8s-clusters"] : ["k8s-clusters"] });
      setOpen(false);
      onDone();
    },
  });
  const state = c.managed?.state;
  if (!c.managed || (state !== "active" && state !== "error")) return null;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {t("k8s.destroy.button")}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("k8s.destroy.title")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            destroy.mutate();
          }}
          className="space-y-4"
        >
          <p className="text-sm">
            {rich(t("k8s.destroy.body"), { name: <strong>{c.name}</strong>, localPath: <code>local-path</code> })}
          </p>
          <Field label={t("k8s.destroy.confirmLabel", { name: c.name })}>
            <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
          </Field>
          <ErrorBox message={destroy.isError ? errorMessage(destroy.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t("k8s.common.cancel")}
            </Button>
            <Button type="submit" variant="danger" disabled={confirmName !== c.name || destroy.isPending}>
              {t("k8s.destroy.submit")}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
