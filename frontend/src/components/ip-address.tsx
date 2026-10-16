import { useT, type MessageKey } from "@/lib/i18n";

const SOURCE: Record<string, { label: MessageKey; hint: MessageKey }> = {
  platform: { label: "compute.ip.platform", hint: "compute.ip.platformHint" },
  agent: { label: "compute.ip.agent", hint: "compute.ip.agentHint" },
  config: { label: "compute.ip.config", hint: "compute.ip.configHint" },
  ipam: { label: "compute.ip.ipam", hint: "compute.ip.ipamHint" },
};

/** An instance's IPv4, with where it came from as a tooltip (and as a tag when detailed). */
export function IpAddress({
  ip,
  source,
  gateway,
  detailed = false,
}: {
  ip: string | null | undefined;
  source: string | null | undefined;
  gateway?: string | null;
  detailed?: boolean;
}) {
  const t = useT();
  if (!ip) return <span className="text-slate-400">—</span>;
  const s = source ? SOURCE[source] : undefined;
  return (
    <span className="font-mono" title={s ? t(s.hint) : undefined}>
      {detailed ? ip : ip.split("/")[0]}
      {detailed && gateway && <span className="text-slate-500"> via {gateway}</span>}
      {detailed && s && source !== "platform" && (
        <span className="ml-2 font-sans text-xs text-slate-500">({t(s.label)})</span>
      )}
    </span>
  );
}
