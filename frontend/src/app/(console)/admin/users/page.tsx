"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, Dialog, Empty, ErrorBox, Field, Input, formatDate } from "@/components/ui";
import { UserStatus } from "@/components/user-status";
import { api, errorMessage, unwrap } from "@/lib/api/client";

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async (body: { email: string; display_name: string }) =>
      unwrap(await api.POST("/api/v1/admin/users", { body })),
    onSuccess: (user) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      router.push(`/admin/users/${user.id}`);
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Novo usuário">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          create.mutate({ email: String(form.get("email")), display_name: String(form.get("display_name")) });
        }}
        className="space-y-3"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          O usuário recebe por e-mail um link para definir a senha.
        </p>
        <Field label="E-mail">
          <Input name="email" type="email" required />
        </Field>
        <Field label="Nome">
          <Input name="display_name" required maxLength={100} />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Convidar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const users = useInfiniteQuery({
    queryKey: ["admin", "users", search],
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET("/api/v1/admin/users", {
          params: { query: { q: search || undefined, cursor: pageParam ?? undefined, limit: 50 } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
  });
  const items = users.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Usuários</h1>
        <div className="flex gap-2">
          <Input
            aria-label="Buscar"
            placeholder="Buscar por nome ou e-mail"
            className="w-64"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button onClick={() => setCreating(true)}>Novo usuário</Button>
        </div>
      </div>
      <ErrorBox message={users.isError ? errorMessage(users.error) : null} />
      <Card>
        {users.isSuccess && items.length === 0 && <Empty>Nenhum usuário encontrado.</Empty>}
        {items.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Nome</th>
                <th className="py-2 pr-4 font-medium">E-mail</th>
                <th className="py-2 pr-4 font-medium">Situação</th>
                <th className="py-2 font-medium">Último acesso</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((u) => (
                <tr key={u.id}>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {u.display_name}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{u.email}</td>
                  <td className="py-2 pr-4">
                    <UserStatus user={u} />
                  </td>
                  <td className="py-2">{formatDate(u.last_login_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {users.hasNextPage && (
          <div className="pt-4 text-center">
            <Button variant="secondary" onClick={() => users.fetchNextPage()}>
              Carregar mais
            </Button>
          </div>
        )}
      </Card>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
