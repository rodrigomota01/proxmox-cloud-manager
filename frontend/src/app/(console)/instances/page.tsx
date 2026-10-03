"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { PowerActions } from "@/components/power-actions";
import { Button, Card, Empty, ErrorBox, PowerBadge, Select, StateBadge } from "@/components/ui";
import { Meter, SortHeader, mib, uptime, useSorted } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useProjectNames, useProjects } from "@/lib/queries";
import { useSession } from "@/lib/session";

type Kind = "vm" | "container";
type Power = "running" | "stopped" | "paused" | "unknown";
type Instance = Schemas["InstanceOut"];
type SortKey = "name" | "cpu" | "memory" | "uptime";

const memRatio = (i: Instance) => (i.memory_mb ? i.memory_used_mb / i.memory_mb : 0);

export default function InstancesPage() {
  const { tenantId } = useSession();
  const projects = useProjects();
  const projectNames = useProjectNames();
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [power, setPower] = useState<Power | "">("");

  const list = useInfiniteQuery({
    queryKey: ["instances", tenantId, projectId, kind, power],
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET("/api/v1/instances", {
          params: {
            query: {
              limit: 200,
              cursor: pageParam ?? undefined,
              project_id: projectId || undefined,
              kind: kind || undefined,
              power_state: power || undefined,
            },
          },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    enabled: tenantId !== null,
    refetchInterval: 15_000, // the reconciler refreshes usage every ~15s
  });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const { sorted, sort, toggle } = useSorted<Instance, SortKey>(
    items,
    {
      name: (i) => i.name,
      cpu: (i) => (i.power_state === "running" ? i.cpu_usage : -1),
      memory: (i) => (i.power_state === "running" ? memRatio(i) : -1),
      uptime: (i) => i.uptime_seconds,
    },
    { key: "name", desc: false },
  );

  if (!tenantId) return <NoTenant />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Instâncias</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/instances/new">
            <Button>Nova instância</Button>
          </Link>
          <Select aria-label="Projeto" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Todos os projetos</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as Kind | "")}>
            <option value="">VMs e containers</option>
            <option value="vm">VMs</option>
            <option value="container">Containers</option>
          </Select>
          <Select aria-label="Estado" value={power} onChange={(e) => setPower(e.target.value as Power | "")}>
            <option value="">Qualquer estado</option>
            <option value="running">Ligadas</option>
            <option value="stopped">Desligadas</option>
            <option value="paused">Pausadas</option>
            <option value="unknown">Desconhecido</option>
          </Select>
        </div>
      </div>

      <ErrorBox message={list.isError ? errorMessage(list.error) : null} />
      <Card>
        {list.isSuccess && items.length === 0 && <Empty>Nenhuma instância encontrada.</Empty>}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <SortHeader label="Nome" k="name" sort={sort} toggle={toggle} />
                  <th className="py-2 pr-4 font-medium uppercase tracking-wide">Estado</th>
                  <SortHeader label="CPU" k="cpu" sort={sort} toggle={toggle} />
                  <SortHeader label="Memória" k="memory" sort={sort} toggle={toggle} />
                  <th className="py-2 pr-4 text-right font-medium uppercase tracking-wide">Disco</th>
                  <th className="py-2 pr-4 font-medium uppercase tracking-wide">IP</th>
                  <SortHeader label="Ligada há" k="uptime" sort={sort} toggle={toggle} align="right" />
                  <th className="py-2 font-medium uppercase tracking-wide">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sorted.map((i) => {
                  const running = i.state === "active" && i.power_state === "running";
                  return (
                    <tr key={i.id} className="align-middle">
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/instances/${i.id}`}
                          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          {i.name}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {i.kind === "vm" ? "VM" : "Container"} · {projectNames.get(i.project_id) ?? "—"} ·{" "}
                          {i.vcpus} vCPU
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        {i.state === "active" ? <PowerBadge state={i.power_state} /> : <StateBadge state={i.state} />}
                      </td>
                      <td className="py-2.5 pr-4">
                        {running ? (
                          <Meter value={i.cpu_usage} title={`CPU de ${i.name}`} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        {running ? (
                          <Meter
                            value={memRatio(i)}
                            label={`${mib(i.memory_used_mb)} / ${mib(i.memory_mb)}`}
                            title={`Memória de ${i.name}`}
                          />
                        ) : (
                          <span className="text-slate-400">{mib(i.memory_mb)}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{i.root_disk_gb} GiB</td>
                      <td className="py-2.5 pr-4 font-mono text-xs">{i.ipv4?.split("/")[0] ?? "—"}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-slate-600 dark:text-slate-400">
                        {running ? uptime(i.uptime_seconds) : "—"}
                      </td>
                      <td className="py-2.5">
                        <PowerActions instance={i} compact />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.hasNextPage && (
          <div className="pt-4 text-center">
            <Button variant="secondary" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              Carregar mais
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
