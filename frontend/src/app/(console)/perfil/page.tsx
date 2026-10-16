"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { PageHeader } from "@/components/page";
import { Badge, Button, Card, ErrorBox, Field, Input, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";

function ProfileCard() {
  const { me } = useSession();
  const t = useT();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: async (display_name: string) =>
      unwrap(await api.PATCH("/api/v1/me", { body: { display_name } })),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <Card title={t("access.profile.data")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate(String(new FormData(e.currentTarget).get("display_name")));
        }}
        className="space-y-3"
      >
        <Field label={t("access.common.email")} hint={t("access.profile.emailHint")}>
          <Input value={me.email} disabled readOnly />
        </Field>
        <Field label={t("access.common.name")}>
          <Input name="display_name" required maxLength={100} defaultValue={me.display_name} />
        </Field>
        <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {t("access.common.save")}
          </Button>
          {saved && <span className="text-sm text-emerald-600">{t("access.common.saved")}</span>}
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const queryClient = useQueryClient();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: async (body: { current_password: string; new_password: string }) =>
      unwrap(await api.POST("/api/v1/me/password", { body })),
    onSuccess: () => {
      setDone(true);
      queryClient.invalidateQueries({ queryKey: ["my-sessions"] });
    },
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setDone(false);
    setError(null);
    if (form.get("new_password") !== form.get("confirm")) {
      setError(t("access.profile.passwordsDiffer"));
      return;
    }
    change.mutate(
      {
        current_password: String(form.get("current_password")),
        new_password: String(form.get("new_password")),
      },
      { onSuccess: () => formEl.reset() },
    );
  }

  return (
    <Card title={t("access.profile.changePassword")}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t("access.profile.currentPassword")}>
          <Input name="current_password" type="password" autoComplete="current-password" required />
        </Field>
        <Field label={t("access.profile.newPassword")} hint={t("access.profile.newPasswordHint")}>
          <Input name="new_password" type="password" autoComplete="new-password" minLength={12} required />
        </Field>
        <Field label={t("access.profile.repeatPassword")}>
          <Input name="confirm" type="password" autoComplete="new-password" minLength={12} required />
        </Field>
        <ErrorBox message={error ?? (change.isError ? errorMessage(change.error) : null)} />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={change.isPending}>
            {t("access.profile.changePassword")}
          </Button>
          {done && (
            <span className="text-sm text-emerald-600">
              {t("access.profile.passwordChanged")}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const t = useT();
  const sessions = useQuery({
    queryKey: ["my-sessions"],
    queryFn: async () => unwrap(await api.GET("/api/v1/me/sessions")),
  });
  const revoke = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE("/api/v1/me/sessions/{session_id}", { params: { path: { session_id: id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-sessions"] }),
  });
  return (
    <Card title={t("access.profile.sessions")}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-4 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{s.ip ?? "—"}</span>
                {s.current && <Badge tone="green">{t("access.profile.thisSession")}</Badge>}
              </div>
              <div className="truncate text-xs text-slate-500">{s.user_agent ?? "—"}</div>
              <div className="text-xs text-slate-500">
                {t("access.profile.sessionTimes", {
                  created: formatDate(s.created_at),
                  lastSeen: formatDate(s.last_seen_at),
                })}
              </div>
            </div>
            {!s.current && (
              <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>
                {t("access.profile.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox message={revoke.isError ? errorMessage(revoke.error) : null} />
    </Card>
  );
}

export default function ProfilePage() {
  const t = useT();
  return (
    <>
      <PageHeader title={t("access.profile.title")} description={t("access.profile.description")} />
      <div className="max-w-3xl space-y-4">
        <ProfileCard />
        <PasswordCard />
        <SessionsCard />
      </div>
    </>
  );
}
