"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ClusterStatus } from "@/components/cluster-status";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Textarea, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";

function CreateClusterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async (body: { name: string; api_url: string; ca_pem?: string; pool?: string }) =>
      unwrap(await api.POST("/api/v1/admin/clusters", { body })),
    onSuccess: (cluster) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "clusters"] });
      router.push(`/admin/clusters/${cluster.id}`);
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const ca = String(form.get("ca_pem") ?? "").trim();
    const pool = String(form.get("pool") ?? "").trim();
    create.mutate({
      name: String(form.get("name")),
      api_url: String(form.get("api_url")),
      ...(ca ? { ca_pem: ca } : {}),
      ...(pool ? { pool } : {}),
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Novo cluster Proxmox">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome">
          <Input name="name" required maxLength={64} placeholder="hv08" />
        </Field>
        <Field label="URL da API" hint="Ex.: https://hv08.exemplo.com:8006">
          <Input name="api_url" type="url" required placeholder="https://host:8006" />
        </Field>
        <Field
          label="Pool de destino"
          hint="Pool do Proxmox onde as VMs novas nascem (o escopo das ACLs do token), ex.: cm-lab."
        >
          <Input name="pool" maxLength={64} pattern="[A-Za-z0-9._\-]+" placeholder="cm-lab" />
        </Field>
        <Field
          label="CA própria (opcional)"
          hint="PEM da CA do cluster (pve-root-ca.pem). Deixe vazio se o certificado for de uma CA pública, como Let's Encrypt."
        >
          <Textarea name="ca_pem" rows={4} placeholder="-----BEGIN CERTIFICATE-----" />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Cadastrar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function ClustersPage() {
  const [creating, setCreating] = useState(false);
  const clusters = useQuery({
    queryKey: ["admin", "clusters"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/clusters")),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Clusters Proxmox</h1>
        <Button onClick={() => setCreating(true)}>Novo cluster</Button>
      </div>
      <ErrorBox message={clusters.isError ? errorMessage(clusters.error) : null} />
      <Card>
        {clusters.data?.length === 0 && <Empty>Nenhum cluster cadastrado.</Empty>}
        {!!clusters.data?.length && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Nome</th>
                <th className="py-2 pr-4 font-medium">URL</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Versão</th>
                <th className="py-2 font-medium">Último sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {clusters.data.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/admin/clusters/${c.id}`}
                      className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {c.name}
                    </Link>
                    {!c.has_credentials && (
                      <span className="ml-2">
                        <Badge tone="amber">sem credencial</Badge>
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{c.api_url}</td>
                  <td className="py-2 pr-4">
                    <ClusterStatus status={c.status} />
                  </td>
                  <td className="py-2 pr-4">{c.version ?? "—"}</td>
                  <td className="py-2">{formatDate(c.last_synced_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <CreateClusterDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
