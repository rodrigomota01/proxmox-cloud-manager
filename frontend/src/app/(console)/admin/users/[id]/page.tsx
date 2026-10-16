"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { DescriptionList, Menu, PageHeader, ResourceIcon } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, formatDate, tbl } from "@/components/ui";
import { UserStatus } from "@/components/user-status";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";
import { useSession } from "@/lib/session";

const PLATFORM_ROLES: { name: string; label: MessageKey; hint: MessageKey }[] = [
  { name: "SUPER_ADMIN", label: "access.roles.superAdmin", hint: "access.user.superAdminHint" },
  { name: "PLATFORM_ADMIN", label: "access.roles.platformAdmin", hint: "access.user.platformAdminHint" },
  { name: "READ_ONLY", label: "access.roles.readOnly", hint: "access.user.readOnlyHint" },
];

type Detail = Schemas["AdminUserDetail"];

const TABS = [
  { key: "details", label: "access.user.tabDetails" },
  { key: "roles", label: "access.user.tabRoles" },
  { key: "tenants", label: "access.user.tabTenants" },
] as const satisfies readonly { key: string; label: MessageKey }[];
type Tab = (typeof TABS)[number]["key"];

const roleKey = (r: string) => PLATFORM_ROLES.find((p) => p.name === r)?.label;

export default function AdminUserPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.some((tb) => tb.key === params.get("tab")) ? (params.get("tab") as Tab) : "details";
  const { me } = useSession();
  const t = useT();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const isSelf = me.id === id;
  const isSuperAdmin = me.platform_roles.includes("SUPER_ADMIN");

  const user = useQuery({
    queryKey: ["admin", "user", id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/admin/users/{user_id}", { params: { path: { user_id: id } } })),
  });
  const refresh = (data?: Detail) => {
    if (data) queryClient.setQueryData(["admin", "user", id], data);
    else queryClient.invalidateQueries({ queryKey: ["admin", "user", id] });
    queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  const update = useMutation({
    mutationFn: async (body: Schemas["UserUpdate"]) =>
      unwrap(await api.PATCH("/api/v1/admin/users/{user_id}", { params: { path: { user_id: id } }, body })),
    onSuccess: (data) => {
      setMessage(t("access.common.saved"));
      refresh(data);
    },
  });
  const unlock = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/v1/admin/users/{user_id}/unlock", { params: { path: { user_id: id } } })),
    onSuccess: (data) => {
      setMessage(t("access.user.unlocked"));
      refresh(data);
    },
  });
  const reset = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/v1/admin/users/{user_id}/password-reset", { params: { path: { user_id: id } } }),
      ),
    onSuccess: () => setMessage(t("access.user.resetSent")),
  });
  const revoke = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/v1/admin/users/{user_id}/sessions/revoke", { params: { path: { user_id: id } } }),
      ),
    onSuccess: (r) => {
      setMessage(
        t(r.sessions_revoked === 1 ? "access.user.sessionsRevokedOne" : "access.user.sessionsRevokedOther", {
          count: r.sessions_revoked,
        }),
      );
      refresh();
    },
  });
  const roles = useMutation({
    mutationFn: async (list: string[]) =>
      unwrap(
        await api.PUT("/api/v1/admin/users/{user_id}/platform-roles", {
          params: { path: { user_id: id } },
          body: { roles: list },
        }),
      ),
    onSuccess: () => {
      setMessage(t("access.user.rolesUpdated"));
      refresh();
    },
  });

  const errors = [update, unlock, reset, revoke, roles].filter((m) => m.isError);
  const u = user.data;
  if (user.isError) return <ErrorBox message={errorMessage(user.error)} />;
  if (!u) return null;

  const tabs = TABS.map((tb) => ({
    key: tb.key,
    label: t(tb.label),
    ...(tb.key === "tenants" ? { count: u.memberships.length } : {}),
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: t("access.users.title"), href: "/admin/users" }, { label: u.display_name }]}
        kind="user"
        title={u.display_name}
        status={<UserStatus user={u} />}
        tabs={tabs}
        activeTab={tab}
        onTab={(k) => router.replace(k === "details" ? `/admin/users/${id}` : `/admin/users/${id}?tab=${k}`)}
        actions={
          <>
            {u.is_active ? (
              <Button variant="danger" disabled={isSelf} onClick={() => setConfirmDeactivate(true)}>
                {t("access.user.deactivate")}
              </Button>
            ) : (
              <Button disabled={isSelf} onClick={() => update.mutate({ is_active: true })}>
                {t("access.user.reactivate")}
              </Button>
            )}
            {!isSelf && (
              <Menu
                label={t("access.user.actions")}
                items={[
                  u.locked && { label: t("access.user.unlock"), onClick: () => unlock.mutate() },
                  { label: t("access.user.sendReset"), disabled: !u.is_active, onClick: () => reset.mutate() },
                  { label: t("access.user.revokeSessions"), disabled: u.active_sessions === 0, onClick: () => revoke.mutate() },
                ]}
              />
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span>{u.email}</span>
          {u.platform_roles.map((r) => (
            <Badge key={r} tone="brand">
              {roleKey(r) ? t(roleKey(r)!) : r}
            </Badge>
          ))}
        </div>
      </PageHeader>

      {isSelf && (
        <Alert variant="warning" title={t("access.user.selfTitle")}>
          {t("access.user.selfBefore")}{" "}
          <Link href="/perfil" className="font-medium underline">
            {t("access.user.selfLink")}
          </Link>
          .
        </Alert>
      )}
      {message && !errors.length && <Alert variant="success" title={message} />}
      {errors.map((m, i) => (
        <ErrorBox key={i} message={errorMessage(m.error)} />
      ))}

      {tab === "details" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t("access.user.dataCard")}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setMessage(null);
                const form = new FormData(e.currentTarget);
                update.mutate({
                  display_name: String(form.get("display_name")),
                  email: String(form.get("email")),
                });
              }}
              className="space-y-3"
            >
              <Field label={t("access.common.name")}>
                <Input name="display_name" required maxLength={100} defaultValue={u.display_name} disabled={isSelf} />
              </Field>
              <Field label={t("access.common.email")}>
                <Input name="email" type="email" required defaultValue={u.email} disabled={isSelf} />
              </Field>
              <Button type="submit" disabled={isSelf || update.isPending}>
                {t("access.common.save")}
              </Button>
            </form>
          </Card>

          <Card title={t("access.user.accessCard")}>
            <DescriptionList
              items={[
                [t("access.common.status"), <UserStatus key="s" user={u} />],
                [t("access.user.activeSessions"), u.active_sessions],
                [t("access.common.lastLogin"), formatDate(u.last_login_at)],
                [t("access.common.createdAt"), formatDate(u.created_at)],
                [t("access.user.locked"), u.locked ? t("access.user.lockedYes") : t("access.user.no")],
                [t("access.user.invitation"), u.invited ? t("access.user.invitationPending") : t("access.user.invitationAccepted")],
              ]}
            />
          </Card>
        </div>
      )}

      {tab === "roles" && (
        <Card title={t("access.user.platformRoles")} description={t("access.user.platformRolesDescription")}>
          {!isSuperAdmin && (
            <div className="mb-4">
              <Alert variant="info">{t("access.user.onlySuperAdmin")}</Alert>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(null);
              const form = new FormData(e.currentTarget);
              roles.mutate(PLATFORM_ROLES.map((r) => r.name).filter((n) => form.get(n)));
            }}
            className="space-y-3"
          >
            {PLATFORM_ROLES.map((r) => (
              <label
                key={r.name}
                className="flex items-start gap-3 rounded-md border border-slate-200 px-3 py-2.5 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
              >
                <input
                  type="checkbox"
                  name={r.name}
                  defaultChecked={u.platform_roles.includes(r.name)}
                  disabled={!isSuperAdmin || isSelf}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{t(r.label)}</span>
                  <span className="block text-xs text-slate-500">{t(r.hint)}</span>
                </span>
              </label>
            ))}
            <Button type="submit" disabled={!isSuperAdmin || isSelf || roles.isPending}>
              {t("access.user.saveRoles")}
            </Button>
          </form>
        </Card>
      )}

      {tab === "tenants" && (
        <Card flush>
          {u.memberships.length === 0 ? (
            <Empty title={t("access.user.noTenantsTitle")} icon="building">
              {t("access.user.noTenants")}
            </Empty>
          ) : (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>{t("access.user.tenant")}</th>
                    <th className={tbl.th}>{t("access.common.identifier")}</th>
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {u.memberships.map((m) => (
                    <tr key={m.tenant_id} className={tbl.tr}>
                      <td className={tbl.td}>
                        <span className="flex items-center gap-2">
                          <ResourceIcon kind="tenant" />
                          <span className="font-medium">{m.tenant_name}</span>
                        </span>
                      </td>
                      <td className={`${tbl.td} font-mono text-xs text-slate-500`}>{m.tenant_slug}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Dialog open={confirmDeactivate} onClose={() => setConfirmDeactivate(false)} title={t("access.user.deactivateTitle")}>
        <p className="text-sm">
          <strong>{u.display_name}</strong> {t("access.user.deactivateBody")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmDeactivate(false)}>
            {t("access.common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmDeactivate(false);
              setMessage(null);
              update.mutate({ is_active: false });
            }}
          >
            {t("access.user.deactivate")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
