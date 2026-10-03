"use client";

/** Password reset and invitation links land here: /reset-password#token=... */
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, ErrorBox, Field, Input } from "@/components/ui";

export default function ResetPasswordPage() {
  // undefined: not read yet; null: no token in the link
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // the token travels in the fragment, so it never reaches servers or logs;
    // drop it from the address bar once read
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(value);
    if (value) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError("As senhas não conferem.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, new_password: password }),
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else if (res.status === 422) setError("A senha precisa ter pelo menos 12 caracteres.");
    else setError("Link inválido ou expirado. Peça um novo.");
  }

  if (done) {
    return (
      <div className="space-y-4 text-sm">
        <p>Senha definida. Você já pode entrar.</p>
        <Link href="/login" className="text-indigo-600 hover:underline dark:text-indigo-400">
          Ir para o login
        </Link>
      </div>
    );
  }
  if (token === undefined) return null;
  if (token === null) {
    return <p className="text-sm text-slate-500">Link inválido: abra o link recebido por e-mail.</p>;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Nova senha" hint="Mínimo de 12 caracteres.">
        <Input name="password" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <Field label="Repita a senha">
        <Input name="confirm" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <ErrorBox message={error} />
      <Button type="submit" className="w-full" disabled={busy}>
        Definir senha
      </Button>
    </form>
  );
}
