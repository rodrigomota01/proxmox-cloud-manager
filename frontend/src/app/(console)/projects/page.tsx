"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { Menu, PageHeader, ResourceIcon, SearchInput, Toolbar } from "@/components/page";
import { Button, Card, Dialog, Empty, ErrorBox, Field, Input, formatDate, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useProjects } from "@/lib/queries";
import { usePermissions, useSession } from "@/lib/session";

type Project = Schemas["ProjectOut"];

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invalidate = useInvalidate();
  const t = useT();
  const create = useMutation({
    mutationFn: async (body: Schemas["ProjectCreate"]) => unwrap(await api.POST("/api/v1/projects", { body })),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("access.projects.newProject")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({
            name: String(f.get("name")),
            slug: String(f.get("slug")),
            description: String(f.get("description") ?? ""),
          });
        }}
        className="space-y-3"
      >
        <Field label={t("access.common.name")}>
          <Input name="name" required maxLength={100} placeholder={t("access.projects.namePlaceholder")} />
        </Field>
        <Field label={t("access.common.identifier")} hint={t("access.projects.slugHint")}>
          <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder={t("access.projects.slugPlaceholder")} />
        </Field>
        <Field label={t("access.projects.descriptionOptional")}>
          <Input name="description" maxLength={1000} />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("access.common.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t("access.projects.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const invalidate = useInvalidate();
  const t = useT();
  const [confirm, setConfirm] = useState("");
  const update = useMutation({
    mutationFn: async (body: Schemas["ProjectUpdate"]) =>
      unwrap(await api.PATCH("/api/v1/projects/{project_id}", { params: { path: { project_id: project!.id } }, body })),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE("/api/v1/projects/{project_id}", {
          params: { path: { project_id: project!.id } },
          body: { confirm },
        }),
      ),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog open={project !== null} onClose={onClose} title={t("access.projects.projectTitle", { name: project?.name ?? "" })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          update.mutate({ name: String(f.get("name")), description: String(f.get("description") ?? "") });
        }}
        className="space-y-3"
      >
        <Field label={t("access.common.name")}>
          <Input name="name" required maxLength={100} defaultValue={project?.name} />
        </Field>
        <Field label={t("access.common.description")}>
          <Input name="description" maxLength={1000} defaultValue={project?.description} />
        </Field>
        <ErrorBox message={update.isError ? errorMessage(update.error) : null} />
        <div className="flex justify-end">
          <Button type="submit" disabled={update.isPending}>
            {t("access.common.save")}
          </Button>
        </div>
      </form>
      <div className="mt-6 space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="text-sm font-medium text-rose-700 dark:text-rose-300">{t("access.projects.deleteTitle")}</p>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          {t("access.projects.deleteBefore")} <strong>{project?.slug}</strong> {t("access.projects.deleteAfter")}
        </p>
        <div className="flex gap-2">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          <Button variant="danger" disabled={confirm !== project?.slug || remove.isPending} onClick={() => remove.mutate()}>
            {t("access.common.delete")}
          </Button>
        </div>
        <ErrorBox message={remove.isError ? errorMessage(remove.error) : null} />
      </div>
    </Dialog>
  );
}

export default function ProjectsPage() {
  const { tenantId, tenant } = useSession();
  const t = useT();
  const projects = useProjects();
  const perms = usePermissions(tenantId ? `tenant:${tenantId}` : null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [search, setSearch] = useState("");
  if (!tenantId) return <NoTenant />;
  const canManage = perms.has("project:create");

  const q = search.trim().toLowerCase();
  const visible = (projects.data ?? []).filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("access.projects.title")}
        description={t("access.projects.description", { tenant: tenant?.name ?? t("access.projects.tenantFallback") })}
        actions={canManage && <Button onClick={() => setCreating(true)}>{t("access.projects.newProject")}</Button>}
      />
      <ErrorBox message={projects.isError ? errorMessage(projects.error) : null} />
      <Card flush>
        <Toolbar count={projects.data ? t("access.projects.count", { visible: visible.length, total: projects.data.length }) : undefined}>
          <SearchInput value={search} onChange={setSearch} />
        </Toolbar>
        {projects.data?.length === 0 ? (
          <Empty
            title={t("access.projects.emptyTitle")}
            icon="folder"
            action={canManage && <Button onClick={() => setCreating(true)}>{t("access.projects.newProject")}</Button>}
          >
            {t("access.projects.empty")}
          </Empty>
        ) : projects.data && visible.length === 0 ? (
          <Empty title={t("access.common.noResults")}>{t("access.projects.noMatch")}</Empty>
        ) : (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>{t("access.common.name")}</th>
                  <th className={tbl.th}>{t("access.common.identifier")}</th>
                  <th className={tbl.th}>{t("access.common.description")}</th>
                  <th className={tbl.th}>{t("access.common.createdAt")}</th>
                  {canManage && (
                    <th className={tbl.th}>
                      <span className="sr-only">{t("common.actions")}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {visible.map((p) => (
                  <tr key={p.id} className={tbl.tr}>
                    <td className={tbl.td}>
                      <span className="flex items-center gap-2">
                        <ResourceIcon kind="project" />
                        <span className="font-medium">{p.name}</span>
                      </span>
                    </td>
                    <td className={`${tbl.td} font-mono text-xs text-slate-500`}>{p.slug}</td>
                    <td className={`${tbl.td} text-slate-600 dark:text-slate-400`}>{p.description || "—"}</td>
                    <td className={`${tbl.td} whitespace-nowrap text-slate-600 dark:text-slate-400`}>
                      {formatDate(p.created_at)}
                    </td>
                    {canManage && (
                      <td className={`${tbl.td} text-right`}>
                        <Menu
                          ariaLabel={t("access.common.actionsFor", { name: p.name })}
                          items={[{ label: t("access.projects.editOrDelete"), onClick: () => setEditing(p) }]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      <EditProjectDialog key={editing?.id ?? "none"} project={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
