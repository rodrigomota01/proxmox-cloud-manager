import Link from "next/link";

import { StatTile } from "@/components/page";
import { Card, Empty, formatBytes } from "@/components/ui";
import { Meter, mib, pct, rate } from "@/components/viz";
import type { Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";

type Usage = Schemas["UsageOut"] | Schemas["AdminUsageOut"];
type Entry = Schemas["TopInstanceOut"] & Partial<Pick<Schemas["AdminTopInstanceOut"], "tenant_name" | "node_id" | "managed">>;

/** Plain number tile; StatTile adds icon, link and tone. */
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return <StatTile label={label} value={value} hint={hint} />;
}

const RANKINGS: readonly { key: "cpu" | "memory" | "disk" | "network"; title: MessageKey; empty: MessageKey }[] = [
  { key: "cpu", title: "compute.usage.topCpu", empty: "compute.usage.noneRunning" },
  { key: "memory", title: "compute.usage.topMemory", empty: "compute.usage.noneRunning" },
  { key: "disk", title: "compute.usage.topDisk", empty: "compute.usage.noDiskData" },
  { key: "network", title: "compute.usage.topNetwork", empty: "compute.usage.noTraffic" },
];

function detail(key: (typeof RANKINGS)[number]["key"], e: Entry, t: ReturnType<typeof useT>) {
  switch (key) {
    case "cpu":
      return (
        <Meter
          value={e.value}
          label={t("compute.usage.cpuOfVcpus", { pct: pct(e.value), vcpus: e.vcpus })}
          title={t("compute.usage.cpuInUse")}
        />
      );
    case "memory":
      return (
        <Meter value={e.value} label={`${mib(e.memory_used_mb)} / ${mib(e.memory_mb)}`} title={t("compute.usage.memoryInUse")} />
      );
    case "disk":
      return <Meter value={e.value} title={t("compute.usage.fullestFs")} />;
    case "network":
      return (
        <span className="text-xs tabular-nums text-slate-700 dark:text-slate-300">
          ↓ {rate(e.net_in_bps)} · ↑ {rate(e.net_out_bps)}
        </span>
      );
  }
}

/** Live usage of the running guests in view: totals, then the top consumers. */
export function UsagePanel({ usage, href }: { usage: Usage; href: (e: Entry) => string | null }) {
  const t = useT();
  const u = usage;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label={t("compute.usage.running")} value={u.instances_running} />
        <Stat
          label={t("compute.usage.cpuInUse")}
          value={u.vcpus ? pct(u.cpu_used_vcpus / u.vcpus) : "—"}
          hint={t("compute.usage.vcpusBusy", { used: u.cpu_used_vcpus.toFixed(1), total: u.vcpus })}
        />
        <Stat
          label={t("compute.usage.memoryInUse")}
          value={u.memory_mb ? pct(u.memory_used_mb / u.memory_mb) : "—"}
          hint={t("compute.usage.bytesOf", { used: mib(u.memory_used_mb), total: mib(u.memory_mb) })}
        />
        <Stat
          label={t("compute.usage.diskUsed")}
          value={u.disk_total_bytes ? pct(u.disk_used_bytes / u.disk_total_bytes) : "—"}
          hint={
            u.disk_known
              ? t("compute.usage.diskKnown", {
                  used: formatBytes(u.disk_used_bytes),
                  total: formatBytes(u.disk_total_bytes),
                  known: u.disk_known,
                  running: u.instances_running,
                })
              : t("compute.usage.needsAgent")
          }
        />
        <Stat
          label={t("compute.usage.networkNow")}
          value={<span className="text-lg">↓ {rate(u.net_in_bps)}</span>}
          hint={`↑ ${rate(u.net_out_bps)}`}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {RANKINGS.map((r) => {
          const rows = u.top[r.key] as Entry[];
          return (
            <Card key={r.key} title={t(r.title)}>
              {rows.length === 0 ? (
                <Empty icon="dashboard">{t(r.empty)}</Empty>
              ) : (
                <ol className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((e) => {
                    const link = href(e);
                    return (
                      <li key={e.id} className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,14rem)] items-center gap-3 py-2 text-sm">
                        <div className="min-w-0">
                          {link ? (
                            <Link href={link} className="truncate font-medium text-brand-600 hover:underline dark:text-brand-400">
                              {e.name}
                            </Link>
                          ) : (
                            <span className="truncate font-medium">{e.name}</span>
                          )}
                          {"tenant_name" in e && (
                            <div className="truncate text-xs text-slate-500">{e.tenant_name ?? t("compute.usage.noTenant")}</div>
                          )}
                        </div>
                        {detail(r.key, e, t)}
                      </li>
                    );
                  })}
                </ol>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
