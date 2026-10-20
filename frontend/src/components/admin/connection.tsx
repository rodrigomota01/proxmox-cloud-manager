"use client";

/* Connection (Proxmox API endpoint) settings and its guests, shown inside the hypervisor
 * page: a standalone server is a connection with one node, so the admin never has to
 * think in "clusters" until a connection actually has several nodes. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ClusterStatus } from "@/components/cluster-status";
import { volumesSummary } from "@/components/disks";
import { GuestDescription } from "@/components/guest-description";
import { IpAddress } from "@/components/ip-address";
import { DescriptionList, ResourceIcon, SearchInput, Toolbar } from "@/components/page";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  ErrorBox,
  Field,
  Input,
  JobBadge,
  PowerBadge,
  Select,
  Spinner,
  Textarea,
  formatBytes,
  formatDate,
  tbl,
} from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useJob } from "@/lib/jobs";
import { useAdminZones } from "@/lib/queries";

type AdminInstance = Schemas["AdminInstanceOut"];

function CredentialsCard({ cluster }: { cluster: Schemas["ClusterOut"] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: async (body: { token_id: string; secret: string }) =>
      unwrap(
        await api.PUT("/api/v1/admin/clusters/{cluster_id}/credentials", {
          params: { path: { cluster_id: cluster.id } },
          body,
        }),
      ),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    save.mutate({ token_id: String(form.get("token_id")), secret: String(form.get("secret")) });
    e.currentTarget.reset(); // the secret does not stay in the page
  }

  return (
    <Card
      title={t("infra.connection.credentialTitle")}
      description={
        cluster.has_credentials
          ? t("infra.connection.credentialDesc", {
              token: cluster.token_id ?? "",
              date: formatDate(cluster.credentials_rotated_at),
            })
          : t("infra.connection.noCredential")
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Token ID" hint={t("infra.connection.tokenIdHint")}>
          <Input name="token_id" required defaultValue={cluster.token_id ?? "cloudmgr@pve!cm"} />
        </Field>
        <Field label="Secret">
          <Input name="secret" type="password" autoComplete="off" required />
        </Field>
        <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {t("infra.connection.saveCredential")}
          </Button>
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">{t("infra.connection.savedEncrypted")}</span>}
        </div>
      </form>
    </Card>
  );
}

function BulkAdoptDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [tenantId, setTenantId] = useState("");
  const open = ids.length > 0;
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
    enabled: open,
  });
  const projects = useQuery({
    queryKey: ["admin", "projects", tenantId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects", { params: { query: { limit: 200 } }, headers: { "X-Tenant-Id": tenantId } }))
        .items,
    enabled: tenantId !== "",
  });
  const adopt = useMutation({
    mutationFn: async (projectId: string) =>
      unwrap(
        await api.POST("/api/v1/admin/instances/adopt", {
          body: { instance_ids: ids, tenant_id: tenantId, project_id: projectId },
        }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "instances"] });
      onDone();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("infra.connection.bulkAdoptTitle", { count: ids.length })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          adopt.mutate(String(new FormData(e.currentTarget).get("project_id")));
        }}
        className="space-y-4"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {t("infra.connection.bulkAdoptBody")}
        </p>
        <Field label={t("infra.connection.clientTenant")}>
          <Select className="w-full" required value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="" disabled>
              {t("infra.common.selectPlaceholder")}
            </option>
            {tenants.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("infra.common.project")}>
          <Select className="w-full" name="project_id" required disabled={!projects.data} defaultValue="" key={tenantId}>
            <option value="" disabled>
              {tenantId
                ? projects.data?.length
                  ? t("infra.common.selectPlaceholder")
                  : t("infra.connection.clientHasNoProjects")
                : t("infra.connection.chooseClientFirst")}
            </option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorBox message={adopt.isError ? errorMessage(adopt.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("infra.common.cancel")}
          </Button>
          <Button type="submit" disabled={adopt.isPending || !tenantId}>
            {t("infra.connection.adopt")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AdoptDialog({ instance, onClose }: { instance: AdminInstance | null; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [tenantId, setTenantId] = useState("");
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
    enabled: instance !== null,
  });
  const projects = useQuery({
    queryKey: ["admin", "projects", tenantId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects", {
          params: { query: { limit: 200 } },
          headers: { "X-Tenant-Id": tenantId },
        }),
      ).items,
    enabled: tenantId !== "",
  });
  const adopt = useMutation({
    mutationFn: async (body: { tenant_id: string; project_id: string; name?: string }) =>
      unwrap(
        await api.POST("/api/v1/admin/instances/{instance_id}/adopt", {
          params: { path: { instance_id: instance!.id } },
          body,
        }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "instances"] });
      onClose();
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    adopt.mutate({
      tenant_id: tenantId,
      project_id: String(form.get("project_id")),
      ...(name ? { name } : {}),
    });
  }

  return (
    <Dialog open={instance !== null} onClose={onClose} title={t("infra.connection.adoptTitle", { name: instance?.provider_name ?? "" })}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {t("infra.connection.adoptBody")}
        </p>
        <Field label={t("infra.common.tenant")}>
          <Select className="w-full" required value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="" disabled>
              {t("infra.common.selectPlaceholder")}
            </option>
            {tenants.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("infra.common.project")}>
          <Select className="w-full" name="project_id" required disabled={!projects.data} defaultValue="">
            <option value="" disabled>
              {tenantId ? t("infra.common.selectPlaceholder") : t("infra.connection.chooseTenantFirst")}
            </option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("infra.connection.platformName")} hint={t("infra.connection.platformNameHint")}>
          <Input name="name" maxLength={64} placeholder={instance?.provider_name} />
        </Field>
        <ErrorBox message={adopt.isError ? errorMessage(adopt.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("infra.common.cancel")}
          </Button>
          <Button type="submit" disabled={adopt.isPending || !tenantId}>
            {t("infra.connection.adopt")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Test / sync actions, settings, credential and sync history of one connection. */
export function ConnectionSettings({ cluster: c, nodeCount }: { cluster: Schemas["ClusterOut"]; nodeCount: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [syncJob, setSyncJob] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ["admin", "sync-runs", c.id],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/admin/clusters/{cluster_id}/sync-runs", {
          params: { path: { cluster_id: c.id }, query: { limit: 5 } },
        }),
      ),
    refetchInterval: 15_000,
  });
  const test = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/v1/admin/clusters/{cluster_id}/test", { params: { path: { cluster_id: c.id } } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin"] }),
  });
  const sync = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/v1/admin/clusters/{cluster_id}/sync", { params: { path: { cluster_id: c.id } } })),
    onSuccess: (res) => setSyncJob(res.job.id),
  });
  const { job, done } = useJob(syncJob, { admin: true, invalidate: [["admin"]] });
  const syncing = sync.isPending || (syncJob !== null && !done);

  return (
    <div className="space-y-4">
      {nodeCount > 1 && (
        <Alert variant="info">
          {t("infra.connection.clusterMemberBefore")}
          <strong>{c.name}</strong>
          {t("infra.connection.clusterMemberAfter", { count: nodeCount })}
        </Alert>
      )}
      {(!c.settings.pool || !c.zone_id) && (
        <Alert variant="warning" title={t("infra.connection.noNewVmsTitle")}>
          {!c.zone_id && !c.settings.pool
            ? t("infra.connection.missingZoneAndPool")
            : !c.zone_id
              ? t("infra.connection.missingZone")
              : t("infra.connection.missingPool")}{" "}
          {t("infra.connection.noNewVmsBody")}
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-5 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">{t("infra.connection.connection")}</span>
          <ClusterStatus status={c.status} />
          {c.version && <span className="text-sm text-slate-500">Proxmox {c.version}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={!c.has_credentials || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Spinner /> : null} {t("infra.connection.testConnection")}
          </Button>
          <Button disabled={!c.has_credentials || syncing} onClick={() => sync.mutate()}>
            {syncing ? <Spinner /> : null} {t("infra.connection.sync")}
          </Button>
        </div>
      </div>

      {test.data &&
        (test.data.ok ? (
          <Alert variant="success" title={t("infra.connection.connected")}>
            {t("infra.connection.testResult", {
              version: test.data.version ?? "",
              online: test.data.nodes_online ?? 0,
              total: test.data.nodes_total ?? 0,
              guests: test.data.guests_visible ?? 0,
            })}
          </Alert>
        ) : (
          <ErrorBox message={t("infra.connection.connectionFailed", { error: test.data.error ?? "" })} />
        ))}
      <ErrorBox message={test.isError ? errorMessage(test.error) : null} />
      <ErrorBox message={sync.isError ? errorMessage(sync.error) : null} />
      {job?.status === "failed" && <ErrorBox message={t("infra.connection.syncFailed", { error: job.error_message ?? "" })} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("infra.connection.configuration")}>
          <DescriptionList
            columns={1}
            items={[
              [t("infra.common.name"), <NameEditor key="n" clusterId={c.id} name={c.name} />],
              [t("infra.connection.apiUrl"), <span key="u" className="font-mono text-xs">{c.api_url}</span>],
              ["TLS", c.insecure_skip_verify
                  ? t("infra.connection.tlsInsecure")
                  : c.has_custom_ca
                    ? t("infra.connection.tlsCustomCa")
                    : t("infra.connection.tlsSystem"),
              ],
              [t("infra.common.zone"), <ZoneEditor key="z" clusterId={c.id} zoneId={c.zone_id ?? ""} />],
              [t("infra.connection.targetPool"), <PoolEditor key="p" clusterId={c.id} pool={(c.settings.pool as string | undefined) ?? ""} />],
              [t("infra.connection.lastSync"), formatDate(c.last_synced_at)],
              !!c.last_error && [t("infra.connection.lastError"), <span key="e" className="text-rose-600 dark:text-rose-400">{c.last_error}</span>],
            ]}
          />
        </Card>
        <CredentialsCard cluster={c} />
      </div>

      <Card title={t("infra.connection.recentSyncs")} flush>
        {runs.data?.length === 0 ? (
          <Empty icon="history">{t("infra.connection.noSyncs")}</Empty>
        ) : (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>{t("infra.connection.started")}</th>
                  <th className={tbl.th}>{t("infra.connection.trigger")}</th>
                  <th className={tbl.th}>{t("infra.connection.result")}</th>
                  <th className={tbl.th}>{t("infra.common.status")}</th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {runs.data?.map((r) => (
                  <tr key={r.id} className={tbl.tr}>
                    <td className={`${tbl.td} tabular-nums`}>{formatDate(r.started_at)}</td>
                    <td className={tbl.td}>{r.trigger === "manual" ? t("infra.connection.triggerManual") : t("infra.connection.triggerAuto")}</td>
                    <td className={`${tbl.td} text-xs`}>
                      {r.status === "succeeded" && (
                        <span className="text-slate-500">
                          {t("infra.connection.syncStats", {
                            guests: String(r.stats.instances_seen ?? 0),
                            discovered: String(r.stats.discovered ?? 0),
                          })}
                        </span>
                      )}
                      {r.error && <span className="text-rose-600 dark:text-rose-400">{r.error}</span>}
                    </td>
                    <td className={tbl.td}>
                      <JobBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Guests of a connection (optionally only those on one node): discovered ones to adopt
 * and the ones already managed. */
export function ConnectionInstances({ clusterId, nodeName }: { clusterId: string; nodeName?: string }) {
  const t = useT();
  const [adopting, setAdopting] = useState<AdminInstance | null>(null);
  const [tagFilter, setTagFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAdopting, setBulkAdopting] = useState(false);
  const instances = useQuery({
    queryKey: ["admin", "instances", clusterId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/instances", { params: { query: { cluster_id: clusterId } } })),
    refetchInterval: 15_000,
  });

  // the description is how VMs are told apart on servers whose Proxmox has no tags
  const needle = search.trim().toLowerCase();
  const matches = (i: AdminInstance) =>
    !needle ||
    i.name.toLowerCase().includes(needle) ||
    i.provider_name.toLowerCase().includes(needle) ||
    String(i.vmid).includes(needle) ||
    (i.ipv4?.includes(needle) ?? false) ||
    (i.description?.toLowerCase().includes(needle) ?? false);
  const all = (instances.data ?? []).filter((i) => (!nodeName || i.node === nodeName) && matches(i));
  const discovered = all.filter((i) => !i.managed);
  const tagCounts = Object.entries(
    discovered.flatMap((i) => i.tags).reduce<Record<string, number>>((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {}),
  ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = tagFilter ? discovered.filter((i) => i.tags.includes(tagFilter)) : discovered;
  const managed = all.filter((i) => i.managed);

  return (
    <div className="space-y-4">
      <ErrorBox message={instances.isError ? errorMessage(instances.error) : null} />
      <Card
        flush
        title={t("infra.connection.discovered", { count: discovered.length })}
        description={t("infra.connection.discoveredDesc")}
        actions={
          selected.size > 0 && (
            <Button onClick={() => setBulkAdopting(true)}>{t("infra.connection.adoptSelected", { count: selected.size })}</Button>
          )
        }
      >
        <Toolbar count={t("infra.common.countOf", { shown: shown.length, total: discovered.length })}>
          <SearchInput value={search} onChange={setSearch} placeholder={t("infra.connection.searchPlaceholder")} />
          {tagCounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">{t("infra.connection.filterByTag")}</span>
              {tagCounts.map(([tag, n]) => (
                <button
                  key={tag}
                  onClick={() => setTagFilter(tagFilter === tag ? "" : tag)}
                  className={`rounded-full border px-2 py-0.5 ${
                    tagFilter === tag
                      ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {tag} ({n})
                </button>
              ))}
              {tagFilter && (
                <button className="text-brand-600 hover:underline dark:text-brand-400" onClick={() => setTagFilter("")}>
                  {t("infra.connection.clear")}
                </button>
              )}
            </div>
          )}
        </Toolbar>
        {shown.length === 0 ? (
          <Empty icon="checkCircle">{t("infra.connection.nothingToAdopt")}</Empty>
        ) : (
          <InstanceTable
            rows={shown}
            selected={selected}
            onToggle={(ids, on) =>
              setSelected((cur) => {
                const next = new Set(cur);
                ids.forEach((x) => (on ? next.add(x) : next.delete(x)));
                return next;
              })
            }
            action={(i) => (
              <Button variant="secondary" onClick={() => setAdopting(i)}>
                {t("infra.connection.adopt")}
              </Button>
            )}
          />
        )}
      </Card>

      <Card flush title={t("infra.connection.managed", { count: managed.length })}>
        {managed.length === 0 ? <Empty icon="monitor">{t("infra.connection.noManaged")}</Empty> : <InstanceTable rows={managed} />}
      </Card>

      <AdoptDialog instance={adopting} onClose={() => setAdopting(null)} />
      <BulkAdoptDialog
        ids={bulkAdopting ? [...selected] : []}
        onClose={() => setBulkAdopting(false)}
        onDone={() => {
          setBulkAdopting(false);
          setSelected(new Set());
        }}
      />
    </div>
  );
}

/** The connection name is an admin label (tenants never see it); safe to change. */
function NameEditor({ clusterId, name }: { clusterId: string; name: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.PATCH("/api/v1/admin/clusters/{cluster_id}", {
          params: { path: { cluster_id: clusterId } },
          body: { name: value.trim() },
        }),
      ),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });
  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span className="font-medium">{name}</span>
        <Button variant="ghost" onClick={() => setEditing(true)}>
          {t("infra.connection.rename")}
        </Button>
      </span>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Input aria-label={t("infra.common.name")} className="w-48" value={value} maxLength={64} required autoFocus onChange={(e) => setValue(e.target.value)} />
      <Button type="submit" disabled={save.isPending || !value.trim() || value.trim() === name}>
        {t("infra.common.save")}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
        {t("infra.common.cancel")}
      </Button>
      {save.isError && <span className="text-xs text-rose-600">{errorMessage(save.error)}</span>}
    </form>
  );
}

function ZoneEditor({ clusterId, zoneId }: { clusterId: string; zoneId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const zones = useAdminZones();
  const [value, setValue] = useState(zoneId);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.PATCH("/api/v1/admin/clusters/{cluster_id}", {
          params: { path: { cluster_id: clusterId } },
          body: { zone_id: value || null },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }),
  });
  return (
    <span className="flex items-center gap-2">
      <Select aria-label={t("infra.common.zone")} value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">{t("infra.common.noZoneOption")}</option>
        {zones.map((z) => (
          <option key={z.id} value={z.id}>
            {z.label}
          </option>
        ))}
      </Select>
      <Button variant="secondary" disabled={save.isPending || value === zoneId} onClick={() => save.mutate()}>
        {t("infra.common.save")}
      </Button>
      {save.isError && <span className="text-xs text-rose-600">{errorMessage(save.error)}</span>}
    </span>
  );
}

function PoolEditor({ clusterId, pool }: { clusterId: string; pool: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(pool);
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.PATCH("/api/v1/admin/clusters/{cluster_id}", {
          params: { path: { cluster_id: clusterId } },
          body: { pool: value.trim() || null },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }),
  });
  return (
    <span className="flex items-center gap-2">
      <Input
        aria-label={t("infra.connection.targetPool")}
        className="w-32"
        value={value}
        placeholder={t("infra.connection.none")}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button variant="secondary" disabled={save.isPending || value === pool} onClick={() => save.mutate()}>
        {t("infra.common.save")}
      </Button>
      {save.isError && <span className="text-xs text-rose-600">{errorMessage(save.error)}</span>}
    </span>
  );
}

function InstanceTable({
  rows,
  action,
  selected,
  onToggle,
}: {
  rows: AdminInstance[];
  action?: (i: AdminInstance) => React.ReactNode;
  selected?: Set<string>;
  onToggle?: (ids: string[], on: boolean) => void;
}) {
  const t = useT();
  const selectable = selected !== undefined && onToggle !== undefined;
  const allOn = selectable && rows.length > 0 && rows.every((r) => selected.has(r.id));
  return (
    <div className={tbl.wrap}>
      <table className={tbl.table}>
        <thead className={tbl.thead}>
          <tr>
            {selectable && (
              <th className={`${tbl.th} w-8`}>
                <input
                  type="checkbox"
                  aria-label={t("infra.connection.selectAll")}
                  checked={allOn}
                  onChange={(e) => onToggle(rows.map((r) => r.id), e.target.checked)}
                />
              </th>
            )}
            <th className={tbl.th}>VMID</th>
            <th className={tbl.th}>{t("infra.common.name")}</th>
            <th className={tbl.th}>{t("infra.connection.tags")}</th>
            <th className={tbl.th}>IP</th>
            <th className={tbl.th}>Pool</th>
            <th className={tbl.th}>{t("infra.connection.state")}</th>
            <th className={tbl.th}>{t("infra.connection.resources")}</th>
            {action && <th className={tbl.th} />}
          </tr>
        </thead>
        <tbody className={tbl.tbody}>
          {rows.map((i) => (
            <tr key={i.id} className={tbl.tr}>
              {selectable && (
                <td className={`${tbl.td} w-8`}>
                  <input
                    type="checkbox"
                    aria-label={t("infra.connection.selectOne", { name: i.provider_name })}
                    checked={selected.has(i.id)}
                    onChange={(e) => onToggle([i.id], e.target.checked)}
                  />
                </td>
              )}
              <td className={`${tbl.td} tabular-nums`}>{i.vmid}</td>
              <td className={tbl.td}>
                <span className="inline-flex items-center gap-2 font-medium">
                  <ResourceIcon kind={i.kind === "vm" ? "vm" : "container"} />
                  {i.name}
                </span>
                {i.name !== i.provider_name && <span className="ml-1 text-xs text-slate-500">({i.provider_name})</span>}
                <div className="text-xs text-slate-500">
                  {i.kind === "vm" ? "VM" : t("infra.connection.container")} · {i.node}
                </div>
                <GuestDescription text={i.description} title={t("infra.connection.descriptionHint")} />
              </td>
              <td className={tbl.td}>
                <span className="flex flex-wrap gap-1">
                  {i.tags.length ? i.tags.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-slate-400">—</span>}
                </span>
              </td>
              <td className={`${tbl.td} text-xs`}>
                <IpAddress ip={i.ipv4} source={i.ipv4_source} />
              </td>
              <td className={tbl.td}>
                {i.pool ?? <span className="text-slate-400">—</span>}
                {i.read_only && (
                  <div>
                    <Badge tone="gray">{t("infra.connection.readOnly")}</Badge>
                  </div>
                )}
              </td>
              <td className={tbl.td}>
                <PowerBadge state={i.power_state} />
              </td>
              <td className={`${tbl.td} whitespace-nowrap tabular-nums text-slate-600 dark:text-slate-400`}>
                {i.vcpus} vCPU · {(i.memory_mb / 1024).toFixed(1)} GiB ·{" "}
                <span title={i.volumes
                    .map((v) => t("infra.connection.volumeOn", { name: v.name, size: formatBytes(v.size_bytes), storage: v.storage }))
                    .join("\n")}>
                  {volumesSummary(i.volumes, i.root_disk_gb)}
                </span>
              </td>
              {action && <td className={`${tbl.td} text-right`}>{action(i)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One form for the whole "add a server" flow: create the connection, store the token
 * (encrypted) and queue the first sync. If a later step fails, a retry reuses the
 * connection already created instead of making a duplicate. */
export function AddHypervisorDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (clusterId: string) => void;
}) {
  const t = useT();
  const zones = useAdminZones();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async ({ cluster, token_id, secret }: { cluster: Schemas["ClusterCreate"]; token_id: string; secret: string }) => {
      let id = created;
      if (!id) {
        id = (await unwrap(await api.POST("/api/v1/admin/clusters", { body: cluster }))).id;
        setCreated(id);
      }
      const path = { cluster_id: id };
      unwrap(await api.PUT("/api/v1/admin/clusters/{cluster_id}/credentials", { params: { path }, body: { token_id, secret } }));
      unwrap(await api.POST("/api/v1/admin/clusters/{cluster_id}/sync", { params: { path } }));
      return id;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin"] }),
    onSuccess: (id) => {
      setCreated(null);
      onCreated(id);
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const ca = String(form.get("ca_pem") ?? "").trim();
    const pool = String(form.get("pool") ?? "").trim();
    const zone = String(form.get("zone_id") ?? "");
    add.mutate({
      cluster: {
        name: String(form.get("name")),
        api_url: String(form.get("api_url")),
        ...(ca ? { ca_pem: ca } : {}),
        ...(pool ? { pool } : {}),
        ...(zone ? { zone_id: zone } : {}),
      },
      token_id: String(form.get("token_id")),
      secret: String(form.get("secret")),
    });
  }

  const close = () => {
    add.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={t("infra.nodes.addHypervisor")}>
      <form onSubmit={submit} className="space-y-4">
        <Alert variant="info">
          {t("infra.connection.addSetupBefore")}
          <code>deploy/proxmox/setup-node.sh</code>
          {t("infra.connection.addSetupAfter")}
        </Alert>
        <Field label={t("infra.common.name")} hint={t("infra.connection.nameHint")}>
          <Input name="name" required maxLength={64} placeholder="hv08" disabled={created !== null} />
        </Field>
        <Field label={t("infra.connection.apiUrl")} hint={t("infra.connection.apiUrlHint")}>
          <Input name="api_url" type="url" required placeholder="https://host:8006" disabled={created !== null} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Token ID" hint={t("infra.connection.tokenIdHint")}>
            <Input name="token_id" required defaultValue="cloudmgr@pve!cm" />
          </Field>
          <Field label="Secret" hint={t("infra.connection.secretHint")}>
            <Input name="secret" type="password" autoComplete="off" required />
          </Field>
        </div>
        <Field label={t("infra.common.zone")} hint={t("infra.connection.zoneHint")}>
          <Select name="zone_id" className="w-full" defaultValue="" disabled={created !== null}>
            <option value="">{t("infra.common.noZoneOption")}</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("infra.connection.targetPool")} hint={t("infra.connection.poolHint")}>
          <Input name="pool" maxLength={64} pattern="[A-Za-z0-9._\-]+" placeholder="cloud-manager" disabled={created !== null} />
        </Field>
        <Field
          label={t("infra.connection.customCa")}
          hint={t("infra.connection.customCaHint")}
        >
          <Textarea name="ca_pem" rows={3} placeholder="-----BEGIN CERTIFICATE-----" disabled={created !== null} />
        </Field>
        {created && !add.isPending && (
          <Alert variant="warning">{t("infra.connection.alreadyCreated")}</Alert>
        )}
        <ErrorBox message={add.isError ? errorMessage(add.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            {t("infra.common.cancel")}
          </Button>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? <Spinner /> : null} {t("infra.common.add")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
