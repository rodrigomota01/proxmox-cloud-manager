"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button, Card, Empty, ErrorBox, Field, Input, Textarea, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";

export default function SshKeysPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ["ssh-keys"],
    queryFn: async () => unwrap(await api.GET("/api/v1/ssh-keys")),
  });
  const add = useMutation({
    mutationFn: async (body: { name: string; public_key: string }) =>
      unwrap(await api.POST("/api/v1/ssh-keys", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ssh-keys"] }),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE("/api/v1/ssh-keys/{key_id}", { params: { path: { key_id: id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ssh-keys"] }),
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    add.mutate(
      { name: String(form.get("name")), public_key: String(form.get("public_key")) },
      { onSuccess: () => formEl.reset() },
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">Chaves SSH</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Chaves <strong>públicas</strong> usadas para acessar as instâncias que você criar. Nunca cole a
        chave privada.
      </p>

      <Card title="Suas chaves">
        {keys.data?.length === 0 && <Empty>Nenhuma chave cadastrada.</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {keys.data?.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{k.name}</div>
                <div className="truncate font-mono text-xs text-slate-500">{k.fingerprint}</div>
                <div className="text-xs text-slate-500">Adicionada em {formatDate(k.created_at)}</div>
              </div>
              <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(k.id)}>
                Remover
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Adicionar chave">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Nome">
            <Input name="name" required maxLength={64} placeholder="notebook" />
          </Field>
          <Field label="Chave pública" hint="Conteúdo do arquivo .pub, ex.: ~/.ssh/id_ed25519.pub">
            <Textarea name="public_key" rows={3} required placeholder="ssh-ed25519 AAAA… voce@notebook" />
          </Field>
          <ErrorBox message={add.isError ? errorMessage(add.error) : null} />
          <Button type="submit" disabled={add.isPending}>
            Adicionar
          </Button>
        </form>
      </Card>
    </div>
  );
}
