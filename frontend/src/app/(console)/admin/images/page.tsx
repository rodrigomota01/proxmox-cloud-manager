"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Menu, PageHeader, Toolbar } from "@/components/page";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Status, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";

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
  const t = useT();
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
      kubernetes_version: String(f.get("kubernetes_version") ?? "").trim() || null,
    });
  }

  return (
    <Dialog open={template !== null} onClose={onClose} title={t("infra.images.registerTitle", { name: template?.name ?? "", vmid: template?.vmid ?? "" })}>
      <form onSubmit={submit} className="space-y-3">
        <div role="radiogroup" className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={mode === "existing"} disabled={!images.length} onChange={() => setMode("existing")} />
            {t("infra.images.addToExisting")}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
            {t("infra.images.newImage")}
          </label>
        </div>
        {mode === "existing" ? (
          <Field label={t("infra.images.image")} hint={t("infra.images.imageHint")}>
            <Select name="image_id" className="w-full" required defaultValue="">
              <option value="" disabled>
                {t("infra.common.selectPlaceholder")}
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
            <Field label={t("infra.images.catalogName")} hint={t("infra.images.catalogNameHint")}>
              <Input name="name" required maxLength={100} defaultValue={template?.name} />
            </Field>
            <Field label={t("infra.common.description")}>
              <Input name="description" maxLength={1000} />
            </Field>
            <Field label={t("infra.images.defaultUser")} hint={t("infra.images.defaultUserHint")}>
              <Input name="default_user" required defaultValue="debian" pattern="[a-z_][a-z0-9_\-]{0,31}" />
            </Field>
            <Field
              label={t("infra.images.k8sVersion")}
              hint={t("infra.images.k8sVersionHint")}
            >
              <Input name="kubernetes_version" pattern="\d+\.\d+\.\d+" placeholder="1.37.1" />
            </Field>
            <Field label={t("infra.images.visibility")}>
              <Select className="w-full" value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "tenant")}>
                <option value="public">{t("infra.images.visibilityPublic")}</option>
                <option value="tenant">{t("infra.images.visibilityTenant")}</option>
              </Select>
            </Field>
            {visibility === "tenant" && (
              <Field label={t("infra.common.tenant")}>
                <Select name="tenant_id" className="w-full" required defaultValue="">
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
            )}
          </>
        )}
        <ErrorBox message={error ? errorMessage(error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("infra.common.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending || attach.isPending}>
            {t("infra.images.register")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function AdminImagesPage() {
  const t = useT();
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
        title={t("nav.images")}
        breadcrumbs={[{ label: t("nav.compute") }, { label: t("nav.images") }]}
        description={t("infra.images.description")}
      />

      <ErrorBox message={toggle.isError ? errorMessage(toggle.error) : detach.isError ? errorMessage(detach.error) : null} />
      <Card
        title={t("infra.images.catalog")}
        description={
          images.data
            ? t(images.data.length === 1 ? "infra.images.imageOne" : "infra.images.imageOther", { count: images.data.length })
            : undefined
        }
        flush
      >
        {images.data?.length === 0 ? (
          <Empty icon="layers" title={t("infra.images.emptyTitle")}>
            {t("infra.images.emptyBody")}
          </Empty>
        ) : (
          !!images.data?.length && (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>{t("infra.images.image")}</th>
                    <th className={tbl.th}>{t("infra.images.visibility")}</th>
                    <th className={tbl.th}>{t("infra.common.status")}</th>
                    <th className={tbl.th}>{t("infra.images.templatesColumn")}</th>
                    <th className={tbl.th} />
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {images.data.map((i) => (
                    <tr key={i.id} className={`${tbl.tr} align-top`}>
                      <td className={tbl.td}>
                        <div className="font-medium">{i.name}</div>
                        <div className="text-xs text-slate-500">
                          {t("infra.images.imageMeta", { user: i.default_user, disk: i.min_disk_gb })}
                        </div>
                        {i.kubernetes_version && (
                          <div className="mt-1">
                            <Badge tone="brand">Kubernetes {i.kubernetes_version}</Badge>
                          </div>
                        )}
                      </td>
                      <td className={tbl.td}>
                        <Badge tone={i.visibility === "public" ? "blue" : "gray"}>
                          {i.visibility === "public" ? t("infra.images.public") : t("infra.common.tenant")}
                        </Badge>
                      </td>
                      <td className={tbl.td}>
                        {!i.active ? (
                          <Status tone="off">{t("infra.images.disabled")}</Status>
                        ) : i.templates.length === 0 ? (
                          <Status tone="warn" title={t("infra.images.noTemplateAnywhere")}>
                            {t("infra.images.unavailable")}
                          </Status>
                        ) : (
                          <Status tone="ok">{t("infra.images.available")}</Status>
                        )}
                      </td>
                      <td className={tbl.td}>
                        {i.templates.length === 0 ? (
                          <span className="text-xs text-amber-700 dark:text-amber-300">{t("infra.images.noTemplateAnywhereSentence")}</span>
                        ) : (
                          <ul className="flex flex-wrap gap-1.5">
                            {i.templates.map((tpl) => (
                              <li
                                key={tpl.id}
                                className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-800/50"
                              >
                                <span>
                                  {tpl.zone_name ?? <span className="text-amber-700 dark:text-amber-300">{t("infra.common.noZone")}</span>} ·{" "}
                                  {tpl.cluster_name} · {tpl.template_vmid}
                                </span>
                                <button
                                  aria-label={t("infra.images.removeTemplateOf", { name: tpl.cluster_name })}
                                  title={t("infra.images.removeTemplate")}
                                  className="text-slate-400 hover:text-rose-600"
                                  disabled={detach.isPending}
                                  onClick={() => detach.mutate({ image: i.id, template: tpl.id })}
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
                          ariaLabel={t("infra.images.actionsOf", { name: i.name })}
                          items={[
                            {
                              label: i.active ? t("infra.images.deactivate") : t("infra.images.reactivate"),
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
        title={t("infra.images.serverTemplates")}
        description={t("infra.images.serverTemplatesDesc")}
        flush
      >
        <Toolbar count={templates.data ? t("infra.images.templateCount", { count: templates.data.length }) : undefined}>
          <Select aria-label={t("infra.images.server")} value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
            <option value="">{t("infra.images.chooseServer")}</option>
            {clusters.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.zone_name ? ` (${c.zone_name})` : t("infra.images.noZoneSuffix")}
              </option>
            ))}
          </Select>
        </Toolbar>
        {!clusterId && <Empty icon="server">{t("infra.images.chooseServerBody")}</Empty>}
        {templates.data?.length === 0 && <Empty>{t("infra.images.noTemplates")}</Empty>}
        {!!templates.data?.length && (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>Template</th>
                  <th className={tbl.th}>VMID</th>
                  <th className={tbl.th}>{t("infra.common.node")}</th>
                  <th className={`${tbl.th} text-right`}>{t("infra.images.disk")}</th>
                  <th className={tbl.th}>{t("infra.images.inCatalog")}</th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {templates.data.map((tpl) => (
                  <tr key={tpl.vmid} className={tbl.tr}>
                    <td className={`${tbl.td} font-medium`}>{tpl.name}</td>
                    <td className={`${tbl.td} tabular-nums`}>{tpl.vmid}</td>
                    <td className={tbl.td}>{tpl.node}</td>
                    <td className={`${tbl.td} text-right tabular-nums`}>{tpl.disk_gb} GiB</td>
                    <td className={tbl.td}>
                      {tpl.image_id ? (
                        <Status tone="ok">
                          {t("infra.images.inImage", { name: imageName.get(tpl.image_id) ?? t("infra.images.imageFallback") })}
                        </Status>
                      ) : (
                        <Button variant="secondary" onClick={() => setRegistering(tpl)}>
                          {t("infra.images.register")}
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
