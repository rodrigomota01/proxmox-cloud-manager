"use client";

/**
 * Page chrome in the style of the OpenShift console: a white header band (breadcrumbs,
 * resource icon, title, status, actions, tabs) above the gray work area, list toolbars,
 * description lists and kebab menus.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/icons";

// --- resource icon ---------------------------------------------------------------------

const KINDS = {
  vm: { label: "VM", className: "bg-indigo-600" },
  container: { label: "CT", className: "bg-sky-600" },
  hypervisor: { label: "HV", className: "bg-slate-700 dark:bg-slate-600" },
  cluster: { label: "C", className: "bg-sky-700" },
  k8s: { label: "K8s", className: "bg-sky-600" },
  ns: { label: "NS", className: "bg-emerald-700" },
  tenant: { label: "CLI", className: "bg-indigo-800" },
  user: { label: "U", className: "bg-slate-600" },
  project: { label: "PR", className: "bg-indigo-500" },
} as const;
export type ResourceKind = keyof typeof KINDS;

/** Small colored tag naming the kind of resource, next to its name (like "VM", "NS"). */
export function ResourceIcon({ kind, className = "" }: { kind: ResourceKind; className?: string }) {
  const k = KINDS[kind];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold leading-none tracking-wide text-white ${k.className} ${className}`}
    >
      {k.label}
    </span>
  );
}

// --- header ----------------------------------------------------------------------------

export type Crumb = { label: string; href?: string };

export type TabItem<K extends string = string> = { key: K; label: string; count?: number };

/** Horizontal tabs with an indigo underline; the parent owns routing (usually ?tab=). */
export function Tabs<K extends string>({
  tabs,
  active,
  onChange,
  className = "",
}: {
  tabs: readonly TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  return (
    <nav className={`flex gap-1 overflow-x-auto ${className}`} aria-label="Seções">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          aria-current={active === t.key ? "page" : undefined}
          className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-[3px] px-3 pt-2 pb-2.5 text-sm transition-colors ${
            active === t.key
              ? "border-indigo-600 font-semibold text-slate-900 dark:border-indigo-400 dark:text-white"
              : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-100"
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="rounded-full bg-slate-100 px-1.5 text-xs font-medium tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {t.count}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

/**
 * Full-bleed header band of a page. Cancels the main area's padding (-mx-6 -mt-6) so it
 * touches the masthead and the sidebar.
 */
export function PageHeader<K extends string>({
  title,
  breadcrumbs,
  kind,
  status,
  description,
  actions,
  tabs,
  activeTab,
  onTab,
  children,
}: {
  title: React.ReactNode;
  breadcrumbs?: Crumb[];
  kind?: ResourceKind;
  status?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: readonly TabItem<K>[];
  activeTab?: K;
  onTab?: (key: K) => void;
  /** extra content under the title (meta line, scope toggle…) */
  children?: React.ReactNode;
}) {
  return (
    <header
      className={`-mx-4 -mt-6 mb-6 border-b border-slate-200 bg-white px-4 pt-4 sm:-mx-6 sm:px-6 dark:border-slate-800 dark:bg-slate-900 ${
        tabs ? "" : "pb-5"
      }`}
    >
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Navegação estrutural" className="mb-2 flex flex-wrap items-center gap-1 text-sm">
          {breadcrumbs.map((c, i) => (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && <Icon name="chevronRight" className="h-3.5 w-3.5 text-slate-400" />}
              {c.href ? (
                <Link href={c.href} className="text-indigo-600 hover:underline dark:text-indigo-400">
                  {c.label}
                </Link>
              ) : (
                <span className="text-slate-600 dark:text-slate-400">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1">
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold tracking-tight">
            {kind && <ResourceIcon kind={kind} className="h-6 min-w-6 text-[11px]" />}
            <span className="min-w-0 break-words">{title}</span>
            {status && <span className="text-base font-normal">{status}</span>}
          </h1>
          {description && <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">{description}</p>}
          {children}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && activeTab !== undefined && onTab && <Tabs tabs={tabs} active={activeTab} onChange={onTab} className="mt-4" />}
    </header>
  );
}

// --- list toolbar ----------------------------------------------------------------------

/** Filter row above a table (inside a flush Card). `count` shows on the right. */
export function Toolbar({ children, count }: { children?: React.ReactNode; count?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-5 pb-3 dark:border-slate-800">
      {children}
      {count !== undefined && <span className="ml-auto text-sm tabular-nums text-slate-500">{count}</span>}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Filtrar por nome…",
  className = "w-64",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{placeholder}</span>
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-slate-400">
        <Icon name="search" />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900"
      />
    </label>
  );
}

// --- description list ------------------------------------------------------------------

/** Label above value, in one or two columns (the console "Details" layout). */
export function DescriptionList({
  items,
  columns = 2,
}: {
  items: ([React.ReactNode, React.ReactNode] | false | null | undefined)[];
  columns?: 1 | 2 | 3;
}) {
  const cols = columns === 1 ? "" : columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3";
  return (
    <dl className={`grid gap-x-8 gap-y-4 ${cols}`}>
      {items.filter(Boolean).map((item, i) => {
        const [label, value] = item as [React.ReactNode, React.ReactNode];
        return (
          <div key={i} className="min-w-0">
            <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">{label}</dt>
            <dd className="mt-1 text-sm text-slate-700 dark:text-slate-300">{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// --- summary tiles ---------------------------------------------------------------------

/** Number tile with an optional icon and link (inventory card of the console overview). */
export function StatTile({
  label,
  value,
  hint,
  icon,
  href,
  tone,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: IconName;
  href?: string;
  tone?: "ok" | "warn" | "error";
}) {
  const toneColor =
    tone === "error"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-500 dark:text-amber-400"
        : tone === "ok"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-indigo-600 dark:text-indigo-400";
  const body = (
    <div className="flex items-start gap-3">
      {icon && (
        <span className={`mt-0.5 rounded-md bg-slate-100 p-2 dark:bg-slate-800 ${toneColor}`}>
          <Icon name={icon} className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0">
        <div className="text-sm text-slate-600 dark:text-slate-400">{label}</div>
        <div className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
      </div>
    </div>
  );
  const cls =
    "block rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900";
  return href ? (
    <Link href={href} className={`${cls} transition-colors hover:border-indigo-300 dark:hover:border-indigo-700`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// --- kebab / dropdown menu -------------------------------------------------------------

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; href?: never }
  | { label: string; href: string; danger?: boolean; disabled?: boolean; onClick?: never };

/** Dropdown of actions. Default trigger is a kebab (⋮); pass `label` for a text toggle. */
export function Menu({
  items,
  label,
  ariaLabel = "Ações",
  align = "right",
}: {
  items: (MenuItem | false | null | undefined)[];
  label?: React.ReactNode;
  ariaLabel?: string;
  align?: "left" | "right";
}) {
  // fixed position from the trigger's rect: tables scroll horizontally, and an absolute
  // panel inside them would be clipped
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const open = pos !== null;
  const ref = useRef<HTMLDivElement>(null);
  const setOpen = (on: boolean) => {
    const r = ref.current?.getBoundingClientRect();
    if (!on || !r) return setPos(null);
    setPos(
      align === "right"
        ? { top: r.bottom + 4, right: window.innerWidth - r.right }
        : { top: r.bottom + 4, left: r.left },
    );
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const list = items.filter(Boolean) as MenuItem[];
  if (!list.length) return null;
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ? undefined : ariaLabel}
        onClick={() => setOpen(!open)}
        className={
          label
            ? "inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            : "rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        }
      >
        {label ? (
          <>
            {label}
            <Icon name="chevronDown" className="h-3.5 w-3.5" />
          </>
        ) : (
          <Icon name="kebab" className="h-5 w-5" />
        )}
      </button>
      {open && (
        <div
          role="menu"
          style={pos}
          className="fixed z-40 min-w-48 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {list.map((item) => {
            const cls = `block w-full whitespace-nowrap px-4 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
              item.danger
                ? "text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            }`;
            return item.href ? (
              <Link key={item.label} role="menuitem" href={item.href} className={cls} onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cls}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
