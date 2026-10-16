"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Menu, PageHeader, ResourceIcon, SearchInput, Toolbar } from "@/components/page";
import { Button, Card, Dialog, Empty, ErrorBox, Field, Input, Status, tbl } from "@/components/ui";
import { Meter, mib } from "@/components/viz";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";
import { useSession } from "@/lib/session";

type Tenant = Schemas["TenantOut"];

const LABEL: Record<string, MessageKey> = {
  instances: "tenants.resources.instances",
  vcpus: "tenants.resources.vcpus",
  memory_mb: "tenants.resources.memoryMib",
  storage_gb: "tenants.resources.storageGib",
};
const COLUMNS: { resource: string; label: MessageKey; format: (v: number) => string }[] = [
  { resource: "instances", label: "tenants.resources.instances", format: (v: number) => String(v) },
  { resource: "vcpus", label: "tenants.resources.vcpus", format: (v: number) => String(v) },
  { resource: "memory_mb", label: "tenants.resources.memory", format: mib },
  { resource: "storage_gb", label: "tenants.resources.storage", format: (v: number) => `${v} GiB` },
];

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
  const t = useT();
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
        {t("tenants.quotas.help")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {quotas.data.map((q) => (
          <Field key={q.resource} label={LABEL[q.resource] ? t(LABEL[q.resource]) : q.resource} hint={t("tenants.quotas.inUse", { used: q.used })}>
            <Input name={q.resource} type="number" min={0} required defaultValue={q.limit} />
          </Field>
        ))}
      </div>
      <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onSaved}>
          {t("tenants.quotas.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {t("tenants.quotas.save")}
        </Button>
      </div>
    </form>
  );
}

function NewTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
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
    <Dialog open={open} onClose={close} title={t("tenants.create.title")}>
      {invited !== null ? (
        <div className="space-y-4 text-sm">
          <p>{t("tenants.create.created")}</p>
          {invited && (
            <p>
              {t("tenants.create.invited").split("{email}")[0]}
              <strong>{invited}</strong>
              {t("tenants.create.invited").split("{email}")[1]}
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={close}>{t("common.close")}</Button>
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
          <Field label={t("tenants.create.name")}>
            <Input name="name" required maxLength={100} placeholder="Pluxee" />
          </Field>
          <Field label={t("tenants.create.slug")} hint={t("tenants.create.slugHint")}>
            <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder="pluxee" />
          </Field>
          <Field
            label={t("tenants.create.adminEmail")}
            hint={t("tenants.create.adminEmailHint")}
          >
            <Input name="admin_email" type="email" placeholder={t("tenants.create.emailPlaceholder")} />
          </Field>
          <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              {t("tenants.create.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {t("tenants.create.submit")}
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
  const tr = useT();
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
        {t.status === "active" ? <Status tone="ok">{tr("tenants.row.active")}</Status> : <Status tone="warn">{t.status}</Status>}
      </td>
      {COLUMNS.map((c) => {
        const q = byResource.get(c.resource);
        return (
          <td key={c.resource} className={tbl.td}>
            {q ? (
              <Meter
                value={q.limit ? q.used / q.limit : q.used ? 1 : 0}
                label={`${c.format(q.used)} / ${c.format(q.limit)}`}
                title={tr("tenants.row.meterTitle", { resource: tr(c.label), name: t.name })}
              />
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </td>
        );
      })}
      <td className={`${tbl.td} text-right`}>
        <Menu
          ariaLabel={tr("tenants.row.actionsFor", { name: t.name })}
          items={[
            { label: tr("tenants.row.editQuotas"), onClick: () => editQuotas(t) },
            { label: tr("tenants.row.members"), onClick: () => open(t.id, "/members") },
            { label: tr("tenants.row.projects"), onClick: () => open(t.id, "/projects") },
            { label: tr("tenants.row.costs"), onClick: () => open(t.id, "/costs") },
          ]}
        />
      </td>
    </tr>
  );
}

export default function AdminTenantsPage() {
  const t = useT();
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
    (row) => !q || row.name.toLowerCase().includes(q) || row.slug.toLowerCase().includes(q),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("tenants.list.title")}
        description={t("tenants.list.description")}
        actions={<Button onClick={() => setCreating(true)}>{t("tenants.list.newClient")}</Button>}
      />
      <ErrorBox message={tenants.isError ? errorMessage(tenants.error) : null} />
      <Card flush>
        <Toolbar count={tenants.data ? t("tenants.list.count", { shown: visible.length, total: tenants.data.length }) : undefined}>
          <SearchInput value={search} onChange={setSearch} placeholder={t("tenants.list.filter")} />
        </Toolbar>
        {tenants.data?.length === 0 ? (
          <Empty
            title={t("tenants.list.emptyTitle")}
            icon="building"
            action={<Button onClick={() => setCreating(true)}>{t("tenants.list.newClient")}</Button>}
          >
            {t("tenants.list.emptyBody")}
          </Empty>
        ) : tenants.data && visible.length === 0 ? (
          <Empty title={t("tenants.list.noResultsTitle")}>{t("tenants.list.noResultsBody")}</Empty>
        ) : (
          <div className={tbl.wrap}>
            <table className={`${tbl.table} min-w-[64rem]`}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>{t("tenants.list.client")}</th>
                  <th className={tbl.th}>{t("tenants.list.status")}</th>
                  {COLUMNS.map((c) => (
                    <th key={c.resource} className={tbl.th}>
                      {t(c.label)}
                    </th>
                  ))}
                  <th className={tbl.th}>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {visible.map((row) => (
                  <TenantRow key={row.id} t={row} open={open} editQuotas={setEditing} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <NewTenantDialog open={creating} onClose={() => setCreating(false)} />
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={t("tenants.quotas.title", { name: editing?.name ?? "" })}>
        {editing && <QuotaEditor key={editing.id} tenantId={editing.id} onSaved={() => setEditing(null)} />}
      </Dialog>
    </div>
  );
}
