import Link from "next/link";

import { Card, Empty, formatBytes } from "@/components/ui";
import { Meter, mib, pct, rate } from "@/components/viz";
import type { Schemas } from "@/lib/api/client";

type Usage = Schemas["UsageOut"] | Schemas["AdminUsageOut"];
type Entry = Schemas["TopInstanceOut"] & Partial<Pick<Schemas["AdminTopInstanceOut"], "tenant_name" | "node_id" | "managed">>;

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

const RANKINGS = [
  { key: "cpu", title: "Mais CPU", empty: "Nenhuma VM ligada." },
  { key: "memory", title: "Mais memória", empty: "Nenhuma VM ligada." },
  { key: "disk", title: "Disco mais cheio", empty: "Sem dados de disco: as VMs precisam do qemu-guest-agent." },
  { key: "network", title: "Mais tráfego de rede", empty: "Sem tráfego medido ainda." },
] as const;

function detail(key: (typeof RANKINGS)[number]["key"], e: Entry) {
  switch (key) {
    case "cpu":
      return <Meter value={e.value} label={`${pct(e.value)} de ${e.vcpus} vCPU`} title="CPU em uso" />;
    case "memory":
      return <Meter value={e.value} label={`${mib(e.memory_used_mb)} / ${mib(e.memory_mb)}`} title="Memória em uso" />;
    case "disk":
      return <Meter value={e.value} title="Sistema de arquivos mais cheio" />;
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
  const u = usage;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Ligadas" value={u.instances_running} />
        <Stat
          label="CPU em uso"
          value={u.vcpus ? pct(u.cpu_used_vcpus / u.vcpus) : "—"}
          hint={`${u.cpu_used_vcpus.toFixed(1)} de ${u.vcpus} vCPUs ocupadas`}
        />
        <Stat
          label="Memória em uso"
          value={u.memory_mb ? pct(u.memory_used_mb / u.memory_mb) : "—"}
          hint={`${mib(u.memory_used_mb)} de ${mib(u.memory_mb)}`}
        />
        <Stat
          label="Disco usado"
          value={u.disk_total_bytes ? pct(u.disk_used_bytes / u.disk_total_bytes) : "—"}
          hint={
            u.disk_known
              ? `${formatBytes(u.disk_used_bytes)} de ${formatBytes(u.disk_total_bytes)} · ${u.disk_known} de ${u.instances_running} com dado`
              : "requer qemu-guest-agent nas VMs"
          }
        />
        <Stat
          label="Rede agora"
          value={<span className="text-lg">↓ {rate(u.net_in_bps)}</span>}
          hint={`↑ ${rate(u.net_out_bps)}`}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {RANKINGS.map((r) => {
          const rows = u.top[r.key] as Entry[];
          return (
            <Card key={r.key} title={r.title}>
              {rows.length === 0 ? (
                <Empty>{r.empty}</Empty>
              ) : (
                <ol className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((e) => {
                    const link = href(e);
                    return (
                      <li key={e.id} className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,14rem)] items-center gap-3 py-2 text-sm">
                        <div className="min-w-0">
                          {link ? (
                            <Link href={link} className="truncate font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                              {e.name}
                            </Link>
                          ) : (
                            <span className="truncate font-medium">{e.name}</span>
                          )}
                          {"tenant_name" in e && (
                            <div className="truncate text-xs text-slate-500">{e.tenant_name ?? "sem cliente (descoberta)"}</div>
                          )}
                        </div>
                        {detail(r.key, e)}
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
