/** Money arrives from the API as decimal strings (never floats on the wire). */
export type Money = string | number;

import { getLocale, translate, type MessageKey } from "@/lib/i18n";

const formatters = new Map<string, Intl.NumberFormat>();

export function money(value: Money | null | undefined, currency = "BRL", precise = false): string {
  if (value === null || value === undefined) return "—";
  const key = `${getLocale()}:${currency}:${precise}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(getLocale(), {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: precise ? 4 : 2,
    });
    formatters.set(key, f);
  }
  return f.format(Number(value));
}

export const num = (value: Money | null | undefined) => Number(value ?? 0);

/** "2026-10" -> "outubro de 2026" / "October 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(getLocale(), { month: "long", year: "numeric" });
}

/** The current and the previous `count - 1` months, newest first ("YYYY-MM"). */
export function recentMonths(count = 12): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

export const RESOURCE_LABEL: Record<string, MessageKey> = {
  vcpu: "costs.resources.vcpu",
  memory_gb: "costs.resources.memoryGb",
  disk_gb: "costs.resources.diskGb",
  instance: "costs.resources.instance",
};

/** Label of a priced resource in the current language (call during render). */
export function resourceLabel(resource: string): string {
  const key = RESOURCE_LABEL[resource];
  return key ? translate(key) : resource;
}
