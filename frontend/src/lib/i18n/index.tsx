"use client";

/**
 * Interface language. The user's choice is saved on the account (PATCH /me) and applied
 * once /me loads; before sign-in it comes from this browser (last choice, else its
 * language). `translate` also works outside React (API and sign-in error messages).
 */
import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { en } from "./en";
import { ptBR } from "./pt-BR";

export type Locale = "pt-BR" | "en";
export type Messages = typeof ptBR;

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;
export type Vars = Record<string, string | number>;

export const LOCALES: { value: Locale; label: string }[] = [
  { value: "pt-BR", label: "Português" },
  { value: "en", label: "English" },
];

const DICTS: Record<Locale, Messages> = { "pt-BR": ptBR, en };
const STORAGE_KEY = "cm.locale";

// module-level copy for code outside components; kept in sync by the provider
let current: Locale = "pt-BR";

/** For formatting outside components (dates, numbers, money). */
export function getLocale(): Locale {
  return current;
}

export function translate(key: MessageKey, vars?: Vars, locale: Locale = current): string {
  let node: unknown = DICTS[locale];
  for (const part of key.split(".")) node = (node as Record<string, unknown>)?.[part];
  const text = typeof node === "string" ? node : key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => String(vars[name] ?? m)) : text;
}

export function isLocale(value: unknown): value is Locale {
  return value === "pt-BR" || value === "en";
}

function browserLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* storage unavailable: fall back to the browser language */
  }
  return navigator.language?.toLowerCase().startsWith("en") ? "en" : "pt-BR";
}

type I18n = { locale: Locale; setLocale: (locale: Locale) => void };
const I18nContext = createContext<I18n>({ locale: "pt-BR", setLocale: () => undefined });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // the server render is always pt-BR; the browser's choice applies right after hydration
  const [locale, setState] = useState<Locale>("pt-BR");
  const setLocale = useCallback((next: Locale) => {
    current = next;
    setState(next);
    document.documentElement.lang = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* the choice still holds for this page */
    }
  }, []);
  useEffect(() => setLocale(browserLocale()), [setLocale]);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  // a switch remounts the interface, so every text and format follows (the query cache
  // lives above, and the session restores itself)
  return (
    <I18nContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

export function useLocale(): I18n {
  return useContext(I18nContext);
}

/** `t("nav.vms")`, `t("header.activeAlerts", { count: 3 })`; re-renders on a switch. */
export function useT(): (key: MessageKey, vars?: Vars) => string {
  const { locale } = useLocale();
  return useCallback((key: MessageKey, vars?: Vars) => translate(key, vars, locale), [locale]);
}
