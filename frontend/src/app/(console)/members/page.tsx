"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { NoTenant } from "@/components/no-tenant";
import { Menu, PageHeader, SearchInput, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useProjectNames, useProjects } from "@/lib/queries";
import { useT } from "@/lib/i18n";
import { roleHint, roleLabel } from "@/lib/roles";
import { usePermissions, useSession } from "@/lib/session";

type Member = Schemas["MemberOut"];
const TENANT_SCOPE = "__tenant__";

function useRoles() {
  return useQuery({
    queryKey: ["roles"],
    queryFn: async () => unwrap(await api.GET("/api/v1/roles")),
    staleTime: 300_000,
  });
}

/** Scope (whole tenant or one project) + a role allowed at that scope. */
function AccessFields({ scope, setScope }: { scope: string; setScope: (s: string) => void }) {
  const projects = useProjects();
  const roles = useRoles();
  const t = useT();
  const kind = scope === TENANT_SCOPE ? "tenant" : "project";
  const options = (roles.data ?? []).filter((r) => r.allowed_scopes.includes(kind));
  return (
    <>
      <Field label={t("access.members.accessTo")}>
        <Select className="w-full" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value={TENANT_SCOPE}>{t("access.members.wholeTenant")}</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {t("access.members.projectOption", { name: p.name })}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("access.members.role")}>
        <Select name="role" className="w-full" required key={kind} defaultValue="">
          <option value="" disabled>
            {t("access.members.select")}
          </option>
          {options.map((r) => (
            <option key={r.name} value={r.name}>
              {roleLabel(r.name)} — {roleHint(r.name) ?? r.description}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

function InviteDialog({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState(TENANT_SCOPE);
  const [result, setResult] = useState<string | null>(null);
  const t = useT();
  const invite = useMutation({
    mutationFn: async (body: Schemas["MemberAdd"]) =>
      unwrap(await api.POST("/api/v1/tenants/{tenant_id}/members", { params: { path: { tenant_id: tenantId } }, body })),
    onSuccess: (res, body) => {
      queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
      setResult(
        res.invited
          ? t("access.members.invitedNew", { email: body.email })
          : t("access.members.invitedExisting", { email: body.email }),
      );
    },
  });
  const close = () => {
    setResult(null);
    invite.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={t("access.members.inviteTitle")}>
      {result ? (
        <div className="space-y-4 text-sm">
          <p>{result}</p>
          <div className="flex justify-end">
            <Button onClick={close}>{t("access.members.close")}</Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const name = String(f.get("display_name") ?? "").trim();
            invite.mutate({
              email: String(f.get("email")),
              role: String(f.get("role")),
              ...(name ? { display_name: name } : {}),
              ...(scope !== TENANT_SCOPE ? { project_id: scope } : {}),
            });
          }}
          className="space-y-3"
        >
          <Field label={t("access.common.email")}>
            <Input name="email" type="email" required />
          </Field>
          <Field label={t("access.members.nameForNew")}>
            <Input name="display_name" maxLength={100} />
          </Field>
          <AccessFields scope={scope} setScope={setScope} />
          <ErrorBox message={invite.isError ? errorMessage(invite.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              {t("access.common.cancel")}
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {t("access.common.invite")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function AddAccessDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const { tenantId } = useSession();
  const queryClient = useQueryClient();
  const t = useT();
  const [scope, setScope] = useState(TENANT_SCOPE);
  const add = useMutation({
    mutationFn: async (body: { user_id: string; role: string; project_id?: string }) =>
      unwrap(await api.POST("/api/v1/role-bindings", { body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
      onClose();
    },
  });
  return (
    <Dialog open={member !== null} onClose={onClose} title={t("access.members.addAccessTitle", { name: member?.display_name ?? "" })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          add.mutate({
            user_id: member!.user_id,
            role: String(f.get("role")),
            ...(scope !== TENANT_SCOPE ? { project_id: scope } : {}),
          });
        }}
        className="space-y-3"
      >
        <AccessFields scope={scope} setScope={setScope} />
        <ErrorBox message={add.isError ? errorMessage(add.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("access.common.cancel")}
          </Button>
          <Button type="submit" disabled={add.isPending}>
            {t("access.members.add")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function MembersPage() {
  const { tenantId, tenant, me } = useSession();
  const t = useT();
  const queryClient = useQueryClient();
  const perms = usePermissions(tenantId ? `tenant:${tenantId}` : null);
  const projectNames = useProjectNames();
  const [inviting, setInviting] = useState(false);
  const [adding, setAdding] = useState<Member | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);
  const [search, setSearch] = useState("");

  const members = useQuery({
    queryKey: ["members", tenantId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/tenants/{tenant_id}/members", { params: { path: { tenant_id: tenantId! } } })),
    enabled: tenantId !== null && perms.has("member:manage"),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
  const unbind = useMutation({
    mutationFn: async (bindingId: string) =>
      unwrap(await api.DELETE("/api/v1/role-bindings/{binding_id}", { params: { path: { binding_id: bindingId } } })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (userId: string) =>
      unwrap(
        await api.DELETE("/api/v1/tenants/{tenant_id}/members/{user_id}", {
          params: { path: { tenant_id: tenantId!, user_id: userId } },
        }),
      ),
    onSuccess: () => {
      setConfirmRemove(null);
      refresh();
    },
  });

  if (!tenantId) return <NoTenant />;
  if (perms.size > 0 && !perms.has("member:manage")) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("access.members.title")} />
        <Alert variant="info" title={t("access.members.noAccessTitle")}>
          {t("access.members.noAccess", { tenant: tenant?.name ?? "" })}
        </Alert>
      </div>
    );
  }
  const scopeLabel = (b: Schemas["BindingOut"]) =>
    b.scope_type === "tenant"
      ? t("access.members.scopeTenant")
      : t("access.members.scopeProject", { name: projectNames.get(b.scope_id) ?? "?" });
  const error = unbind.error ?? remove.error;

  const q = search.trim().toLowerCase();
  const visible = (members.data ?? []).filter(
    (m) => !q || m.display_name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("access.members.titleOf", { tenant: tenant?.name ?? "" })}
        description={t("access.members.description")}
        actions={<Button onClick={() => setInviting(true)}>{t("access.members.inviteMember")}</Button>}
      />
      <ErrorBox message={members.isError ? errorMessage(members.error) : error ? errorMessage(error) : null} />
      <Card flush>
        <Toolbar count={members.data ? t("access.members.count", { visible: visible.length, total: members.data.length }) : undefined}>
          <SearchInput value={search} onChange={setSearch} placeholder={t("access.members.filterPlaceholder")} />
        </Toolbar>
        {members.data?.length === 0 ? (
          <Empty
            title={t("access.members.emptyTitle")}
            icon="users"
            action={<Button onClick={() => setInviting(true)}>{t("access.members.inviteMember")}</Button>}
          >
            {t("access.members.empty")}
          </Empty>
        ) : members.data && visible.length === 0 ? (
          <Empty title={t("access.common.noResults")}>{t("access.members.noMatch")}</Empty>
        ) : (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>{t("access.members.member")}</th>
                  <th className={tbl.th}>{t("access.members.accesses")}</th>
                  <th className={tbl.th}>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {visible.map((m) => {
                  const self = m.user_id === me.id;
                  return (
                    <tr key={m.user_id} className={`${tbl.tr} align-top`}>
                      <td className={tbl.td}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{m.display_name}</span>
                          {self && <Badge tone="brand">{t("access.members.you")}</Badge>}
                          {m.invited && <Badge tone="amber">{t("access.members.invitePending")}</Badge>}
                        </div>
                        <div className="text-xs text-slate-500">{m.email}</div>
                      </td>
                      <td className={tbl.td}>
                        <ul className="flex flex-wrap gap-1.5">
                          {m.bindings.map((b) => (
                            <li
                              key={b.id}
                              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pr-1.5 pl-2.5 text-xs dark:border-slate-700 dark:bg-slate-800"
                            >
                              <span>
                                <strong>{roleLabel(b.role)}</strong> · {scopeLabel(b)}
                              </span>
                              {!self && (
                                <button
                                  aria-label={t("access.members.removeBindingLabel", { role: roleLabel(b.role), name: m.display_name })}
                                  title={t("access.members.removeBindingTitle")}
                                  className="rounded-full p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                                  disabled={unbind.isPending}
                                  onClick={() => unbind.mutate(b.id)}
                                >
                                  <Icon name="x" className="h-3 w-3" />
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className={`${tbl.td} text-right`}>
                        {!self && (
                          <Menu
                            ariaLabel={t("access.common.actionsFor", { name: m.display_name })}
                            items={[
                              { label: t("access.members.addAccess"), onClick: () => setAdding(m) },
                              { label: t("access.members.removeFromTenant"), danger: true, onClick: () => setConfirmRemove(m) },
                            ]}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <InviteDialog tenantId={tenantId} open={inviting} onClose={() => setInviting(false)} />
      <AddAccessDialog key={adding?.user_id ?? "none"} member={adding} onClose={() => setAdding(null)} />
      <Dialog open={confirmRemove !== null} onClose={() => setConfirmRemove(null)} title={t("access.members.removeTitle")}>
        <p className="text-sm">
          <strong>{confirmRemove?.display_name}</strong>{" "}
          {t("access.members.removeBody", { tenant: tenant?.name ?? "" })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
            {t("access.common.cancel")}
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(confirmRemove!.user_id)}>
            {t("access.common.remove")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
