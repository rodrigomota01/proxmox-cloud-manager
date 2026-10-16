"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "@/components/page";
import { Button, Card, Empty, ErrorBox, Field, Input, Textarea, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useT } from "@/lib/i18n";

export default function SshKeysPage() {
  const t = useT();
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
    <>
      <PageHeader
        title={t("compute.sshKeys.title")}
        description={
          <>
            {t("compute.sshKeys.descBefore")}
            <strong>{t("compute.sshKeys.descStrong")}</strong>
            {t("compute.sshKeys.descAfter")}
          </>
        }
      />
      <div className="max-w-3xl space-y-4">

        <Card title={t("compute.sshKeys.yourKeys")}>
          {keys.data?.length === 0 && <Empty>{t("compute.sshKeys.empty")}</Empty>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {keys.data?.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">{k.name}</div>
                  <div className="truncate font-mono text-xs text-slate-500">{k.fingerprint}</div>
                  <div className="text-xs text-slate-500">{t("compute.sshKeys.addedOn", { date: formatDate(k.created_at) })}</div>
                </div>
                <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(k.id)}>
                  {t("compute.sshKeys.remove")}
                </Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card title={t("compute.sshKeys.addKey")}>
          <form onSubmit={submit} className="space-y-3">
            <Field label={t("compute.sshKeys.name")}>
              <Input name="name" required maxLength={64} placeholder={t("compute.sshKeys.namePlaceholder")} />
            </Field>
            <Field label={t("compute.sshKeys.publicKey")} hint={t("compute.sshKeys.publicKeyHint")}>
              <Textarea name="public_key" rows={3} required placeholder={t("compute.sshKeys.publicKeyPlaceholder")} />
            </Field>
            <ErrorBox message={add.isError ? errorMessage(add.error) : null} />
            <Button type="submit" disabled={add.isPending}>
              {t("compute.sshKeys.add")}
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
