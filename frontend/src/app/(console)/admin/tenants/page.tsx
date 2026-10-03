"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, Dialog, Empty, ErrorBox, Field, Input } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useSession } from "@/lib/session";

const LABEL: Record<string, string> = {
  instances: "Instâncias",
  vcpus: "vCPUs",
  memory_mb: "Memória (MiB)",
  storage_gb: "Disco (GiB)",
};

function QuotaEditor({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const quotas = useQuery({
    queryKey: ["admin", "quotas", tenantId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/admin/tenants/{tenant_id}/quotas", {
          params: { path: { tenant_id: tenantId } },
        }),
      ),
  });
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
      setSaved(true);
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaved(false);
    save.mutate(
      Object.fromEntries(
        (quotas.data ?? []).map((q) => [q.resource, Number(form.get(q.resource))]),
      ),
    );
  }

  if (!quotas.data) return null;
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        {quotas.data.map((q) => (
          <Field key={q.resource} label={LABEL[q.resource] ?? q.resource} hint={`Em uso: ${q.used}`}>
            <Input name={q.resource} type="number" min={0} required defaultValue={q.limit} />
          </Field>
        ))}
      </div>
      <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" disabled={save.isPending}>
          Salvar quotas
        </Button>
        {saved && <span className="text-sm text-emerald-600">Salvo.</span>}
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

export default function AdminTenantsPage() {
  const router = useRouter();
  const { selectTenant } = useSession();
  const [creating, setCreating] = useState(false);
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
  });
  const open = (tenantId: string, path: string) => {
    selectTenant(tenantId);
    router.push(path);
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Clientes (tenants) e quotas</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Cada cliente é isolado: seus usuários só veem os recursos do próprio cliente. Limites valem
            para a criação de instâncias; instâncias adotadas também contam no uso.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Novo cliente</Button>
      </div>
      <ErrorBox message={tenants.isError ? errorMessage(tenants.error) : null} />
      {tenants.data?.length === 0 && <Empty>Nenhum cliente.</Empty>}
      {tenants.data?.map((t) => (
        <Card
          key={t.id}
          title={`${t.name} (${t.slug})`}
          actions={
            <>
              <Button variant="ghost" onClick={() => open(t.id, "/members")}>
                Membros
              </Button>
              <Button variant="ghost" onClick={() => open(t.id, "/projects")}>
                Projetos
              </Button>
            </>
          }
        >
          <QuotaEditor tenantId={t.id} />
        </Card>
      ))}
      <NewTenantDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
