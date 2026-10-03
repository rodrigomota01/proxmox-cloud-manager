"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, formatDate } from "@/components/ui";
import { UserStatus } from "@/components/user-status";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useSession } from "@/lib/session";

const PLATFORM_ROLES = [
  { name: "SUPER_ADMIN", label: "Super admin", hint: "Tudo, inclusive gerenciar administradores." },
  { name: "PLATFORM_ADMIN", label: "Admin da plataforma", hint: "Clusters, imagens, tenants, quotas, usuários." },
  { name: "READ_ONLY", label: "Somente leitura", hint: "Vê todos os tenants, não altera nada." },
];

type Detail = Schemas["AdminUserDetail"];

export default function AdminUserPage() {
  const { id } = useParams<{ id: string }>();
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

  return (
    <div className="max-w-4xl space-y-4">
      <Link href="/admin/users" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Usuários
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{u.display_name}</h1>
        <UserStatus user={u} />
        {u.platform_roles.map((r) => (
          <Badge key={r} tone="blue">
            {r}
          </Badge>
        ))}
      </div>

      {isSelf && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Esta é a sua conta. Para alterar seus dados ou senha, use{" "}
          <Link href="/perfil" className="underline">
            Meu perfil
          </Link>
          .
        </div>
      )}
      {message && !errors.length && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          {message}
        </div>
      )}
      {errors.map((m, i) => (
        <ErrorBox key={i} message={errorMessage(m.error)} />
      ))}

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
          <dl className="mb-4 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Último acesso</dt>
              <dd>{formatDate(u.last_login_at)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Sessões ativas</dt>
              <dd>{u.active_sessions}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Criado em</dt>
              <dd>{formatDate(u.created_at)}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            {u.is_active ? (
              <Button variant="danger" disabled={isSelf} onClick={() => setConfirmDeactivate(true)}>
                Desativar
              </Button>
            ) : (
              <Button disabled={isSelf} onClick={() => update.mutate({ is_active: true })}>
                Reativar
              </Button>
            )}
            {u.locked && (
              <Button variant="secondary" disabled={isSelf} onClick={() => unlock.mutate()}>
                Desbloquear
              </Button>
            )}
            <Button variant="secondary" disabled={isSelf || !u.is_active} onClick={() => reset.mutate()}>
              Enviar redefinição de senha
            </Button>
            <Button
              variant="secondary"
              disabled={isSelf || u.active_sessions === 0}
              onClick={() => revoke.mutate()}
            >
              Encerrar sessões
            </Button>
          </div>
        </Card>
      </div>

      <Card title="Papéis de plataforma">
        {!isSuperAdmin && (
          <p className="mb-3 text-sm text-slate-500">Só um super admin altera papéis de plataforma.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setMessage(null);
            const form = new FormData(e.currentTarget);
            roles.mutate(PLATFORM_ROLES.map((r) => r.name).filter((n) => form.get(n)));
          }}
          className="space-y-2"
        >
          {PLATFORM_ROLES.map((r) => (
            <label key={r.name} className="flex items-start gap-2 text-sm">
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
          <Button type="submit" variant="secondary" disabled={!isSuperAdmin || isSelf || roles.isPending}>
            Salvar papéis
          </Button>
        </form>
      </Card>

      <Card title="Tenants">
        {u.memberships.length === 0 ? (
          <Empty>Não é membro de nenhum tenant.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {u.memberships.map((m) => (
              <li key={m.tenant_id} className="py-2">
                {m.tenant_name} <span className="text-slate-500">({m.tenant_slug})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

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
