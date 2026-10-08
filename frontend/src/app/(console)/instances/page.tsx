"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { NoTenant } from "@/components/no-tenant";
import { PageHeader, ResourceIcon, SearchInput, Toolbar } from "@/components/page";
import { PowerActions } from "@/components/power-actions";
import { Button, Card, Empty, ErrorBox, PowerBadge, Select, StateBadge, tbl } from "@/components/ui";
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
  const [search, setSearch] = useState("");

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

  const loaded = list.data?.pages.flatMap((p) => p.items) ?? [];
  const needle = search.trim().toLowerCase();
  const items = needle
    ? loaded.filter((i) => i.name.toLowerCase().includes(needle) || i.ipv4?.includes(needle))
    : loaded;
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

  const filtered = !!(projectId || kind || power || needle);
  const create = (
    <Link href="/instances/new">
      <Button>
        <Icon name="plus" /> Criar instância
      </Button>
    </Link>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Máquinas virtuais"
        description="VMs e containers do cliente, com estado, consumo atual e ações de energia."
        actions={create}
      />

      <ErrorBox message={list.isError ? errorMessage(list.error) : null} />
      <Card flush>
        <Toolbar count={list.isSuccess ? `${items.length} ${items.length === 1 ? "item" : "itens"}` : undefined}>
          <SearchInput value={search} onChange={setSearch} placeholder="Filtrar por nome ou IP…" />
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
        </Toolbar>
        {list.isSuccess && items.length === 0 &&
          (filtered ? (
            <Empty title="Nenhuma instância encontrada">Nenhuma instância corresponde aos filtros.</Empty>
          ) : (
            <Empty title="Nenhuma instância ainda" icon="monitor" action={create}>
              Crie a primeira VM do cliente escolhendo região, imagem e tamanho.
            </Empty>
          ))}
        {items.length > 0 && (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <SortHeader label="Nome" k="name" sort={sort} toggle={toggle} />
                  <th className={tbl.th}>Status</th>
                  <th className={tbl.th}>Zona</th>
                  <SortHeader label="CPU" k="cpu" sort={sort} toggle={toggle} />
                  <SortHeader label="Memória" k="memory" sort={sort} toggle={toggle} />
                  <th className={`${tbl.th} text-right`}>Disco</th>
                  <th className={tbl.th}>IP</th>
                  <SortHeader label="Ligada há" k="uptime" sort={sort} toggle={toggle} align="right" />
                  <th className={tbl.th}>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {sorted.map((i) => {
                  const running = i.state === "active" && i.power_state === "running";
                  return (
                    <tr key={i.id} className={tbl.tr}>
                      <td className={tbl.td}>
                        <div className="flex items-center gap-2">
                          <ResourceIcon kind={i.kind === "vm" ? "vm" : "container"} />
                          <Link href={`/instances/${i.id}`} className={tbl.link}>
                            {i.name}
                          </Link>
                        </div>
                        <div className="mt-0.5 pl-7 text-xs text-slate-500">
                          {projectNames.get(i.project_id) ?? "—"} · {i.vcpus} vCPU
                        </div>
                      </td>
                      <td className={tbl.td}>
                        {i.state === "active" ? <PowerBadge state={i.power_state} /> : <StateBadge state={i.state} />}
                      </td>
                      <td className={tbl.td}>
                        {i.zone_name ?? "—"}
                        {i.region_name && <div className="text-xs text-slate-500">{i.region_name}</div>}
                      </td>
                      <td className={tbl.td}>
                        {running ? (
                          <Meter value={i.cpu_usage} title={`CPU de ${i.name}`} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className={tbl.td}>
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
                      <td className={`${tbl.td} text-right tabular-nums`}>{i.root_disk_gb} GiB</td>
                      <td className={`${tbl.td} font-mono text-xs`}>{i.ipv4?.split("/")[0] ?? "—"}</td>
                      <td className={`${tbl.td} text-right tabular-nums text-slate-600 dark:text-slate-400`}>
                        {running ? uptime(i.uptime_seconds) : "—"}
                      </td>
                      <td className={`${tbl.td} w-12 text-right`}>
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
          <div className="border-t border-slate-200 py-3 text-center dark:border-slate-800">
            <Button variant="secondary" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              Carregar mais
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
