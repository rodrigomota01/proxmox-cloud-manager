"use client";

/* The IP registry editor: rows of the legacy awf_ip_pool, grouped by hypervisor. Every
 * change is a job the worker writes to MySQL; the table refreshes when the job ends. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { relativeTime } from "@/components/activity";
import { IpamSync } from "@/components/admin/ipam-panel";
import { Icon } from "@/components/icons";
import { PageHeader, SearchInput, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Spinner, Status, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useJob } from "@/lib/jobs";

type Row = Schemas["RegistryAddressOut"];
type AddressIn = Schemas["AddressIn"];

const REGISTRY = ["admin", "ipam-registry"] as const;
const AFTER_WRITE = [REGISTRY, ["admin", "ipam"], ["admin", "ipam-report"]] as const;
const NONE = "\u0000"; // the group of rows with no hypervisor

/** One hypervisor as the registry names it (the `hypervisor` column), with the server
 * registered here that its node belongs to, when there is one. */
type Group = {
  key: string;
  hypervisor: string | null;
  nodes: string[];
  clusterIds: string[];
  count: number;
  free: number;
};

function groupRows(rows: Row[]): Group[] {
  const by = new Map<string, Group>();
  for (const r of rows) {
    const key = r.hypervisor ?? NONE;
    const g = by.get(key) ?? { key, hypervisor: r.hypervisor, nodes: [], clusterIds: [], count: 0, free: 0 };
    g.count += 1;
    if (!r.assigned && !r.load_balancer) g.free += 1;
    if (r.node_name && !g.nodes.includes(r.node_name)) g.nodes.push(r.node_name);
    if (r.cluster_id && !g.clusterIds.includes(r.cluster_id)) g.clusterIds.push(r.cluster_id);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => (a.hypervisor ?? "￿").localeCompare(b.hypervisor ?? "￿"));
}

/** Follows the job of one change; the parent shows the outcome. */
function useWrite() {
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, done } = useJob(jobId, { admin: true, invalidate: AFTER_WRITE });
  const running = jobId !== null && !done;
  return { jobId, setJobId, job, done, running };
}

function toForm(row: Row | null, group: Group | null): AddressIn {
  if (row) {
    return {
      address: row.prefix != null ? `${row.address}/${row.prefix}` : row.address,
      hypervisor: row.hypervisor,
      node_name: row.node_name,
      assigned: row.assigned,
      mac: row.mac,
      hostname: row.hostname,
      host_owner: row.host_owner,
      ip_block: row.ip_block,
      load_balancer: row.load_balancer,
    };
  }
  return {
    address: "",
    hypervisor: group?.hypervisor ?? null,
    node_name: group?.nodes.length === 1 ? group.nodes[0] : null,
    assigned: false,
    mac: null,
    hostname: null,
    host_owner: null,
    ip_block: null,
    load_balancer: false,
  };
}

function AddressDialog({
  row,
  group,
  open,
  nodeNames,
  hypervisors,
  onClose,
  onQueued,
}: {
  row: Row | null; // null: a new address
  group: Group | null;
  open: boolean;
  nodeNames: string[];
  hypervisors: string[];
  onClose: () => void;
  onQueued: (jobId: string) => void;
}) {
  const t = useT();
  const [form, setForm] = useState<AddressIn>(() => toForm(row, group));
  useEffect(() => {
    if (open) setForm(toForm(row, group));
  }, [open, row, group]);
  const save = useMutation({
    mutationFn: async (body: AddressIn) =>
      row
        ? unwrap(await api.PATCH("/api/v1/admin/ipam/addresses/{address_id}", { params: { path: { address_id: row.id } }, body }))
        : unwrap(await api.POST("/api/v1/admin/ipam/addresses", { body })),
    onSuccess: (r) => {
      onQueued(r.job.id);
      onClose();
    },
  });
  const set = (patch: Partial<AddressIn>) => setForm((f) => ({ ...f, ...patch }));
  const text = (key: keyof AddressIn) => ({
    value: (form[key] as string | null) ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ [key]: e.target.value || null } as Partial<AddressIn>),
  });
  const held = row?.held_by ?? null;
  return (
    <Dialog open={open} onClose={onClose} title={row ? t("infra.registry.editAddress", { address: row.address }) : t("infra.registry.newAddress")}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ ...form, address: form.address.trim() });
        }}
      >
        <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
        {held && (
          <Alert variant="warning">
            {t("infra.registry.heldBy", { name: held.name })}: {t("infra.registry.heldByHint")}
          </Alert>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("infra.registry.address")} hint={t("infra.registry.addressHint")}>
            <Input
              required
              autoFocus={!row}
              placeholder="177.54.151.42"
              className="font-mono"
              value={form.address}
              disabled={!!held}
              onChange={(e) => set({ address: e.target.value })}
            />
          </Field>
          <Field label={t("infra.registry.hostname")}>
            <Input {...text("hostname")} disabled={!!held} placeholder="web-1" />
          </Field>
          <Field label={t("infra.registry.hypervisor")}>
            <Input {...text("hypervisor")} list="registry-hypervisors" placeholder="hv08.sp02.atena.io" />
            <datalist id="registry-hypervisors">
              {hypervisors.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </Field>
          <Field label={t("infra.registry.node")} hint={t("infra.registry.nodeHint")}>
            <Input {...text("node_name")} list="registry-nodes" placeholder="pve1" />
            <datalist id="registry-nodes">
              {nodeNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
          <Field label={t("infra.registry.mac")} hint={t("infra.registry.macHint")}>
            <Input {...text("mac")} className="font-mono" placeholder="bc:24:11:00:00:01" />
          </Field>
          <Field label={t("infra.registry.owner")}>
            <Input {...text("host_owner")} />
          </Field>
          <Field label={t("infra.registry.block")}>
            <Input {...text("ip_block")} className="font-mono" placeholder="177.54.151.0/24" />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={form.assigned ?? false}
              disabled={!!held}
              onChange={(e) => set({ assigned: e.target.checked })}
            />
            {t("infra.registry.assigned")}
            <span className="text-xs text-slate-500">· {t("infra.registry.assignedHint")}</span>
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={form.load_balancer ?? false}
              onChange={(e) => set({ load_balancer: e.target.checked })}
            />
            {t("infra.registry.loadBalancer")}
            <span className="text-xs text-slate-500">· {t("infra.registry.loadBalancerHint")}</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("infra.common.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending || !form.address.trim()}>
            {save.isPending && <Spinner />} {row ? t("infra.common.save") : t("infra.common.add")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ row, onClose, onQueued }: { row: Row | null; onClose: () => void; onQueued: (jobId: string) => void }) {
  const t = useT();
  const remove = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE("/api/v1/admin/ipam/addresses/{address_id}", { params: { path: { address_id: id } } })),
    onSuccess: (r) => {
      onQueued(r.job.id);
      onClose();
    },
  });
  return (
    <Dialog open={row !== null} onClose={onClose} title={row ? t("infra.registry.deleteAddress", { address: row.address }) : ""}>
      {row && (
        <div className="space-y-3 text-sm">
          <Alert variant="warning">{t("infra.registry.deleteBody")}</Alert>
          {row.hostname && (
            <p>
              {t("infra.registry.hostname")}: <span className="font-mono">{row.hostname}</span>
            </p>
          )}
          <ErrorBox message={remove.isError ? errorMessage(remove.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("infra.common.cancel")}
            </Button>
            <Button type="button" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(row.id)}>
              {remove.isPending && <Spinner />} {t("infra.common.remove")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function IpamRegistry() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ row: Row | null } | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const write = useWrite();

  const status = useQuery({
    queryKey: ["admin", "ipam"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/ipam")),
  });
  const rows = useQuery({
    queryKey: REGISTRY,
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/ipam/addresses")),
    refetchInterval: 60_000,
  });
  const nodes = useQuery({
    queryKey: ["admin", "nodes"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/nodes")),
    staleTime: 60_000,
  });
  const clusterNames = useMemo(() => new Map((nodes.data ?? []).map((n) => [n.cluster_id, n.cluster_name])), [nodes.data]);
  const nodeNames = useMemo(() => [...new Set((nodes.data ?? []).map((n) => n.name))].sort(), [nodes.data]);

  const groups = useMemo(() => groupRows(rows.data ?? []), [rows.data]);
  // ?cluster=<id> (from a server's IPs tab) opens on that server's hypervisor
  const wanted = params.get("hypervisor");
  const cluster = params.get("cluster");
  const selectedKey =
    (wanted !== null && groups.some((g) => g.key === wanted) && wanted) ||
    (cluster && groups.find((g) => g.clusterIds.includes(cluster))?.key) ||
    "";
  const group = groups.find((g) => g.key === selectedKey) ?? null;
  const select = (key: string) => {
    const q = new URLSearchParams();
    if (key) q.set("hypervisor", key);
    router.replace(key ? `/admin/ipam?${q}` : "/admin/ipam");
  };

  const needle = search.trim().toLowerCase();
  const shown = (rows.data ?? [])
    .filter((r) => !group || (r.hypervisor ?? NONE) === group.key)
    .filter(
      (r) =>
        !needle ||
        r.address.includes(needle) ||
        (r.hostname?.toLowerCase().includes(needle) ?? false) ||
        (r.mac?.includes(needle) ?? false) ||
        (r.host_owner?.toLowerCase().includes(needle) ?? false) ||
        (r.ip_block?.includes(needle) ?? false) ||
        (r.held_by?.name.toLowerCase().includes(needle) ?? false),
    );
  const configured = status.data?.configured ?? true;
  const syncedAt = rows.data?.reduce<string | null>((m, r) => (m === null || r.synced_at > m ? r.synced_at : m), null) ?? null;
  const groupLabel = (g: Group) => {
    const servers = g.clusterIds.map((id) => clusterNames.get(id)).filter(Boolean);
    const where = servers.length ? servers.join(", ") : g.nodes.length ? `${g.nodes.join(", ")} · ${t("infra.registry.notIntegrated")}` : "";
    return `${g.hypervisor ?? t("infra.registry.noHypervisor")}${where ? ` — ${where}` : ""} · ${t("infra.registry.groupSummary", { count: g.count, free: g.free })}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("infra.registry.title")}
        kind="cluster"
        description={t("infra.registry.description")}
        breadcrumbs={[{ label: t("nav.infrastructure") }, { label: t("infra.registry.title") }]}
        actions={
          <Button disabled={!configured} onClick={() => setEditing({ row: null })}>
            <Icon name="plus" /> {t("infra.registry.newAddress")}
          </Button>
        }
      />
      <IpamSync invalidate={[REGISTRY]} />
      {!configured && <Alert variant="warning">{t("infra.registry.notConfigured")}</Alert>}
      <ErrorBox message={rows.isError ? errorMessage(rows.error) : null} />
      {write.running && (
        <Alert variant="info">
          <span className="inline-flex items-center gap-2">
            <Spinner /> {t("infra.registry.pending")}
          </span>
        </Alert>
      )}
      {write.done && write.job?.status === "failed" && (
        <Alert variant="danger">{t("infra.registry.failed", { error: write.job.error_message ?? write.job.error_code ?? "" })}</Alert>
      )}

      <Card flush>
        <Toolbar count={syncedAt ? t("infra.registry.syncedAt", { when: relativeTime(syncedAt) }) : undefined}>
          <Select aria-label={t("infra.registry.hypervisor")} value={selectedKey} onChange={(e) => select(e.target.value)} className="max-w-full">
            <option value="">{t("infra.registry.allHypervisors")}</option>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {groupLabel(g)}
              </option>
            ))}
          </Select>
          <SearchInput value={search} onChange={setSearch} placeholder={t("infra.registry.searchPlaceholder")} />
        </Toolbar>
        {rows.isSuccess && shown.length === 0 ? (
          <Empty icon="globe">{t("infra.registry.noAddresses")}</Empty>
        ) : (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>{t("infra.registry.address")}</th>
                  <th className={tbl.th}>{t("infra.common.situation")}</th>
                  <th className={tbl.th}>{t("infra.registry.colRegistry")}</th>
                  <th className={tbl.th}>{t("infra.registry.colHypervisor")}</th>
                  <th className={tbl.th}>{t("infra.registry.colOwner")}</th>
                  <th className={tbl.th}>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {shown.map((r) => (
                  <tr key={r.id} className={tbl.tr}>
                    <td className={`${tbl.td} font-mono text-xs`}>
                      {r.address}
                      {r.prefix != null && <span className="text-slate-500">/{r.prefix}</span>}
                      <div className="text-slate-400">#{r.external_id}</div>
                    </td>
                    <td className={tbl.td}>
                      {r.load_balancer ? (
                        <Status tone="info" title={t("infra.registry.inUseLbHint")}>
                          {t("infra.registry.inUse")} · {t("infra.registry.inUseLb")}
                        </Status>
                      ) : r.assigned ? (
                        <Status tone="info">{t("infra.registry.inUse")}</Status>
                      ) : (
                        <Status tone="ok">{t("infra.registry.free")}</Status>
                      )}
                      {r.held_by && (
                        <div className="mt-1" title={t("infra.registry.heldByHint")}>
                          <Badge tone="brand">{t("infra.registry.heldBy", { name: r.held_by.name })}</Badge>
                        </div>
                      )}
                    </td>
                    <td className={`${tbl.td} text-xs`}>
                      <div>{r.hostname ?? <span className="text-slate-400">—</span>}</div>
                      {r.mac && <div className="font-mono text-slate-500">{r.mac}</div>}
                    </td>
                    <td className={`${tbl.td} text-xs`}>
                      <div>{r.hypervisor ?? <span className="text-slate-400">—</span>}</div>
                      <div className="text-slate-500">
                        {r.node_name ?? "—"}
                        {r.cluster_id && clusterNames.get(r.cluster_id) && (
                          <>
                            {" · "}
                            <Link href={`/admin/clusters/${r.cluster_id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                              {clusterNames.get(r.cluster_id)}
                            </Link>
                          </>
                        )}
                      </div>
                    </td>
                    <td className={`${tbl.td} text-xs`}>
                      <div>{r.host_owner ?? <span className="text-slate-400">—</span>}</div>
                      {r.ip_block && <div className="font-mono text-slate-500">{r.ip_block}</div>}
                    </td>
                    <td className={`${tbl.td} whitespace-nowrap text-right`}>
                      <Button variant="ghost" disabled={!configured} onClick={() => setEditing({ row: r })}>
                        {t("infra.common.edit")}
                      </Button>
                      <Button variant="ghost" disabled={!configured || !!r.held_by} onClick={() => setDeleting(r)}>
                        {t("infra.common.remove")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <AddressDialog
          open
          row={editing.row}
          group={group}
          nodeNames={nodeNames}
          hypervisors={groups.map((g) => g.hypervisor).filter((h): h is string => !!h)}
          onClose={() => setEditing(null)}
          onQueued={(id) => {
            write.setJobId(id);
            queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
          }}
        />
      )}
      <DeleteDialog row={deleting} onClose={() => setDeleting(null)} onQueued={write.setJobId} />
    </div>
  );
}
