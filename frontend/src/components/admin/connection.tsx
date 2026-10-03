"use client";

/* Connection (Proxmox API endpoint) settings and its guests, shown inside the hypervisor
 * page: a standalone server is a connection with one node, so the admin never has to
 * think in "clusters" until a connection actually has several nodes. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ClusterStatus } from "@/components/cluster-status";
import {
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
  formatDate,
} from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useJob } from "@/lib/jobs";
import { useAdminZones } from "@/lib/queries";

type AdminInstance = Schemas["AdminInstanceOut"];

function CredentialsCard({ cluster }: { cluster: Schemas["ClusterOut"] }) {
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
    <Card title="Credencial (API token)">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        {cluster.has_credentials
          ? `Token ${cluster.token_id}, atualizado em ${formatDate(cluster.credentials_rotated_at)}. O secret nunca é exibido; envie um novo para trocar.`
          : "Nenhuma credencial cadastrada."}
      </p>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Token ID" hint="usuario@realm!token">
          <Input name="token_id" required defaultValue={cluster.token_id ?? "cloudmgr@pve!cm"} />
        </Field>
        <Field label="Secret">
          <Input name="secret" type="password" autoComplete="off" required />
        </Field>
        <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            Salvar credencial
          </Button>
          {saved && <span className="text-sm text-emerald-600">Salva (cifrada).</span>}
        </div>
      </form>
    </Card>
  );
}

function BulkAdoptDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
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
    <Dialog open={open} onClose={onClose} title={`Adotar ${ids.length} instância(s)`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          adopt.mutate(String(new FormData(e.currentTarget).get("project_id")));
        }}
        className="space-y-4"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Todas passam a pertencer ao projeto escolhido e ficam visíveis para os membros dele.
        </p>
        <Field label="Cliente (tenant)">
          <Select className="w-full" required value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="" disabled>
              Selecione…
            </option>
            {tenants.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Projeto">
          <Select className="w-full" name="project_id" required disabled={!projects.data} defaultValue="" key={tenantId}>
            <option value="" disabled>
              {tenantId ? (projects.data?.length ? "Selecione…" : "O cliente não tem projetos") : "Escolha o cliente primeiro"}
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
            Cancelar
          </Button>
          <Button type="submit" disabled={adopt.isPending || !tenantId}>
            Adotar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AdoptDialog({ instance, onClose }: { instance: AdminInstance | null; onClose: () => void }) {
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
    <Dialog open={instance !== null} onClose={onClose} title={`Adotar ${instance?.provider_name ?? ""}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          A instância passa a pertencer ao projeto escolhido e fica visível para os membros dele.
        </p>
        <Field label="Tenant">
          <Select className="w-full" required value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="" disabled>
              Selecione…
            </option>
            {tenants.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Projeto">
          <Select className="w-full" name="project_id" required disabled={!projects.data} defaultValue="">
            <option value="" disabled>
              {tenantId ? "Selecione…" : "Escolha o tenant primeiro"}
            </option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Nome na plataforma (opcional)" hint="Padrão: o nome no Proxmox.">
          <Input name="name" maxLength={64} placeholder={instance?.provider_name} />
        </Field>
        <ErrorBox message={adopt.isError ? errorMessage(adopt.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={adopt.isPending || !tenantId}>
            Adotar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Test / sync actions, settings, credential and sync history of one connection. */
export function ConnectionSettings({ cluster: c, nodeCount }: { cluster: Schemas["ClusterOut"]; nodeCount: number }) {
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
        <div className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
          Este servidor faz parte do cluster <strong>{c.name}</strong>: estas configurações valem para os{" "}
          {nodeCount} servidores dele.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ClusterStatus status={c.status} />
          {c.version && <span className="text-sm text-slate-500">Proxmox {c.version}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={!c.has_credentials || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Spinner /> : null} Testar conexão
          </Button>
          <Button disabled={!c.has_credentials || syncing} onClick={() => sync.mutate()}>
            {syncing ? <Spinner /> : null} Sincronizar
          </Button>
        </div>
      </div>

      {test.data &&
        (test.data.ok ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            Conectado: Proxmox {test.data.version}, {test.data.nodes_online}/{test.data.nodes_total} servidor(es)
            online, {test.data.guests_visible} guest(s) visíveis ao token.
          </div>
        ) : (
          <ErrorBox message={`Falha na conexão: ${test.data.error}`} />
        ))}
      <ErrorBox message={test.isError ? errorMessage(test.error) : null} />
      <ErrorBox message={sync.isError ? errorMessage(sync.error) : null} />
      {job?.status === "failed" && <ErrorBox message={`Sincronização falhou: ${job.error_message}`} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Configuração">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-500">Nome</dt>
              <dd>
                <NameEditor clusterId={c.id} name={c.name} />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">URL da API</dt>
              <dd>{c.api_url}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">TLS</dt>
              <dd>{c.insecure_skip_verify ? "sem verificação (dev)" : c.has_custom_ca ? "CA própria" : "CAs do sistema"}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-500">Zona</dt>
              <dd>
                <ZoneEditor clusterId={c.id} zoneId={c.zone_id ?? ""} />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-500">Pool de destino</dt>
              <dd>
                <PoolEditor clusterId={c.id} pool={(c.settings.pool as string | undefined) ?? ""} />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Último sync</dt>
              <dd>{formatDate(c.last_synced_at)}</dd>
            </div>
            {c.last_error && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Último erro</dt>
                <dd className="text-rose-600 dark:text-rose-400">{c.last_error}</dd>
              </div>
            )}
          </dl>
        </Card>
        <CredentialsCard cluster={c} />
      </div>

      <Card title="Sincronizações recentes">
        {runs.data?.length === 0 && <Empty>Nenhuma sincronização ainda.</Empty>}
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {runs.data?.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 py-2">
              <span>
                {formatDate(r.started_at)} · {r.trigger === "manual" ? "manual" : "automática"}
                {r.error && <span className="ml-2 text-rose-600 dark:text-rose-400">{r.error}</span>}
              </span>
              <span className="flex items-center gap-2">
                {r.status === "succeeded" && (
                  <span className="text-xs text-slate-500">
                    {String(r.stats.instances_seen ?? 0)} guests · {String(r.stats.discovered ?? 0)} novos
                  </span>
                )}
                <JobBadge status={r.status} />
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** Guests of a connection (optionally only those on one node): discovered ones to adopt
 * and the ones already managed. */
export function ConnectionInstances({ clusterId, nodeName }: { clusterId: string; nodeName?: string }) {
  const [adopting, setAdopting] = useState<AdminInstance | null>(null);
  const [tagFilter, setTagFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAdopting, setBulkAdopting] = useState(false);
  const instances = useQuery({
    queryKey: ["admin", "instances", clusterId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/instances", { params: { query: { cluster_id: clusterId } } })),
    refetchInterval: 15_000,
  });

  const all = (instances.data ?? []).filter((i) => !nodeName || i.node === nodeName);
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
        title={`Descobertas (${discovered.length})`}
        actions={
          selected.size > 0 && (
            <Button onClick={() => setBulkAdopting(true)}>Adotar selecionadas ({selected.size})</Button>
          )
        }
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          Guests que existem no Proxmox mas ainda não pertencem a nenhum cliente. Só administradores as veem.
          As que estão fora do pool gerenciado ficam <strong>somente leitura</strong> depois de adotadas: o
          cliente vê estado e métricas, sem ligar/desligar/excluir.
        </p>
        {tagCounts.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">Filtrar por tag:</span>
            {tagCounts.map(([tag, n]) => (
              <button
                key={tag}
                onClick={() => setTagFilter(tagFilter === tag ? "" : tag)}
                className={`rounded-full border px-2 py-0.5 ${
                  tagFilter === tag
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {tag} ({n})
              </button>
            ))}
            {tagFilter && (
              <button className="text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setTagFilter("")}>
                limpar
              </button>
            )}
          </div>
        )}
        {shown.length === 0 ? (
          <Empty>Nada a adotar.</Empty>
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
                Adotar
              </Button>
            )}
          />
        )}
      </Card>

      <Card title={`Gerenciadas (${managed.length})`}>
        {managed.length === 0 ? <Empty>Nenhuma instância adotada.</Empty> : <InstanceTable rows={managed} />}
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
          Renomear
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
      <Input aria-label="Nome" className="w-48" value={value} maxLength={64} required autoFocus onChange={(e) => setValue(e.target.value)} />
      <Button type="submit" disabled={save.isPending || !value.trim() || value.trim() === name}>
        Salvar
      </Button>
      <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
        Cancelar
      </Button>
      {save.isError && <span className="text-xs text-rose-600">{errorMessage(save.error)}</span>}
    </form>
  );
}

function ZoneEditor({ clusterId, zoneId }: { clusterId: string; zoneId: string }) {
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
      <Select aria-label="Zona" value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Sem zona</option>
        {zones.map((z) => (
          <option key={z.id} value={z.id}>
            {z.label}
          </option>
        ))}
      </Select>
      <Button variant="secondary" disabled={save.isPending || value === zoneId} onClick={() => save.mutate()}>
        Salvar
      </Button>
      {save.isError && <span className="text-xs text-rose-600">{errorMessage(save.error)}</span>}
    </span>
  );
}

function PoolEditor({ clusterId, pool }: { clusterId: string; pool: string }) {
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
        aria-label="Pool de destino"
        className="w-32"
        value={value}
        placeholder="nenhum"
        onChange={(e) => setValue(e.target.value)}
      />
      <Button variant="secondary" disabled={save.isPending || value === pool} onClick={() => save.mutate()}>
        Salvar
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
  const selectable = selected !== undefined && onToggle !== undefined;
  const allOn = selectable && rows.length > 0 && rows.every((r) => selected.has(r.id));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {selectable && (
              <th className="py-2 pr-2">
                <input
                  type="checkbox"
                  aria-label="Selecionar todas"
                  checked={allOn}
                  onChange={(e) => onToggle(rows.map((r) => r.id), e.target.checked)}
                />
              </th>
            )}
            <th className="py-2 pr-4 font-medium">VMID</th>
            <th className="py-2 pr-4 font-medium">Nome</th>
            <th className="py-2 pr-4 font-medium">Tags</th>
            <th className="py-2 pr-4 font-medium">Pool</th>
            <th className="py-2 pr-4 font-medium">Estado</th>
            <th className="py-2 pr-4 font-medium">Recursos</th>
            {action && <th className="py-2 font-medium" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((i) => (
            <tr key={i.id}>
              {selectable && (
                <td className="py-2 pr-2">
                  <input
                    type="checkbox"
                    aria-label={`Selecionar ${i.provider_name}`}
                    checked={selected.has(i.id)}
                    onChange={(e) => onToggle([i.id], e.target.checked)}
                  />
                </td>
              )}
              <td className="py-2 pr-4 tabular-nums">{i.vmid}</td>
              <td className="py-2 pr-4">
                {i.name}
                {i.name !== i.provider_name && <span className="ml-1 text-xs text-slate-500">({i.provider_name})</span>}
                <div className="text-xs text-slate-500">
                  {i.kind === "vm" ? "VM" : "Container"} · {i.node}
                </div>
              </td>
              <td className="py-2 pr-4">
                <span className="flex flex-wrap gap-1">
                  {i.tags.length ? i.tags.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-slate-400">—</span>}
                </span>
              </td>
              <td className="py-2 pr-4">
                {i.pool ?? <span className="text-slate-400">—</span>}
                {i.read_only && (
                  <div>
                    <Badge tone="gray">somente leitura</Badge>
                  </div>
                )}
              </td>
              <td className="py-2 pr-4">
                <PowerBadge state={i.power_state} />
              </td>
              <td className="py-2 pr-4 tabular-nums text-slate-600 dark:text-slate-400">
                {i.vcpus} vCPU · {(i.memory_mb / 1024).toFixed(1)} GiB · {i.root_disk_gb} GiB
              </td>
              {action && <td className="py-2 text-right">{action(i)}</td>}
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
    <Dialog open={open} onClose={close} title="Adicionar hypervisor">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Rode antes o <code>deploy/proxmox/setup-node.sh</code> no servidor: ele cria o usuário, o pool e o
          token com o mínimo de permissões.
        </p>
        <Field label="Nome" hint="Rótulo para os admins, ex.: hv08. Os clientes não veem.">
          <Input name="name" required maxLength={64} placeholder="hv08" disabled={created !== null} />
        </Field>
        <Field label="URL da API" hint="Ex.: https://hv08.exemplo.com:8006">
          <Input name="api_url" type="url" required placeholder="https://host:8006" disabled={created !== null} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Token ID" hint="usuario@realm!token">
            <Input name="token_id" required defaultValue="cloudmgr@pve!cm" />
          </Field>
          <Field label="Secret" hint="Cole aqui; é guardado cifrado e nunca exibido.">
            <Input name="secret" type="password" autoComplete="off" required />
          </Field>
        </div>
        <Field label="Zona" hint="Onde este servidor fica. Sem zona, ele é monitorado mas não recebe VMs novas.">
          <Select name="zone_id" className="w-full" defaultValue="" disabled={created !== null}>
            <option value="">Sem zona</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Pool de destino" hint="Pool do Proxmox onde as VMs novas nascem (o escopo das ACLs do token), ex.: cm-lab.">
          <Input name="pool" maxLength={64} pattern="[A-Za-z0-9._\-]+" placeholder="cm-lab" disabled={created !== null} />
        </Field>
        <Field
          label="CA própria (opcional)"
          hint="PEM da CA do servidor (pve-root-ca.pem). Deixe vazio se o certificado for de uma CA pública, como Let's Encrypt."
        >
          <Textarea name="ca_pem" rows={3} placeholder="-----BEGIN CERTIFICATE-----" disabled={created !== null} />
        </Field>
        {created && !add.isPending && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            O servidor já foi cadastrado; corrija o token e tente de novo.
          </p>
        )}
        <ErrorBox message={add.isError ? errorMessage(add.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? <Spinner /> : null} Adicionar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
