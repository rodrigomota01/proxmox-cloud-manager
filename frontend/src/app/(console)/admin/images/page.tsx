"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Menu, PageHeader, Toolbar } from "@/components/page";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Status, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";

type Template = Schemas["TemplateOut"];
type AdminImage = Schemas["AdminImageOut"];

function useInvalidate(clusterId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "images"] });
    queryClient.invalidateQueries({ queryKey: ["admin", "templates", clusterId] });
  };
}

/** Register a server's template: as a new catalog image, or as another zone of an
 * existing image (e.g. "Debian 13" on hv07 and on hv08). */
function RegisterDialog({
  clusterId,
  template,
  images,
  onClose,
}: {
  clusterId: string;
  template: Template | null;
  images: AdminImage[];
  onClose: () => void;
}) {
  const invalidate = useInvalidate(clusterId);
  const [mode, setMode] = useState<"existing" | "new">(images.length ? "existing" : "new");
  const [visibility, setVisibility] = useState<"public" | "tenant">("public");
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
    enabled: template !== null && mode === "new",
  });
  const done = { onSuccess: () => { invalidate(); onClose(); } };
  const create = useMutation({
    mutationFn: async (body: Schemas["ImageCreate"]) => unwrap(await api.POST("/api/v1/admin/images", { body })),
    ...done,
  });
  const attach = useMutation({
    mutationFn: async (imageId: string) =>
      unwrap(
        await api.POST("/api/v1/admin/images/{image_id}/templates", {
          params: { path: { image_id: imageId } },
          body: { cluster_id: clusterId, template_vmid: template!.vmid },
        }),
      ),
    ...done,
  });
  const error = create.error ?? attach.error;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (mode === "existing") {
      attach.mutate(String(f.get("image_id")));
      return;
    }
    create.mutate({
      cluster_id: clusterId,
      template_vmid: template!.vmid,
      name: String(f.get("name")),
      description: String(f.get("description") ?? ""),
      default_user: String(f.get("default_user")),
      visibility,
      tenant_id: visibility === "tenant" ? String(f.get("tenant_id")) : null,
    });
  }

  return (
    <Dialog open={template !== null} onClose={onClose} title={`Registrar ${template?.name ?? ""} (${template?.vmid ?? ""})`}>
      <form onSubmit={submit} className="space-y-3">
        <div role="radiogroup" className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={mode === "existing"} disabled={!images.length} onChange={() => setMode("existing")} />
            Adicionar a uma imagem existente
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
            Nova imagem
          </label>
        </div>
        {mode === "existing" ? (
          <Field label="Imagem" hint="A imagem passa a estar disponível também na zona deste servidor.">
            <Select name="image_id" className="w-full" required defaultValue="">
              <option value="" disabled>
                Selecione…
              </option>
              {images.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <>
            <Field label="Nome no catálogo" hint="Sem o nome do servidor: a mesma imagem pode existir em várias zonas.">
              <Input name="name" required maxLength={100} defaultValue={template?.name} />
            </Field>
            <Field label="Descrição">
              <Input name="description" maxLength={1000} />
            </Field>
            <Field label="Usuário padrão" hint="Usuário que o cloud-init cria e que recebe as chaves SSH.">
              <Input name="default_user" required defaultValue="debian" pattern="[a-z_][a-z0-9_\-]{0,31}" />
            </Field>
            <Field label="Visibilidade">
              <Select className="w-full" value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "tenant")}>
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
          </>
        )}
        <ErrorBox message={error ? errorMessage(error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending || attach.isPending}>
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
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "images"] });
  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      unwrap(await api.PATCH("/api/v1/admin/images/{image_id}", { params: { path: { image_id: id } }, body: { active } })),
    onSuccess: refresh,
  });
  const detach = useMutation({
    mutationFn: async ({ image, template }: { image: string; template: string }) =>
      unwrap(
        await api.DELETE("/api/v1/admin/images/{image_id}/templates/{template_id}", {
          params: { path: { image_id: image, template_id: template } },
        }),
      ),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["admin", "templates"] });
    },
  });
  const imageName = new Map((images.data ?? []).map((i) => [i.id, i.name]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Imagens"
        breadcrumbs={[{ label: "Computação" }, { label: "Imagens" }]}
        description="Catálogo oferecido em “Nova instância”. Cada imagem aponta para um template em um ou mais servidores (uma zona por servidor)."
      />

      <ErrorBox message={toggle.isError ? errorMessage(toggle.error) : detach.isError ? errorMessage(detach.error) : null} />
      <Card title="Catálogo" description={images.data ? `${images.data.length} imagem(ns)` : undefined} flush>
        {images.data?.length === 0 ? (
          <Empty icon="layers" title="Nenhuma imagem registrada">
            Escolha um servidor em “Templates nos servidores” abaixo e registre um template.
          </Empty>
        ) : (
          !!images.data?.length && (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Imagem</th>
                    <th className={tbl.th}>Visibilidade</th>
                    <th className={tbl.th}>Status</th>
                    <th className={tbl.th}>Templates (zona · servidor · VMID)</th>
                    <th className={tbl.th} />
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {images.data.map((i) => (
                    <tr key={i.id} className={`${tbl.tr} align-top`}>
                      <td className={tbl.td}>
                        <div className="font-medium">{i.name}</div>
                        <div className="text-xs text-slate-500">
                          usuário {i.default_user} · disco mín. {i.min_disk_gb} GiB
                        </div>
                      </td>
                      <td className={tbl.td}>
                        <Badge tone={i.visibility === "public" ? "blue" : "gray"}>
                          {i.visibility === "public" ? "Pública" : "Tenant"}
                        </Badge>
                      </td>
                      <td className={tbl.td}>
                        {!i.active ? (
                          <Status tone="off">Desativada</Status>
                        ) : i.templates.length === 0 ? (
                          <Status tone="warn" title="Sem template em nenhum servidor">
                            Indisponível
                          </Status>
                        ) : (
                          <Status tone="ok">Disponível</Status>
                        )}
                      </td>
                      <td className={tbl.td}>
                        {i.templates.length === 0 ? (
                          <span className="text-xs text-amber-700 dark:text-amber-300">Sem template em nenhum servidor.</span>
                        ) : (
                          <ul className="flex flex-wrap gap-1.5">
                            {i.templates.map((t) => (
                              <li
                                key={t.id}
                                className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-800/50"
                              >
                                <span>
                                  {t.zone_name ?? <span className="text-amber-700 dark:text-amber-300">sem zona</span>} ·{" "}
                                  {t.cluster_name} · {t.template_vmid}
                                </span>
                                <button
                                  aria-label={`Remover template de ${t.cluster_name}`}
                                  title="Remover este template da imagem"
                                  className="text-slate-400 hover:text-rose-600"
                                  disabled={detach.isPending}
                                  onClick={() => detach.mutate({ image: i.id, template: t.id })}
                                >
                                  ✕
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className={`${tbl.td} text-right`}>
                        <Menu
                          ariaLabel={`Ações de ${i.name}`}
                          items={[
                            {
                              label: i.active ? "Desativar" : "Reativar",
                              danger: i.active,
                              disabled: toggle.isPending,
                              onClick: () => toggle.mutate({ id: i.id, active: !i.active }),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </Card>

      <ErrorBox message={templates.isError ? errorMessage(templates.error) : null} />
      <Card
        title="Templates nos servidores"
        description="Templates que o token de cada servidor enxerga; registre-os no catálogo."
        flush
      >
        <Toolbar count={templates.data ? `${templates.data.length} template(s)` : undefined}>
          <Select aria-label="Servidor" value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
            <option value="">Escolha um servidor…</option>
            {clusters.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.zone_name ? ` (${c.zone_name})` : " (sem zona)"}
              </option>
            ))}
          </Select>
        </Toolbar>
        {!clusterId && <Empty icon="server">Escolha um servidor para ver os templates que o token enxerga.</Empty>}
        {templates.data?.length === 0 && <Empty>Nenhum template visível. Dê ao token acesso de leitura/clone no template.</Empty>}
        {!!templates.data?.length && (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>Template</th>
                  <th className={tbl.th}>VMID</th>
                  <th className={tbl.th}>Node</th>
                  <th className={`${tbl.th} text-right`}>Disco</th>
                  <th className={tbl.th}>No catálogo</th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {templates.data.map((t) => (
                  <tr key={t.vmid} className={tbl.tr}>
                    <td className={`${tbl.td} font-medium`}>{t.name}</td>
                    <td className={`${tbl.td} tabular-nums`}>{t.vmid}</td>
                    <td className={tbl.td}>{t.node}</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{t.disk_gb} GiB</td>
                    <td className={tbl.td}>
                      {t.image_id ? (
                        <Status tone="ok">em “{imageName.get(t.image_id) ?? "imagem"}”</Status>
                      ) : (
                        <Button variant="secondary" onClick={() => setRegistering(t)}>
                          Registrar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <RegisterDialog
        key={registering?.vmid ?? "none"}
        clusterId={clusterId}
        template={registering}
        images={images.data ?? []}
        onClose={() => setRegistering(null)}
      />
    </div>
  );
}
