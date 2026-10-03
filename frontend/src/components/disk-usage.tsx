import { formatBytes } from "@/components/ui";
import { Meter } from "@/components/viz";
import type { Schemas } from "@/lib/api/client";

type Disk = Schemas["DiskUsageOut"];

const AGENT_HINT: Record<string, string> = {
  unavailable: "Instale e ative o qemu-guest-agent na VM para ver o uso do disco.",
  forbidden: "O token do Proxmox não pode ler o agente desta VM.",
};

/** Space used inside the guest: the fullest filesystem as headline, then each one. */
export function DiskUsage({ disk, detailed = false }: { disk: Disk; detailed?: boolean }) {
  if (disk.usage === null || disk.usage === undefined) {
    return (
      <span className="text-xs text-slate-500" title={disk.agent ? AGENT_HINT[disk.agent] : undefined}>
        {disk.agent === "forbidden" ? "agente sem permissão" : disk.agent === "unavailable" ? "sem guest agent" : "—"}
      </span>
    );
  }
  if (!detailed || disk.filesystems.length <= 1) {
    return (
      <Meter
        value={disk.usage}
        label={disk.used_bytes != null && disk.total_bytes ? `${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)}` : undefined}
        title="Disco usado (o sistema de arquivos mais cheio)"
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
            title={`Uso de ${f.mountpoint}`}
          />
        </li>
      ))}
    </ul>
  );
}
