"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { Button, Card, Dialog, Empty, ErrorBox, Field, Input, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
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
  const create = useMutation({
    mutationFn: async (body: Schemas["ProjectCreate"]) => unwrap(await api.POST("/api/v1/projects", { body })),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Novo projeto">
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
        <Field label="Nome">
          <Input name="name" required maxLength={100} placeholder="Produção" />
        </Field>
        <Field label="Identificador" hint="Minúsculas, números e hífen. Não muda depois.">
          <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder="producao" />
        </Field>
        <Field label="Descrição (opcional)">
          <Input name="description" maxLength={1000} />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Criar projeto
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const invalidate = useInvalidate();
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
    <Dialog open={project !== null} onClose={onClose} title={`Projeto ${project?.name ?? ""}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          update.mutate({ name: String(f.get("name")), description: String(f.get("description") ?? "") });
        }}
        className="space-y-3"
      >
        <Field label="Nome">
          <Input name="name" required maxLength={100} defaultValue={project?.name} />
        </Field>
        <Field label="Descrição">
          <Input name="description" maxLength={1000} defaultValue={project?.description} />
        </Field>
        <ErrorBox message={update.isError ? errorMessage(update.error) : null} />
        <div className="flex justify-end">
          <Button type="submit" disabled={update.isPending}>
            Salvar
          </Button>
        </div>
      </form>
      <div className="mt-6 space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="text-sm font-medium text-rose-700 dark:text-rose-300">Excluir projeto</p>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Os acessos dados a este projeto são removidos. Digite <strong>{project?.slug}</strong> para confirmar.
        </p>
        <div className="flex gap-2">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          <Button variant="danger" disabled={confirm !== project?.slug || remove.isPending} onClick={() => remove.mutate()}>
            Excluir
          </Button>
        </div>
        <ErrorBox message={remove.isError ? errorMessage(remove.error) : null} />
      </div>
    </Dialog>
  );
}

export default function ProjectsPage() {
  const { tenantId, tenant } = useSession();
  const projects = useProjects();
  const perms = usePermissions(tenantId ? `tenant:${tenantId}` : null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  if (!tenantId) return <NoTenant />;
  const canManage = perms.has("project:create");

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Projetos</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Projetos organizam as VMs de {tenant?.name}. Membros com acesso a um projeto só veem as VMs dele.
          </p>
        </div>
        {canManage && <Button onClick={() => setCreating(true)}>Novo projeto</Button>}
      </div>
      <ErrorBox message={projects.isError ? errorMessage(projects.error) : null} />
      <Card>
        {projects.data?.length === 0 && <Empty>Nenhum projeto.</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {projects.data?.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-4 py-3 text-sm">
              <div>
                <span className="font-medium">{p.name}</span>{" "}
                <span className="font-mono text-xs text-slate-500">{p.slug}</span>
                {p.description && <div className="text-xs text-slate-500">{p.description}</div>}
                <div className="text-xs text-slate-500">Criado em {formatDate(p.created_at)}</div>
              </div>
              {canManage && (
                <Button variant="ghost" onClick={() => setEditing(p)}>
                  Editar
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      <EditProjectDialog key={editing?.id ?? "none"} project={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
