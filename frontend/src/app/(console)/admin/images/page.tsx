"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";

type Template = Schemas["TemplateOut"];

function RegisterDialog({
  clusterId,
  template,
  onClose,
}: {
  clusterId: string;
  template: Template | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [visibility, setVisibility] = useState<"public" | "tenant">("public");
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
    enabled: template !== null,
  });
  const register = useMutation({
    mutationFn: async (body: Schemas["ImageCreate"]) =>
      unwrap(await api.POST("/api/v1/admin/images", { body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "images"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "templates", clusterId] });
      onClose();
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    register.mutate({
      cluster_id: clusterId,
      template_vmid: template!.vmid,
      name: String(form.get("name")),
      description: String(form.get("description") ?? ""),
      default_user: String(form.get("default_user")),
      visibility,
      tenant_id: visibility === "tenant" ? String(form.get("tenant_id")) : null,
    });
  }

  return (
    <Dialog open={template !== null} onClose={onClose} title={`Registrar ${template?.name ?? ""}`}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nome no catálogo">
          <Input name="name" required maxLength={100} defaultValue={template?.name} />
        </Field>
        <Field label="Descrição">
          <Input name="description" maxLength={1000} />
        </Field>
        <Field label="Usuário padrão" hint="Usuário que o cloud-init cria e que recebe as chaves SSH.">
          <Input name="default_user" required defaultValue="debian" pattern="[a-z_][a-z0-9_\-]{0,31}" />
        </Field>
        <Field label="Visibilidade">
          <Select
            className="w-full"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "public" | "tenant")}
          >
            <option value="public">Pública (todos os tenants)</option>
            <option value="tenant">Só um tenant</option>
          </Select>
        </Field>
        {visibility === "tenant" && (
          <Field label="Tenant">
            <Select name="tenant_id" className="w-full" required defaultValue="">
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
        )}
        <ErrorBox message={register.isError ? errorMessage(register.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={register.isPending}>
            Registrar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function AdminImagesPage() {
  const queryClient = useQueryClient();
  const [clusterId, setClusterId] = useState("");
  const [registering, setRegistering] = useState<Template | null>(null);

  const clusters = useQuery({
    queryKey: ["admin", "clusters"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/clusters")),
  });
  const images = useQuery({
    queryKey: ["admin", "images"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/images")),
  });
  const templates = useQuery({
    queryKey: ["admin", "templates", clusterId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/admin/clusters/{cluster_id}/templates", {
          params: { path: { cluster_id: clusterId } },
        }),
      ),
    enabled: clusterId !== "",
  });
  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      unwrap(
        await api.PATCH("/api/v1/admin/images/{image_id}", {
          params: { path: { image_id: id } },
          body: { active },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "images"] }),
  });
  const clusterName = new Map((clusters.data ?? []).map((c) => [c.id, c.name]));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Imagens</h1>

      <Card title="Catálogo">
        {images.data?.length === 0 && <Empty>Nenhuma imagem registrada.</Empty>}
        {!!images.data?.length && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Nome</th>
                <th className="py-2 pr-4 font-medium">Cluster / template</th>
                <th className="py-2 pr-4 font-medium">Disco mín.</th>
                <th className="py-2 pr-4 font-medium">Visibilidade</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {images.data.map((i) => (
                <tr key={i.id} className={i.active ? "" : "opacity-50"}>
                  <td className="py-2 pr-4 font-medium">{i.name}</td>
                  <td className="py-2 pr-4">
                    {clusterName.get(i.cluster_id) ?? "—"} · {i.template_vmid}
                  </td>
                  <td className="py-2 pr-4">{i.min_disk_gb} GiB</td>
                  <td className="py-2 pr-4">
                    <Badge tone={i.visibility === "public" ? "blue" : "gray"}>
                      {i.visibility === "public" ? "Pública" : "Tenant"}
                    </Badge>
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ id: i.id, active: !i.active })}
                    >
                      {i.active ? "Desativar" : "Reativar"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorBox message={toggle.isError ? errorMessage(toggle.error) : null} />
      </Card>

      <Card
        title="Templates disponíveis"
        actions={
          <Select aria-label="Cluster" value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
            <option value="">Escolha um cluster…</option>
            {clusters.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        }
      >
        {!clusterId && <Empty>Escolha um cluster para ver os templates que o token enxerga.</Empty>}
        <ErrorBox message={templates.isError ? errorMessage(templates.error) : null} />
        {templates.data?.length === 0 && (
          <Empty>Nenhum template visível. Dê ao token acesso de leitura/clone no template.</Empty>
        )}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {templates.data?.map((t) => (
            <li key={t.vmid} className="flex items-center justify-between gap-4 py-2 text-sm">
              <span>
                <span className="font-medium">{t.name}</span>{" "}
                <span className="text-slate-500">
                  · {t.vmid} · {t.node} · {t.disk_gb} GiB
                </span>
              </span>
              {t.image_id ? (
                <Badge tone="green">registrado</Badge>
              ) : (
                <Button variant="secondary" onClick={() => setRegistering(t)}>
                  Registrar como imagem
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <RegisterDialog clusterId={clusterId} template={registering} onClose={() => setRegistering(null)} />
    </div>
  );
}
