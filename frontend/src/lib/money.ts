/** Money arrives from the API as decimal strings (never floats on the wire). */
export type Money = string | number;

const formatters = new Map<string, Intl.NumberFormat>();

export function money(value: Money | null | undefined, currency = "BRL", precise = false): string {
  if (value === null || value === undefined) return "—";
  const key = `${currency}:${precise}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("pt-BR", {
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

/** "2026-10" -> "outubro de 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

/** The current and the previous `count - 1` months, newest first ("YYYY-MM"). */
export function recentMonths(count = 12): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

export const RESOURCE_LABEL: Record<string, string> = {
  vcpu: "vCPU",
  memory_gb: "Memória (GiB)",
  disk_gb: "Disco (GiB)",
  instance: "Taxa por instância",
};
