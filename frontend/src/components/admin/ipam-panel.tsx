"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { relativeTime } from "@/components/activity";
import { Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Field, Input, Spinner, Status, type StatusTone, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";
import { useJob } from "@/lib/jobs";

type Address = Schemas["AddressOut"];

const STATUS: Record<string, { label: MessageKey; tone: StatusTone; hint: MessageKey }> = {
  free: { label: "infra.ipam.status.free", tone: "ok", hint: "infra.ipam.status.freeHint" },
  in_use: { label: "infra.ipam.status.inUse", tone: "info", hint: "infra.ipam.status.inUseHint" },
  load_balancer: { label: "infra.ipam.status.loadBalancer", tone: "info", hint: "infra.ipam.status.loadBalancerHint" },
  detached: { label: "infra.ipam.status.detached", tone: "warn", hint: "infra.ipam.status.detachedHint" },
  stale: { label: "infra.ipam.status.stale", tone: "warn", hint: "infra.ipam.status.staleHint" },
  conflict: { label: "infra.ipam.status.conflict", tone: "error", hint: "infra.ipam.status.conflictHint" },
  unverified: { label: "infra.ipam.status.unverified", tone: "unknown", hint: "infra.ipam.status.unverifiedHint" },
};
const ORDER = ["conflict", "stale", "detached", "free", "in_use", "load_balancer", "unverified"];

/** Sync state of the legacy IPAM (MySQL awf_ip_pool) and a manual refresh. */
export function IpamSync({ invalidate = [] as readonly (readonly unknown[])[] }: { invalidate?: readonly (readonly unknown[])[] }) {
  const t = useT();
  const [jobId, setJobId] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["admin", "ipam"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/ipam")),
    refetchInterval: 60_000,
  });
  const { job, done } = useJob(jobId, {
    admin: true,
    invalidate: [["admin", "ipam"], ["admin", "ipam-report"], ["admin", "ipam-registry"], ...invalidate],
  });
  const sync = useMutation({
    mutationFn: async () => unwrap(await api.POST("/api/v1/admin/ipam/sync")).job,
    onSuccess: (j) => setJobId(j.id),
  });
  const running = sync.isPending || (jobId !== null && !done);
  const s = status.data;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-5 py-3 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="text-slate-600 dark:text-slate-400">
        {!s
          ? "…"
          : !s.configured
            ? t("infra.ipam.notConfigured")
            : t("infra.ipam.summary", {
                addresses: s.addresses,
                integrated: s.integrated,
                synced: s.last_synced_at ? t("infra.ipam.syncedAgo", { when: relativeTime(s.last_synced_at) }) : "",
              })}
        {done && job?.status === "failed" && <span className="ml-2 text-rose-600">{job.error_message}</span>}
      </span>
      {s?.configured && (
        <Button variant="secondary" disabled={running} onClick={() => sync.mutate()}>
          {running ? <Spinner /> : null} {t("infra.ipam.syncNow")}
        </Button>
      )}
    </div>
  );
}

function Networks({ clusterId, report }: { clusterId: string; report: Schemas["IpamReportOut"] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "ipam-report", clusterId] });
  const add = useMutation({
    mutationFn: async (body: Schemas["NetworkIn"]) =>
      unwrap(
        await api.POST("/api/v1/admin/clusters/{cluster_id}/ipam/networks", {
          params: { path: { cluster_id: clusterId } },
          body,
        }),
      ),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE("/api/v1/admin/ipam/networks/{network_id}", { params: { path: { network_id: id } } })),
    onSuccess: refresh,
  });
  const line = (n: Schemas["NetworkOut"]) =>
    `${n.cidr} · gateway ${n.gateway}${n.vlan ? ` · VLAN ${n.vlan}` : ""}${n.bridge ? ` · ${n.bridge}` : ""}`;
  return (
    <Card
      title={t("infra.ipam.networksTitle")}
      description={t("infra.ipam.networksDesc")}
    >
      <ErrorBox message={add.isError ? errorMessage(add.error) : remove.isError ? errorMessage(remove.error) : null} />
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {report.networks.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-3 py-2">
            <span className="font-mono text-xs">{line(n)}</span>
            <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(n.id!)}>
              {t("infra.common.remove")}
            </Button>
          </li>
        ))}
        {report.suggestions.map((n) => (
          <li key={n.cidr} className="flex items-center justify-between gap-3 py-2">
            <span>
              <span className="font-mono text-xs">{line(n)}</span>{" "}
              <Badge tone="amber">{t("infra.ipam.detectedIn", { count: n.guests ?? 0 })}</Badge>
            </span>
            <Button
              variant="secondary"
              disabled={add.isPending}
              onClick={() =>
                add.mutate({ cidr: n.cidr, gateway: n.gateway, vlan: n.vlan ?? null, bridge: n.bridge ?? null })
              }
            >
              {t("infra.ipam.confirm")}
            </Button>
          </li>
        ))}
        {!report.networks.length && !report.suggestions.length && (
          <li className="py-2">
            <Empty icon="globe">{t("infra.ipam.noNetworks")}</Empty>
          </li>
        )}
      </ul>
      <form
        className="mt-4 grid gap-2 border-t border-slate-100 pt-4 dark:border-slate-800 sm:grid-cols-[1fr_1fr_6rem_6rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const vlan = String(f.get("vlan") ?? "").trim();
          const bridge = String(f.get("bridge") ?? "").trim();
          add.mutate(
            {
              cidr: String(f.get("cidr")),
              gateway: String(f.get("gateway")),
              vlan: vlan ? Number(vlan) : null,
              bridge: bridge || null,
            },
            { onSuccess: () => (e.target as HTMLFormElement).reset() },
          );
        }}
      >
        <Field label={t("infra.ipam.network")}>
          <Input name="cidr" required placeholder="177.54.151.0/24" />
        </Field>
        <Field label="Gateway">
          <Input name="gateway" required placeholder="177.54.151.1" />
        </Field>
        <Field label="VLAN">
          <Input name="vlan" type="number" min={1} max={4094} placeholder="—" />
        </Field>
        <Field label="Bridge">
          <Input name="bridge" placeholder="vmbr0" />
        </Field>
        <Button type="submit" variant="secondary" disabled={add.isPending}>
          {t("infra.common.add")}
        </Button>
      </form>
    </Card>
  );
}

/** Addresses of one server: what the IPAM says vs. what its guests really use. */
export function IpamPanel({ clusterId, onGuest }: { clusterId: string; onGuest?: (id: string) => string }) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const report = useQuery({
    queryKey: ["admin", "ipam-report", clusterId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/clusters/{cluster_id}/ipam", { params: { path: { cluster_id: clusterId } } })),
    refetchInterval: 60_000,
  });
  const r = report.data;
  const shown: Address[] = (r?.addresses ?? [])
    .filter((a) => !filter || a.status === filter)
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  return (
    <div className="space-y-4">
      <IpamSync />
      <ErrorBox message={report.isError ? errorMessage(report.error) : null} />
      {r && (
        <>
          <Card
            title={t("infra.ipam.addressesTitle")}
            flush
            actions={
              <Link href={`/admin/ipam?cluster=${clusterId}`} className="text-sm text-brand-600 hover:underline dark:text-brand-400">
                {t("infra.registry.editRegistry")}
              </Link>
            }
          >
            <Toolbar count={t("infra.ipam.ipCount", { count: shown.length })}>
              <div className="flex flex-wrap gap-2 text-xs">
                {[
                  ["", t("infra.ipam.all", { count: r.addresses.length })],
                  ...ORDER.filter((k) => r.counts[k]).map((k) => [
                    k,
                    t("infra.ipam.filterCount", { label: t(STATUS[k].label), count: r.counts[k] }),
                  ]),
                ].map(
                  ([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={`rounded-full border px-2 py-0.5 ${
                        filter === key
                          ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                          : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      }`}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
            </Toolbar>
            {shown.length === 0 ? (
              <Empty>{t("infra.ipam.noAddresses")}</Empty>
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>IP</th>
                      <th className={tbl.th}>{t("infra.common.situation")}</th>
                      <th className={tbl.th}>{t("infra.ipam.inRegistry")}</th>
                      <th className={tbl.th}>{t("infra.ipam.inProxmox")}</th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {shown.map((a) => (
                      <tr key={a.id} className={tbl.tr}>
                        <td className={`${tbl.td} font-mono text-xs`}>
                          {a.address}
                          {a.prefix != null && <span className="text-slate-500">/{a.prefix}</span>}
                        </td>
                        <td className={tbl.td}>
                          <Status
                            tone={STATUS[a.status]?.tone ?? "unknown"}
                            title={STATUS[a.status] ? t(STATUS[a.status].hint) : undefined}
                          >
                            {STATUS[a.status] ? t(STATUS[a.status].label) : a.status}
                          </Status>
                        </td>
                        <td className={`${tbl.td} text-xs`}>
                          <div>{a.hostname ?? <span className="text-slate-400">—</span>}</div>
                          {a.mac && <div className="font-mono text-slate-500">{a.mac}</div>}
                        </td>
                        <td className={`${tbl.td} text-xs`}>
                          {a.guest ? (
                            <>
                              {onGuest ? (
                                <a href={onGuest(a.guest.id)} className="text-brand-600 hover:underline dark:text-brand-400">
                                  {a.guest.name}
                                </a>
                              ) : (
                                a.guest.name
                              )}
                              {!a.guest.managed && <span className="text-slate-500">{t("infra.ipam.notAdopted")}</span>}
                              {a.mac_mismatch && (
                                <div className="text-amber-700 dark:text-amber-300" title={t("infra.ipam.macMismatch")}>
                                  {t("infra.ipam.macOnVm")} <span className="font-mono">{a.mac_mismatch}</span>
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!r.nics_known && (
              <p className="px-5 py-3 text-xs text-slate-500">
                {t("infra.ipam.nicsUnknown")}
              </p>
            )}
          </Card>
          {r.unregistered.length > 0 && (
            <Card title={t("infra.ipam.unregisteredTitle", { count: r.unregistered.length })}>
              <Alert variant="warning">
                {t("infra.ipam.unregisteredBody")}
              </Alert>
              <ul className="mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {r.unregistered.map((u) => (
                  <li key={u.ip} className="flex justify-between gap-3 py-2">
                    <span className="font-mono text-xs">{u.ip}</span>
                    <span className="text-xs">
                      {u.guest.name} {u.mac && <span className="font-mono text-slate-500">· {u.mac}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Networks clusterId={clusterId} report={r} />
        </>
      )}
    </div>
  );
}
