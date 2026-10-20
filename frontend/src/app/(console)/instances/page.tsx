"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { GuestDescription } from "@/components/guest-description";
import { volumesSummary } from "@/components/disks";
import { IpAddress } from "@/components/ip-address";
import { NoTenant } from "@/components/no-tenant";
import { PageHeader, ResourceIcon, SearchInput, Toolbar } from "@/components/page";
import { PowerActions } from "@/components/power-actions";
import { Badge, Button, Card, Empty, ErrorBox, PowerBadge, Select, StateBadge, tbl } from "@/components/ui";
import { Meter, SortHeader, mib, uptime, useSorted } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useProjectNames, useProjects } from "@/lib/queries";
import { useSession } from "@/lib/session";

type Kind = "vm" | "container";
type Power = "running" | "stopped" | "paused" | "unknown";
type Instance = Schemas["InstanceOut"];
type SortKey = "name" | "cpu" | "memory" | "uptime";

const memRatio = (i: Instance) => (i.memory_mb ? i.memory_used_mb / i.memory_mb : 0);

export default function InstancesPage() {
  const t = useT();
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
    ? loaded.filter(
        (i) =>
          i.name.toLowerCase().includes(needle) ||
          i.ipv4?.includes(needle) ||
          i.description?.toLowerCase().includes(needle),
      )
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
        <Icon name="plus" /> {t("compute.instances.create")}
      </Button>
    </Link>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("compute.instances.title")}
        description={t("compute.instances.description")}
        actions={create}
      />

      <ErrorBox message={list.isError ? errorMessage(list.error) : null} />
      <Card flush>
        <Toolbar count={list.isSuccess ? t(items.length === 1 ? "compute.instances.itemOne" : "compute.instances.itemOther", { count: items.length }) : undefined}>
          <SearchInput value={search} onChange={setSearch} placeholder={t("compute.instances.searchPlaceholder")} />
          <Select aria-label={t("compute.instances.project")} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t("compute.instances.allProjects")}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select aria-label={t("compute.instances.kind")} value={kind} onChange={(e) => setKind(e.target.value as Kind | "")}>
            <option value="">{t("compute.instances.allKinds")}</option>
            <option value="vm">{t("compute.instances.vms")}</option>
            <option value="container">{t("compute.instances.containers")}</option>
          </Select>
          <Select aria-label={t("compute.instances.state")} value={power} onChange={(e) => setPower(e.target.value as Power | "")}>
            <option value="">{t("compute.instances.anyState")}</option>
            <option value="running">{t("compute.instances.running")}</option>
            <option value="stopped">{t("compute.instances.stopped")}</option>
            <option value="paused">{t("compute.instances.paused")}</option>
            <option value="unknown">{t("compute.instances.unknown")}</option>
          </Select>
        </Toolbar>
        {list.isSuccess && items.length === 0 &&
          (filtered ? (
            <Empty title={t("compute.instances.noMatchTitle")}>{t("compute.instances.noMatch")}</Empty>
          ) : (
            <Empty title={t("compute.instances.emptyTitle")} icon="monitor" action={create}>
              {t("compute.instances.empty")}
            </Empty>
          ))}
        {items.length > 0 && (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <SortHeader label={t("compute.instances.colName")} k="name" sort={sort} toggle={toggle} />
                  <th className={tbl.th}>{t("compute.instances.colStatus")}</th>
                  <th className={tbl.th}>{t("compute.instances.colZone")}</th>
                  <SortHeader label={t("compute.instances.colCpu")} k="cpu" sort={sort} toggle={toggle} />
                  <SortHeader label={t("compute.instances.colMemory")} k="memory" sort={sort} toggle={toggle} />
                  <th className={`${tbl.th} text-right`}>{t("compute.instances.colDisk")}</th>
                  <th className={tbl.th}>{t("compute.instances.colIp")}</th>
                  <SortHeader label={t("compute.instances.colUptime")} k="uptime" sort={sort} toggle={toggle} align="right" />
                  <th className={tbl.th}>
                    <span className="sr-only">{t("common.actions")}</span>
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
                          {i.k8s_cluster_id && (
                            <Link href={`/kubernetes/${i.k8s_cluster_id}`} title={t("compute.instances.k8sNodeHint")}>
                              <Badge tone="brand">{t("compute.instances.k8sNode")}</Badge>
                            </Link>
                          )}
                        </div>
                        <div className="mt-0.5 pl-7 text-xs text-slate-500">
                          {projectNames.get(i.project_id) ?? "—"} · {i.vcpus} vCPU
                        </div>
                        <GuestDescription text={i.description} className="pl-7" />
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
                          <Meter value={i.cpu_usage} title={t("compute.instances.cpuOf", { name: i.name })} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className={tbl.td}>
                        {running ? (
                          <Meter
                            value={memRatio(i)}
                            label={`${mib(i.memory_used_mb)} / ${mib(i.memory_mb)}`}
                            title={t("compute.instances.memoryOf", { name: i.name })}
                          />
                        ) : (
                          <span className="text-slate-400">{mib(i.memory_mb)}</span>
                        )}
                      </td>
                      <td className={`${tbl.td} text-right tabular-nums`}>{volumesSummary(i.volumes, i.root_disk_gb)}</td>
                      <td className={`${tbl.td} text-xs`}>
                        <IpAddress ip={i.ipv4} source={i.ipv4_source} />
                      </td>
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
              {t("compute.instances.loadMore")}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
