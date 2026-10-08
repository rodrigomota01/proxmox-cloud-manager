"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { relativeTime } from "@/components/activity";
import { Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Field, Input, Spinner, Status, type StatusTone, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useJob } from "@/lib/jobs";

type Address = Schemas["AddressOut"];

const STATUS: Record<string, { label: string; tone: StatusTone; hint: string }> = {
  free: { label: "livre", tone: "ok", hint: "Livre no cadastro e nenhuma VM usa." },
  in_use: { label: "em uso", tone: "info", hint: "Marcado em uso e uma VM deste servidor usa (IP ou MAC)." },
  detached: {
    label: "VM sem este IP",
    tone: "warn",
    hint: "Marcado para uma VM que existe, mas ela não tem o IP configurado. Comum com NAT/load balancer: confira antes de liberar.",
  },
  stale: {
    label: "sem VM",
    tone: "warn",
    hint: "Marcado em uso, mas nenhuma VM deste servidor usa nem tem o nome registrado. Candidato a liberar.",
  },
  conflict: {
    label: "conflito",
    tone: "error",
    hint: "Livre no cadastro, mas uma VM usa: a próxima alocação desse IP colidiria. Marque como em uso no cadastro.",
  },
  unverified: { label: "não verificado", tone: "unknown", hint: "As placas de rede das VMs ainda não foram lidas." },
};
const ORDER = ["conflict", "stale", "detached", "free", "in_use", "unverified"];

/** Sync state of the legacy IPAM (MySQL awf_ip_pool) and a manual refresh. */
function IpamSync() {
  const [jobId, setJobId] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["admin", "ipam"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/ipam")),
    refetchInterval: 60_000,
  });
  const { job, done } = useJob(jobId, { admin: true, invalidate: [["admin", "ipam"], ["admin", "ipam-report"]] });
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
            ? "Cadastro de IPs (MySQL) não configurado: defina CM_IPAM_MYSQL_URL."
            : `Cadastro de IPs (MySQL): ${s.addresses} IPs, ${s.integrated} em servidores integrados${
                s.last_synced_at ? ` · sincronizado ${relativeTime(s.last_synced_at)}` : ""
              }.`}
        {done && job?.status === "failed" && <span className="ml-2 text-rose-600">{job.error_message}</span>}
      </span>
      {s?.configured && (
        <Button variant="secondary" disabled={running} onClick={() => sync.mutate()}>
          {running ? <Spinner /> : null} Sincronizar agora
        </Button>
      )}
    </div>
  );
}

function Networks({ clusterId, report }: { clusterId: string; report: Schemas["IpamReportOut"] }) {
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
      title="Redes deste servidor"
      description="O cadastro não guarda gateway, máscara nem VLAN. Aqui fica como configurar os IPs de cada faixa nas VMs novas. IPs com /31 não precisam: o gateway é o par do /31."
    >
      <ErrorBox message={add.isError ? errorMessage(add.error) : remove.isError ? errorMessage(remove.error) : null} />
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {report.networks.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-3 py-2">
            <span className="font-mono text-xs">{line(n)}</span>
            <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(n.id!)}>
              Remover
            </Button>
          </li>
        ))}
        {report.suggestions.map((n) => (
          <li key={n.cidr} className="flex items-center justify-between gap-3 py-2">
            <span>
              <span className="font-mono text-xs">{line(n)}</span>{" "}
              <Badge tone="amber">detectada em {n.guests} VM(s)</Badge>
            </span>
            <Button
              variant="secondary"
              disabled={add.isPending}
              onClick={() =>
                add.mutate({ cidr: n.cidr, gateway: n.gateway, vlan: n.vlan ?? null, bridge: n.bridge ?? null })
              }
            >
              Confirmar
            </Button>
          </li>
        ))}
        {!report.networks.length && !report.suggestions.length && (
          <li className="py-2">
            <Empty icon="globe">Nenhuma rede configurada.</Empty>
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
        <Field label="Rede">
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
          Adicionar
        </Button>
      </form>
    </Card>
  );
}

/** Addresses of one server: what the IPAM says vs. what its guests really use. */
export function IpamPanel({ clusterId, onGuest }: { clusterId: string; onGuest?: (id: string) => string }) {
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
          <Card title="IPs do cadastro neste servidor" flush>
            <Toolbar count={`${shown.length} IP(s)`}>
              <div className="flex flex-wrap gap-2 text-xs">
                {[["", `Todos (${r.addresses.length})`], ...ORDER.filter((k) => r.counts[k]).map((k) => [k, `${STATUS[k].label} (${r.counts[k]})`])].map(
                  ([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={`rounded-full border px-2 py-0.5 ${
                        filter === key
                          ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
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
              <Empty>Nenhum IP do cadastro está associado a este servidor (pve_node_owner).</Empty>
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={tbl.thead}>
                    <tr>
                      <th className={tbl.th}>IP</th>
                      <th className={tbl.th}>Situação</th>
                      <th className={tbl.th}>No cadastro</th>
                      <th className={tbl.th}>No Proxmox</th>
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
                          <Status tone={STATUS[a.status]?.tone ?? "unknown"} title={STATUS[a.status]?.hint}>
                            {STATUS[a.status]?.label ?? a.status}
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
                                <a href={onGuest(a.guest.id)} className="text-indigo-600 hover:underline dark:text-indigo-400">
                                  {a.guest.name}
                                </a>
                              ) : (
                                a.guest.name
                              )}
                              {!a.guest.managed && <span className="text-slate-500"> · não adotada</span>}
                              {a.mac_mismatch && (
                                <div className="text-amber-700 dark:text-amber-300" title="MAC da placa difere do cadastro">
                                  MAC na VM: <span className="font-mono">{a.mac_mismatch}</span>
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
                As placas de rede das VMs ainda não foram lidas; a verificação aparece após a próxima sincronização.
              </p>
            )}
          </Card>
          {r.unregistered.length > 0 && (
            <Card title={`IPs públicos fora do cadastro (${r.unregistered.length})`}>
              <Alert variant="warning">
                Configurados em VMs deste servidor, mas ausentes do cadastro: cadastre-os para não serem oferecidos a
                outra VM.
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
