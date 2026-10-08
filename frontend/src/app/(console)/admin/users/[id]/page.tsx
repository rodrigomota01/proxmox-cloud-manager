"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { DescriptionList, Menu, PageHeader, ResourceIcon } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, formatDate, tbl } from "@/components/ui";
import { UserStatus } from "@/components/user-status";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useSession } from "@/lib/session";

const PLATFORM_ROLES = [
  { name: "SUPER_ADMIN", label: "Super admin", hint: "Tudo, inclusive gerenciar administradores." },
  { name: "PLATFORM_ADMIN", label: "Admin da plataforma", hint: "Clusters, imagens, tenants, quotas, usuários." },
  { name: "READ_ONLY", label: "Somente leitura", hint: "Vê todos os tenants, não altera nada." },
];

type Detail = Schemas["AdminUserDetail"];

const TABS = [
  { key: "details", label: "Detalhes" },
  { key: "roles", label: "Papéis" },
  { key: "tenants", label: "Clientes" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const roleName = (r: string) => PLATFORM_ROLES.find((p) => p.name === r)?.label ?? r;

export default function AdminUserPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.some((t) => t.key === params.get("tab")) ? (params.get("tab") as Tab) : "details";
  const { me } = useSession();
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
      setMessage("Salvo.");
      refresh(data);
    },
  });
  const unlock = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/v1/admin/users/{user_id}/unlock", { params: { path: { user_id: id } } })),
    onSuccess: (data) => {
      setMessage("Desbloqueado.");
      refresh(data);
    },
  });
  const reset = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/v1/admin/users/{user_id}/password-reset", { params: { path: { user_id: id } } }),
      ),
    onSuccess: () => setMessage("Link de redefinição enviado por e-mail."),
  });
  const revoke = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/v1/admin/users/{user_id}/sessions/revoke", { params: { path: { user_id: id } } }),
      ),
    onSuccess: (r) => {
      setMessage(`${r.sessions_revoked} sessão(ões) encerrada(s).`);
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
      setMessage("Papéis atualizados.");
      refresh();
    },
  });

  const errors = [update, unlock, reset, revoke, roles].filter((m) => m.isError);
  const u = user.data;
  if (user.isError) return <ErrorBox message={errorMessage(user.error)} />;
  if (!u) return null;

  const tabs = TABS.map((t) => (t.key === "tenants" ? { ...t, count: u.memberships.length } : t));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "Usuários", href: "/admin/users" }, { label: u.display_name }]}
        kind="user"
        title={u.display_name}
        status={<UserStatus user={u} />}
        tabs={tabs}
        activeTab={tab}
        onTab={(t) => router.replace(t === "details" ? `/admin/users/${id}` : `/admin/users/${id}?tab=${t}`)}
        actions={
          <>
            {u.is_active ? (
              <Button variant="danger" disabled={isSelf} onClick={() => setConfirmDeactivate(true)}>
                Desativar
              </Button>
            ) : (
              <Button disabled={isSelf} onClick={() => update.mutate({ is_active: true })}>
                Reativar
              </Button>
            )}
            {!isSelf && (
              <Menu
                label="Ações"
                items={[
                  u.locked && { label: "Desbloquear", onClick: () => unlock.mutate() },
                  { label: "Enviar redefinição de senha", disabled: !u.is_active, onClick: () => reset.mutate() },
                  { label: "Encerrar sessões", disabled: u.active_sessions === 0, onClick: () => revoke.mutate() },
                ]}
              />
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span>{u.email}</span>
          {u.platform_roles.map((r) => (
            <Badge key={r} tone="indigo">
              {roleName(r)}
            </Badge>
          ))}
        </div>
      </PageHeader>

      {isSelf && (
        <Alert variant="warning" title="Esta é a sua conta">
          Para alterar seus dados ou senha, use{" "}
          <Link href="/perfil" className="font-medium underline">
            Meu perfil
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
          <Card title="Dados">
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
              <Field label="Nome">
                <Input name="display_name" required maxLength={100} defaultValue={u.display_name} disabled={isSelf} />
              </Field>
              <Field label="E-mail">
                <Input name="email" type="email" required defaultValue={u.email} disabled={isSelf} />
              </Field>
              <Button type="submit" disabled={isSelf || update.isPending}>
                Salvar
              </Button>
            </form>
          </Card>

          <Card title="Acesso">
            <DescriptionList
              items={[
                ["Situação", <UserStatus key="s" user={u} />],
                ["Sessões ativas", u.active_sessions],
                ["Último acesso", formatDate(u.last_login_at)],
                ["Criado em", formatDate(u.created_at)],
                ["Bloqueado", u.locked ? "Sim (excesso de tentativas)" : "Não"],
                ["Convite", u.invited ? "Pendente: ainda não definiu a senha" : "Aceito"],
              ]}
            />
          </Card>
        </div>
      )}

      {tab === "roles" && (
        <Card title="Papéis de plataforma" description="Valem em toda a plataforma, acima dos papéis de cada cliente.">
          {!isSuperAdmin && (
            <div className="mb-4">
              <Alert variant="info">Só um super admin altera papéis de plataforma.</Alert>
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
                  <span className="font-medium">{r.label}</span>
                  <span className="block text-xs text-slate-500">{r.hint}</span>
                </span>
              </label>
            ))}
            <Button type="submit" disabled={!isSuperAdmin || isSelf || roles.isPending}>
              Salvar papéis
            </Button>
          </form>
        </Card>
      )}

      {tab === "tenants" && (
        <Card flush>
          {u.memberships.length === 0 ? (
            <Empty title="Sem clientes" icon="building">
              Não é membro de nenhum cliente.
            </Empty>
          ) : (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>Cliente</th>
                    <th className={tbl.th}>Identificador</th>
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

      <Dialog open={confirmDeactivate} onClose={() => setConfirmDeactivate(false)} title="Desativar usuário">
        <p className="text-sm">
          <strong>{u.display_name}</strong> perde o acesso imediatamente: todas as sessões são encerradas e o
          login passa a ser recusado. Dá para reativar depois.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmDeactivate(false)}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmDeactivate(false);
              setMessage(null);
              update.mutate({ is_active: false });
            }}
          >
            Desativar
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
