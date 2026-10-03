"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Card, Empty, ErrorBox, Field, Input } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";

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

export default function AdminTenantsPage() {
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
  });
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Tenants e quotas</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Limites usados na criação de instâncias. Instâncias adotadas também contam no uso.
      </p>
      <ErrorBox message={tenants.isError ? errorMessage(tenants.error) : null} />
      {tenants.data?.length === 0 && <Empty>Nenhum tenant.</Empty>}
      {tenants.data?.map((t) => (
        <Card key={t.id} title={`${t.name} (${t.slug})`}>
          <QuotaEditor tenantId={t.id} />
        </Card>
      ))}
    </div>
  );
}
