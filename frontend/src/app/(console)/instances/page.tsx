"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { PowerActions } from "@/components/power-actions";
import { Button, Card, Empty, ErrorBox, PowerBadge, Select } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useProjectNames, useProjects } from "@/lib/queries";
import { useSession } from "@/lib/session";

type Kind = "vm" | "container";
type Power = "running" | "stopped" | "paused" | "unknown";

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
              limit: 50,
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
    refetchInterval: 15_000, // power state changes outside the platform show up here
  });

  if (!tenantId) return <NoTenant />;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Instâncias</h1>
        <div className="flex flex-wrap gap-2">
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
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Nome</th>
                  <th className="py-2 pr-4 font-medium">Projeto</th>
                  <th className="py-2 pr-4 font-medium">Tipo</th>
                  <th className="py-2 pr-4 font-medium">Estado</th>
                  <th className="py-2 pr-4 font-medium">vCPU / RAM / Disco</th>
                  <th className="py-2 font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/instances/${i.id}`}
                        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {i.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{projectNames.get(i.project_id) ?? "—"}</td>
                    <td className="py-2 pr-4">{i.kind === "vm" ? "VM" : "Container"}</td>
                    <td className="py-2 pr-4">
                      <PowerBadge state={i.power_state} />
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-slate-600 dark:text-slate-400">
                      {i.vcpus} · {(i.memory_mb / 1024).toFixed(1)} GiB · {i.root_disk_gb} GiB
                    </td>
                    <td className="py-2">
                      <PowerActions instance={i} compact />
                    </td>
                  </tr>
                ))}
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
