"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Field, Input } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const email = String(new FormData(e.currentTarget).get("email"));
    // the API answers 202 whether or not the address exists
    await fetch("/api/v1/auth/password/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => undefined);
    setBusy(false);
    setSent(true);
  }

  if (sent) {
    return (
      <div className="space-y-4 text-sm">
        <p>Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.</p>
        <Link href="/login" className="text-indigo-600 hover:underline dark:text-indigo-400">
          Voltar ao login
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="E-mail">
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Button type="submit" className="w-full" disabled={busy}>
        Enviar link
      </Button>
      <p className="text-center text-sm">
        <Link href="/login" className="text-indigo-600 hover:underline dark:text-indigo-400">
          Voltar ao login
        </Link>
      </p>
    </form>
  );
}
