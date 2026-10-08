"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Menu, PageHeader, SearchInput, Toolbar } from "@/components/page";
import { Button, Card, Dialog, Empty, ErrorBox, Field, Input, formatDate, tbl } from "@/components/ui";
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

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
    >
      {initials(name)}
    </span>
  );
}

export default function AdminUsersPage() {
  const router = useRouter();
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
      <PageHeader
        title="Usuários"
        description="Contas de todos os clientes e administradores da plataforma."
        actions={<Button onClick={() => setCreating(true)}>Novo usuário</Button>}
      />
      <ErrorBox message={users.isError ? errorMessage(users.error) : null} />
      <Card flush>
        <Toolbar count={users.isSuccess ? `${items.length}${users.hasNextPage ? "+" : ""} usuários` : undefined}>
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome ou e-mail…" className="w-72" />
        </Toolbar>
        {users.isSuccess && items.length === 0 && (
          <Empty title="Nenhum usuário encontrado" icon="users">
            {search ? "Nenhuma conta corresponde à busca." : "Convide o primeiro usuário."}
          </Empty>
        )}
        {items.length > 0 && (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>Nome</th>
                  <th className={tbl.th}>Situação</th>
                  <th className={tbl.th}>Último acesso</th>
                  <th className={tbl.th}>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {items.map((u) => (
                  <tr key={u.id} className={tbl.tr}>
                    <td className={tbl.td}>
                      <div className="flex items-center gap-3">
                        <Avatar name={u.display_name} />
                        <div className="min-w-0">
                          <Link href={`/admin/users/${u.id}`} className={tbl.link}>
                            {u.display_name}
                          </Link>
                          <div className="truncate text-xs text-slate-500">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className={tbl.td}>
                      <UserStatus user={u} />
                    </td>
                    <td className={`${tbl.td} whitespace-nowrap text-slate-600 dark:text-slate-400`}>
                      {formatDate(u.last_login_at)}
                    </td>
                    <td className={`${tbl.td} text-right`}>
                      <Menu
                        ariaLabel={`Ações de ${u.display_name}`}
                        items={[{ label: "Ver detalhes", onClick: () => router.push(`/admin/users/${u.id}`) }]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {users.hasNextPage && (
          <div className="border-t border-slate-200 py-3 text-center dark:border-slate-800">
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
