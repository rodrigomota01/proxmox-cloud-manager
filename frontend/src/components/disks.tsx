"use client";

import { useQuery } from "@tanstack/react-query";

import { Card, Empty, Status, formatBytes, tbl } from "@/components/ui";
import { Meter } from "@/components/viz";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { translate, useT, type MessageKey } from "@/lib/i18n";

type Volume = Schemas["VolumeOut"] | Schemas["AdminVolumeOut"];
type PhysicalDisk = Schemas["PhysicalDiskOut"];

/** Every virtual disk of an instance; falls back to the boot disk size before the first read. */
export function VolumeList({ volumes, rootDiskGb }: { volumes: Volume[]; rootDiskGb: number }) {
  const t = useT();
  if (!volumes.length) return <span className="tabular-nums">{rootDiskGb} GiB</span>;
  return (
    <ul className="space-y-0.5">
      {volumes.map((v) => (
        <li key={v.name} className="tabular-nums">
          <span className="font-mono text-xs text-slate-500">{v.name}</span> {formatBytes(v.size_bytes)}
          {"storage" in v && <span className="text-xs text-slate-500">{t("infra.disks.onStorage", { storage: v.storage })}</span>}
          {v.used_bytes != null && (
            <span className="text-xs text-slate-500" title={t("infra.disks.usedHint")}>
              {" "}
              {t("infra.disks.used", { size: formatBytes(v.used_bytes) })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "232 GiB em 2 discos" (compact, for tables; called during render). */
export function volumesSummary(volumes: Volume[], rootDiskGb: number): string {
  if (volumes.length <= 1) return `${volumes.length ? formatBytes(volumes[0].size_bytes) : `${rootDiskGb} GiB`}`;
  const total = volumes.reduce((a, v) => a + v.size_bytes, 0);
  return translate("infra.disks.summary", { size: formatBytes(total), count: volumes.length });
}

const HEALTHY = new Set(["PASSED", "OK"]);

/** Disks whose SMART status says something other than healthy (unknown is not a failure). */
export function failingDisks(disks: PhysicalDisk[]): PhysicalDisk[] {
  return disks.filter((d) => d.health && !HEALTHY.has(d.health.toUpperCase()));
}

function Health({ d }: { d: PhysicalDisk }) {
  const t = useT();
  if (!d.health) return <Status tone="unknown">{t("infra.disks.noSmart")}</Status>;
  return HEALTHY.has(d.health.toUpperCase()) ? (
    <Status tone="ok">{d.health}</Status>
  ) : (
    <Status tone="error">{d.health}</Status>
  );
}

const USED_LABEL: Record<string, string> = {
  linux_raid_member: "RAID (mdadm)",
  LVM: "LVM",
  "LVM-Thin": "LVM-Thin",
  ZFS: "ZFS",
};
const USED_KEY: Record<string, MessageKey> = {
  partitions: "infra.disks.partitions",
  mounted: "infra.disks.mounted",
};

export function PhysicalDisksCard({ disks, checkedAt }: { disks: PhysicalDisk[]; checkedAt: string | null }) {
  const t = useT();
  return (
    <Card title={t("infra.disks.physicalDisks")} flush>
      {!disks.length ? (
        <Empty icon="layers">
          {checkedAt ? t("infra.disks.noDisks") : t("infra.disks.notRead")}
        </Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>{t("infra.disks.device")}</th>
                <th className={tbl.th}>{t("infra.disks.model")}</th>
                <th className={`${tbl.th} text-right`}>{t("infra.disks.size")}</th>
                <th className={tbl.th}>{t("infra.common.usage")}</th>
                <th className={tbl.th}>{t("infra.disks.health")}</th>
                <th className={tbl.th} title={t("infra.disks.wearHint")}>
                  {t("infra.disks.wear")}
                </th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {disks.map((d) => (
                <tr key={d.device} className={tbl.tr}>
                  <td className={`${tbl.td} font-mono text-xs`}>
                    {d.device}
                    {d.type && <div className="font-sans text-slate-500">{d.type.toUpperCase()}</div>}
                  </td>
                  <td className={tbl.td}>
                    {d.model ?? "—"}
                    {d.serial && <div className="font-mono text-xs text-slate-500">{d.serial}</div>}
                  </td>
                  <td className={`${tbl.td} text-right tabular-nums`}>{formatBytes(d.size_bytes)}</td>
                  <td className={tbl.td}>{d.used ? (USED_KEY[d.used] ? t(USED_KEY[d.used]) : (USED_LABEL[d.used] ?? d.used)) : <span className="text-slate-400">{t("infra.disks.free")}</span>}</td>
                  <td className={tbl.td}>
                    <Health d={d} />
                  </td>
                  <td className={`${tbl.td} w-40`}>
                    {/* The API's wearout is the life left (100 = new); the meter shows wear, which goes red as it grows. */}
                    {d.wearout != null ? (
                      <Meter
                        value={(100 - d.wearout) / 100}
                        label={`${100 - d.wearout}%`}
                        title={t("infra.disks.lifeLeft", { percent: d.wearout })}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Storages of one node (shared ones included: they are mounted there too). */
export function NodeStorageCard({ clusterId, node }: { clusterId: string; node: string }) {
  const storage = useQuery({
    queryKey: ["admin", "storage"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/storage")),
    refetchInterval: 30_000,
  });
  const t = useT();
  if (!storage.data) return null; // loading, or no cluster:manage to list storages
  const rows = storage.data.filter((s) => s.cluster_id === clusterId && s.node === node);
  return (
    <Card title={t("infra.disks.storages")} flush>
      {!rows.length ? (
        <Empty icon="layers">{t("infra.disks.noStorage")}</Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>Storage</th>
                <th className={tbl.th}>{t("infra.common.type")}</th>
                <th className={tbl.th}>{t("infra.disks.content")}</th>
                <th className={tbl.th}>{t("infra.common.status")}</th>
                <th className={tbl.th}>{t("infra.common.usage")}</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {rows.map((s) => (
                <tr key={s.id} className={tbl.tr}>
                  <td className={`${tbl.td} font-medium`}>{s.name}</td>
                  <td className={tbl.td}>
                    {s.type}
                    {s.shared && <span className="ml-1 text-xs text-slate-500">{t("infra.common.shared")}</span>}
                  </td>
                  <td className={`${tbl.td} text-xs text-slate-600 dark:text-slate-400`}>{s.content.join(", ")}</td>
                  <td className={tbl.td}>
                    {s.active ? <Status tone="ok">{t("infra.common.active")}</Status> : <Status tone="error">{t("infra.common.inactive")}</Status>}
                  </td>
                  <td className={`${tbl.td} w-56`}>
                    <Meter
                      value={s.total_bytes ? s.used_bytes / s.total_bytes : 0}
                      label={`${formatBytes(s.used_bytes)} / ${formatBytes(s.total_bytes)}`}
                      title={t("infra.common.usageOf", { name: s.name })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
