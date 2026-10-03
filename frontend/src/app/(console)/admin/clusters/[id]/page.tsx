"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { ClusterStatus } from "@/components/cluster-status";
import {
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
  formatDate,
} from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useJob } from "@/lib/jobs";

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
      queryClient.invalidateQueries({ queryKey: ["admin", "cluster", cluster.id] });
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

export default function ClusterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [syncJob, setSyncJob] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<AdminInstance | null>(null);

  const cluster = useQuery({
    queryKey: ["admin", "cluster", id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/clusters/{cluster_id}", { params: { path: { cluster_id: id } } })),
  });
  const instances = useQuery({
    queryKey: ["admin", "instances", id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/instances", { params: { query: { cluster_id: id } } })),
    refetchInterval: 15_000,
  });
  const runs = useQuery({
    queryKey: ["admin", "sync-runs", id],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/admin/clusters/{cluster_id}/sync-runs", {
          params: { path: { cluster_id: id }, query: { limit: 5 } },
        }),
      ),
    refetchInterval: 15_000,
  });

  const test = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/v1/admin/clusters/{cluster_id}/test", { params: { path: { cluster_id: id } } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "cluster", id] }),
  });
  const sync = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/v1/admin/clusters/{cluster_id}/sync", { params: { path: { cluster_id: id } } })),
    onSuccess: (res) => setSyncJob(res.job.id),
  });
  const { job, done } = useJob(syncJob, {
    admin: true,
    invalidate: [["admin", "instances", id], ["admin", "sync-runs", id], ["admin", "cluster", id]],
  });

  if (cluster.isError) return <ErrorBox message={errorMessage(cluster.error)} />;
  const c = cluster.data;
  if (!c) return null;
  const discovered = instances.data?.filter((i) => !i.managed) ?? [];
  const managed = instances.data?.filter((i) => i.managed) ?? [];
  const syncing = sync.isPending || (syncJob !== null && !done);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/clusters" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          ← Clusters
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">{c.name}</h1>
            <ClusterStatus status={c.status} />
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
      </div>

      {test.data && (
        test.data.ok ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            Conectado: Proxmox {test.data.version}, {test.data.nodes_online}/{test.data.nodes_total} node(s)
            online, {test.data.guests_visible} guest(s) visíveis ao token.
          </div>
        ) : (
          <ErrorBox message={`Falha na conexão: ${test.data.error}`} />
        )
      )}
      <ErrorBox message={test.isError ? errorMessage(test.error) : null} />
      <ErrorBox message={sync.isError ? errorMessage(sync.error) : null} />
      {job?.status === "failed" && <ErrorBox message={`Sincronização falhou: ${job.error_message}`} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Configuração">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">URL</dt>
              <dd>{c.api_url}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">TLS</dt>
              <dd>{c.insecure_skip_verify ? "sem verificação (dev)" : c.has_custom_ca ? "CA própria" : "CAs do sistema"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Versão</dt>
              <dd>{c.version ?? "—"}</dd>
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

      <Card title={`Descobertas (${discovered.length})`}>
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          Guests que existem no Proxmox mas ainda não pertencem a nenhum projeto. Só administradores as veem.
        </p>
        {discovered.length === 0 ? (
          <Empty>Nada a adotar.</Empty>
        ) : (
          <InstanceTable rows={discovered} action={(i) => <Button variant="secondary" onClick={() => setAdopting(i)}>Adotar</Button>} />
        )}
      </Card>

      <Card title={`Gerenciadas (${managed.length})`}>
        {managed.length === 0 ? <Empty>Nenhuma instância adotada.</Empty> : <InstanceTable rows={managed} />}
      </Card>

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

      <AdoptDialog instance={adopting} onClose={() => setAdopting(null)} />
    </div>
  );
}

function InstanceTable({
  rows,
  action,
}: {
  rows: AdminInstance[];
  action?: (i: AdminInstance) => React.ReactNode;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className="py-2 pr-4 font-medium">VMID</th>
          <th className="py-2 pr-4 font-medium">Nome</th>
          <th className="py-2 pr-4 font-medium">Node</th>
          <th className="py-2 pr-4 font-medium">Tipo</th>
          <th className="py-2 pr-4 font-medium">Estado</th>
          <th className="py-2 pr-4 font-medium">Recursos</th>
          {action && <th className="py-2 font-medium" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((i) => (
          <tr key={i.id}>
            <td className="py-2 pr-4 tabular-nums">{i.vmid}</td>
            <td className="py-2 pr-4">
              {i.name}
              {i.name !== i.provider_name && <span className="ml-1 text-xs text-slate-500">({i.provider_name})</span>}
            </td>
            <td className="py-2 pr-4">{i.node}</td>
            <td className="py-2 pr-4">{i.kind === "vm" ? "VM" : "Container"}</td>
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
  );
}
