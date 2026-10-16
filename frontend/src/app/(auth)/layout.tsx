"use client";

import { Logo } from "@/components/logo";
import { LOCALES, useLocale } from "@/lib/i18n";

/** Before sign-in the choice is kept in this browser; after it, the account's applies. */
function LanguageToggle() {
  const { locale, setLocale } = useLocale();
  return (
    <div className="mt-4 flex justify-center gap-3 text-xs text-slate-500">
      {LOCALES.map((l) => (
        <button
          key={l.value}
          type="button"
          onClick={() => setLocale(l.value)}
          aria-pressed={locale === l.value}
          className={locale === l.value ? "font-semibold text-slate-800 dark:text-slate-200" : "hover:underline"}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="flex justify-center">
            <Logo size="lg" />
          </h1>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {children}
        </div>
        <LanguageToggle />
      </div>
    </main>
  );
}
