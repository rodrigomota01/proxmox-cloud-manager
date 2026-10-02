"use client";

import { useEffect, useState } from "react";

type Readiness = { status: string; checks?: Record<string, string> };

export function ApiStatus() {
  const [state, setState] = useState<Readiness | { status: "loading" | "unreachable" }>({
    status: "loading",
  });

  useEffect(() => {
    // Same origin: the edge routes /api to the backend, so no CORS and no absolute URL.
    fetch("/api/readyz", { cache: "no-store" })
      .then((r) => r.json() as Promise<Readiness>)
      .then(setState)
      .catch(() => setState({ status: "unreachable" }));
  }, []);

  const checks = "checks" in state && state.checks ? Object.entries(state.checks) : [];
  const ok = state.status === "ready";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className={`h-2.5 w-2.5 rounded-full ${ok ? "bg-emerald-500" : state.status === "loading" ? "bg-slate-400" : "bg-amber-500"}`} />
        API: {state.status}
      </div>
      {checks.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-400">
          {checks.map(([name, value]) => (
            <li key={name}>
              {name}: {value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
