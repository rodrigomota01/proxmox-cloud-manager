import { formatBytes } from "@/components/ui";
import { Meter } from "@/components/viz";
import type { Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";

type Disk = Schemas["DiskUsageOut"];

const AGENT_HINT: Record<string, MessageKey> = {
  unavailable: "compute.disk.unavailableHint",
  forbidden: "compute.disk.forbiddenHint",
};

/** Space used inside the guest: the fullest filesystem as headline, then each one. */
export function DiskUsage({ disk, detailed = false }: { disk: Disk; detailed?: boolean }) {
  const t = useT();
  if (disk.usage === null || disk.usage === undefined) {
    return (
      <span className="text-xs text-slate-500" title={disk.agent && AGENT_HINT[disk.agent] ? t(AGENT_HINT[disk.agent]) : undefined}>
        {disk.agent === "forbidden"
          ? t("compute.disk.forbidden")
          : disk.agent === "unavailable"
            ? t("compute.disk.unavailable")
            : "—"}
      </span>
    );
  }
  if (!detailed || disk.filesystems.length <= 1) {
    return (
      <Meter
        value={disk.usage}
        label={disk.used_bytes != null && disk.total_bytes ? `${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)}` : undefined}
        title={t("compute.disk.usedTitle")}
      />
    );
  }
  return (
    <ul className="space-y-1.5">
      {disk.filesystems.map((f) => (
        <li key={f.mountpoint} className="grid grid-cols-[6rem_1fr] items-center gap-2 text-xs">
          <span className="truncate font-mono text-slate-600 dark:text-slate-400" title={`${f.mountpoint} (${f.type})`}>
            {f.mountpoint}
          </span>
          <Meter
            value={f.total_bytes ? f.used_bytes / f.total_bytes : 0}
            label={`${formatBytes(f.used_bytes)} / ${formatBytes(f.total_bytes)}`}
            title={t("compute.disk.usageOf", { mount: f.mountpoint })}
          />
        </li>
      ))}
    </ul>
  );
}
