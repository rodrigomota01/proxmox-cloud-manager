"use client";

/**
 * The guest's notes in Proxmox (the "description" of a VM). On servers whose Proxmox
 * predates tags, this is how people tell what a VM is for, so lists show its first line
 * next to the name, and the detail page shows all of it.
 */
export function GuestDescription({
  text,
  full = false,
  title,
  className = "",
}: {
  text: string | null | undefined;
  /** every line, as written (detail pages); otherwise the first line, clipped */
  full?: boolean;
  title?: string;
  className?: string;
}) {
  const value = text?.trim();
  if (!value) return full ? <span className="text-slate-400">—</span> : null;
  if (full) {
    return (
      <span className="block whitespace-pre-line break-words text-sm" title={title}>
        {value}
      </span>
    );
  }
  const [first, ...rest] = value.split(/\r?\n/).filter((l) => l.trim());
  return (
    <div
      className={`mt-0.5 max-w-xs truncate text-xs text-slate-600 dark:text-slate-400 ${className}`}
      title={title ? `${title}\n\n${value}` : value}
    >
      <span aria-hidden className="mr-1 text-slate-400">
        ¶
      </span>
      {first}
      {rest.length > 0 && <span className="text-slate-400"> …</span>}
    </div>
  );
}
