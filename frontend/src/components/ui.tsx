"use client";

/** Small UI primitives (Tailwind). Kept local instead of a component library. */
import { useEffect, useRef } from "react";

import { Icon, type IconName } from "@/components/icons";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "link";

const variants: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 disabled:bg-indigo-400",
  secondary:
    "border border-slate-300 bg-white text-slate-800 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
  danger: "bg-rose-600 text-white hover:bg-rose-500 disabled:bg-rose-400",
  ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  link: "!px-0 text-indigo-600 hover:underline dark:text-indigo-400",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 ${className}`}
      {...props}
    />
  );
}

export function Textarea({
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
  flush = false,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** no body padding: for tables and toolbars that run edge to edge */
  flush?: boolean;
}) {
  return (
    <section
      className={`rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-1">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "pt-2" : "px-5 pt-3 pb-5"}>{children}</div>
    </section>
  );
}

const tones = {
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  red: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof tones; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export type StatusTone = "ok" | "off" | "warn" | "error" | "progress" | "unknown" | "info";

const statusStyle: Record<StatusTone, { icon: IconName; color: string }> = {
  ok: { icon: "checkCircle", color: "text-emerald-600 dark:text-emerald-400" },
  off: { icon: "minusCircle", color: "text-slate-400 dark:text-slate-500" },
  warn: { icon: "warning", color: "text-amber-500 dark:text-amber-400" },
  error: { icon: "xCircle", color: "text-rose-600 dark:text-rose-400" },
  progress: { icon: "loader", color: "text-sky-600 dark:text-sky-400" },
  unknown: { icon: "helpCircle", color: "text-slate-400 dark:text-slate-500" },
  info: { icon: "info", color: "text-sky-600 dark:text-sky-400" },
};

/** Console-style status: colored icon + plain text (color is never the only signal). */
export function Status({
  tone,
  children,
  icon,
  title,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  icon?: IconName;
  title?: string;
}) {
  const st = statusStyle[tone];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm" title={title}>
      <span className={st.color}>
        <Icon name={icon ?? st.icon} className={`h-4 w-4 ${tone === "progress" ? "animate-spin" : ""}`} />
      </span>
      {children}
    </span>
  );
}

const power: Record<string, [StatusTone, string, IconName?]> = {
  running: ["ok", "Ligada"],
  stopped: ["off", "Desligada"],
  paused: ["warn", "Pausada", "pauseCircle"],
  unknown: ["unknown", "Desconhecido"],
};

export function PowerBadge({ state }: { state: string }) {
  const [tone, label, icon] = power[state] ?? ["unknown", state];
  return (
    <Status tone={tone} icon={icon}>
      {label}
    </Status>
  );
}

const lifecycle: Record<string, [StatusTone, string]> = {
  provisioning: ["progress", "Criando…"],
  deleting: ["progress", "Excluindo…"],
  error: ["error", "Erro"],
  active: ["ok", "Ativa"],
};

export function StateBadge({ state }: { state: string }) {
  const [tone, label] = lifecycle[state] ?? ["unknown", state];
  return <Status tone={tone}>{label}</Status>;
}

const job: Record<string, [StatusTone, string, IconName?]> = {
  pending: ["info", "Na fila", "history"],
  running: ["progress", "Executando"],
  succeeded: ["ok", "Concluído"],
  failed: ["error", "Falhou"],
  cancelled: ["off", "Cancelado"],
};

export function JobBadge({ status }: { status: string }) {
  const [tone, label, icon] = job[status] ?? ["unknown", status];
  return (
    <Status tone={tone} icon={icon}>
      {label}
    </Status>
  );
}

const alertStyle = {
  info: { icon: "info", box: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100", ic: "text-sky-600 dark:text-sky-400" },
  success: { icon: "checkCircle", box: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100", ic: "text-emerald-600 dark:text-emerald-400" },
  warning: { icon: "warning", box: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100", ic: "text-amber-500 dark:text-amber-400" },
  danger: { icon: "xCircle", box: "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-100", ic: "text-rose-600 dark:text-rose-400" },
} as const;

/** Inline alert with a colored top border and icon. */
export function Alert({
  variant = "info",
  title,
  children,
  actions,
}: {
  variant?: keyof typeof alertStyle;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const st = alertStyle[variant];
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      className={`flex gap-3 rounded-md border border-t-[3px] px-4 py-3 text-sm ${st.box}`}
    >
      <span className={`mt-0.5 ${st.ic}`}>
        <Icon name={st.icon} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div>{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-start gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorBox({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <Alert variant="danger">{message}</Alert>;
}

/** Empty state: icon, a sentence, and optionally what to do next. */
export function Empty({
  children,
  title,
  icon = "search",
  action,
}: {
  children?: React.ReactNode;
  title?: React.ReactNode;
  icon?: IconName;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <span className="text-slate-300 dark:text-slate-600">
        <Icon name={icon} className="h-10 w-10" />
      </span>
      {title && <div className="text-base font-semibold">{title}</div>}
      {children && <p className="max-w-md text-sm text-slate-500">{children}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/** Class names for console tables (use inside a flush Card). */
export const tbl = {
  wrap: "overflow-x-auto",
  table: "w-full text-left text-sm",
  thead: "border-b border-slate-200 text-xs font-semibold text-slate-600 dark:border-slate-800 dark:text-slate-300",
  th: "whitespace-nowrap px-4 py-3 font-semibold first:pl-5 last:pr-5",
  tbody: "divide-y divide-slate-100 dark:divide-slate-800",
  tr: "align-middle hover:bg-slate-50 dark:hover:bg-slate-800/40",
  td: "px-4 py-3 first:pl-5 last:pr-5",
  link: "font-medium text-indigo-600 hover:underline dark:text-indigo-400",
};

export function Spinner() {
  return (
    <span
      aria-label="carregando"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}

/** Native <dialog>: focus trapping and Esc handling come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/40 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="px-5 pb-5">{children}</div>
    </dialog>
  );
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
}
