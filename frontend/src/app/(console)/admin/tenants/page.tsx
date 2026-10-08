"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Menu, PageHeader, ResourceIcon, SearchInput, Toolbar } from "@/components/page";
import { Button, Card, Dialog, Empty, ErrorBox, Field, Input, Status, tbl } from "@/components/ui";
import { Meter, mib } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useSession } from "@/lib/session";

type Tenant = Schemas["TenantOut"];

const LABEL: Record<string, string> = {
  instances: "Instâncias",
  vcpus: "vCPUs",
  memory_mb: "Memória (MiB)",
  storage_gb: "Disco (GiB)",
};
const COLUMNS = [
  { resource: "instances", label: "Instâncias", format: (v: number) => String(v) },
  { resource: "vcpus", label: "vCPUs", format: (v: number) => String(v) },
  { resource: "memory_mb", label: "Memória", format: mib },
  { resource: "storage_gb", label: "Disco", format: (v: number) => `${v} GiB` },
] as const;

function useQuotas(tenantId: string) {
  return useQuery({
    queryKey: ["admin", "quotas", tenantId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/admin/tenants/{tenant_id}/quotas", {
          params: { path: { tenant_id: tenantId } },
        }),
      ),
  });
}

function QuotaEditor({ tenantId, onSaved }: { tenantId: string; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const quotas = useQuotas(tenantId);
  const save = useMutation({
    mutationFn: async (body: Record<string, number>) =>
      unwrap(
        await api.PUT("/api/v1/admin/tenants/{tenant_id}/quotas", {
          params: { path: { tenant_id: tenantId } },
          body,
        }),
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(["admin", "quotas", tenantId], data);
      onSaved();
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    save.mutate(
      Object.fromEntries(
        (quotas.data ?? []).map((q) => [q.resource, Number(form.get(q.resource))]),
      ),
    );
  }

  if (!quotas.data) return null;
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Limites valem para a criação de instâncias; instâncias adotadas também contam no uso.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {quotas.data.map((q) => (
          <Field key={q.resource} label={LABEL[q.resource] ?? q.resource} hint={`Em uso: ${q.used}`}>
            <Input name={q.resource} type="number" min={0} required defaultValue={q.limit} />
          </Field>
        ))}
      </div>
      <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onSaved}>
          Cancelar
        </Button>
        <Button type="submit" disabled={save.isPending}>
          Salvar quotas
        </Button>
      </div>
    </form>
  );
}

function NewTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [invited, setInvited] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (body: Schemas["TenantCreate"]) => unwrap(await api.POST("/api/v1/tenants", { body })),
    onSuccess: (_, body) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      setInvited(body.admin_email ?? "");
    },
  });
  const close = () => {
    setInvited(null);
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Novo cliente (tenant)">
      {invited !== null ? (
        <div className="space-y-4 text-sm">
          <p>Cliente criado.</p>
          {invited && (
            <p>
              <strong>{invited}</strong> recebeu um convite por e-mail para definir a senha e entra como
              admin do cliente.
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={close}>Fechar</Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const email = String(f.get("admin_email") ?? "").trim();
            create.mutate({
              name: String(f.get("name")),
              slug: String(f.get("slug")),
              ...(email ? { admin_email: email } : {}),
            });
          }}
          className="space-y-3"
        >
          <Field label="Nome do cliente">
            <Input name="name" required maxLength={100} placeholder="Pluxee" />
          </Field>
          <Field label="Identificador" hint="Minúsculas, números e hífen. Não muda depois (vira parte do pool no Proxmox).">
            <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder="pluxee" />
          </Field>
          <Field
            label="E-mail do responsável (opcional)"
            hint="Recebe um convite e vira admin do cliente: cria projetos, convida a equipe e gerencia VMs."
          >
            <Input name="admin_email" type="email" placeholder="ti@cliente.com" />
          </Field>
          <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Criar cliente
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function TenantRow({
  t,
  open,
  editQuotas,
}: {
  t: Tenant;
  open: (tenantId: string, path: string) => void;
  editQuotas: (t: Tenant) => void;
}) {
  const quotas = useQuotas(t.id);
  const byResource = new Map((quotas.data ?? []).map((q) => [q.resource, q]));
  return (
    <tr className={tbl.tr}>
      <td className={tbl.td}>
        <div className="flex items-center gap-2">
          <ResourceIcon kind="tenant" />
          <button type="button" onClick={() => open(t.id, "/projects")} className={tbl.link}>
            {t.name}
          </button>
        </div>
        <div className="mt-0.5 pl-9 font-mono text-xs text-slate-500">{t.slug}</div>
      </td>
      <td className={tbl.td}>
        {t.status === "active" ? <Status tone="ok">Ativo</Status> : <Status tone="warn">{t.status}</Status>}
      </td>
      {COLUMNS.map((c) => {
        const q = byResource.get(c.resource);
        return (
          <td key={c.resource} className={tbl.td}>
            {q ? (
              <Meter
                value={q.limit ? q.used / q.limit : q.used ? 1 : 0}
                label={`${c.format(q.used)} / ${c.format(q.limit)}`}
                title={`${c.label} de ${t.name}: em uso sobre o limite`}
              />
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </td>
        );
      })}
      <td className={`${tbl.td} text-right`}>
        <Menu
          ariaLabel={`Ações de ${t.name}`}
          items={[
            { label: "Editar quotas", onClick: () => editQuotas(t) },
            { label: "Membros", onClick: () => open(t.id, "/members") },
            { label: "Projetos", onClick: () => open(t.id, "/projects") },
            { label: "Custos", onClick: () => open(t.id, "/costs") },
          ]}
        />
      </td>
    </tr>
  );
}

export default function AdminTenantsPage() {
  const router = useRouter();
  const { selectTenant } = useSession();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [search, setSearch] = useState("");
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
  });
  const open = (tenantId: string, path: string) => {
    selectTenant(tenantId);
    router.push(path);
  };
  const q = search.trim().toLowerCase();
  const visible = (tenants.data ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clientes e quotas"
        description="Cada cliente é isolado: seus usuários só veem os recursos do próprio cliente. Limites valem para a criação de instâncias; instâncias adotadas também contam no uso."
        actions={<Button onClick={() => setCreating(true)}>Novo cliente</Button>}
      />
      <ErrorBox message={tenants.isError ? errorMessage(tenants.error) : null} />
      <Card flush>
        <Toolbar count={tenants.data ? `${visible.length} de ${tenants.data.length} clientes` : undefined}>
          <SearchInput value={search} onChange={setSearch} placeholder="Filtrar por nome ou identificador…" />
        </Toolbar>
        {tenants.data?.length === 0 ? (
          <Empty
            title="Nenhum cliente"
            icon="building"
            action={<Button onClick={() => setCreating(true)}>Novo cliente</Button>}
          >
            Crie o primeiro cliente para começar a provisionar VMs.
          </Empty>
        ) : tenants.data && visible.length === 0 ? (
          <Empty title="Nenhum resultado">Nenhum cliente corresponde ao filtro.</Empty>
        ) : (
          <div className={tbl.wrap}>
            <table className={`${tbl.table} min-w-[64rem]`}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>Cliente</th>
                  <th className={tbl.th}>Status</th>
                  {COLUMNS.map((c) => (
                    <th key={c.resource} className={tbl.th}>
                      {c.label}
                    </th>
                  ))}
                  <th className={tbl.th}>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {visible.map((t) => (
                  <TenantRow key={t.id} t={t} open={open} editQuotas={setEditing} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <NewTenantDialog open={creating} onClose={() => setCreating(false)} />
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={`Quotas de ${editing?.name ?? ""}`}>
        {editing && <QuotaEditor key={editing.id} tenantId={editing.id} onSaved={() => setEditing(null)} />}
      </Dialog>
    </div>
  );
}
