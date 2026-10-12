const SOURCE: Record<string, { label: string; hint: string }> = {
  platform: { label: "plataforma", hint: "Configurado pela plataforma na criação da instância." },
  agent: { label: "guest agent", hint: "Informado pela própria VM (QEMU guest agent)." },
  config: { label: "config", hint: "IP estático na configuração do Proxmox (cloud-init ou container)." },
  ipam: { label: "IPAM", hint: "Do IPAM, pelo MAC da placa de rede. A VM pode estar usando outro IP." },
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
  if (!ip) return <span className="text-slate-400">—</span>;
  const s = source ? SOURCE[source] : undefined;
  return (
    <span className="font-mono" title={s?.hint}>
      {detailed ? ip : ip.split("/")[0]}
      {detailed && gateway && <span className="text-slate-500"> via {gateway}</span>}
      {detailed && s && source !== "platform" && (
        <span className="ml-2 font-sans text-xs text-slate-500">({s.label})</span>
      )}
    </span>
  );
}
