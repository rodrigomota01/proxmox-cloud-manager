import { ApiStatus } from "./api-status";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
      <div>
        <h1 className="text-2xl font-semibold">Cloud Manager</h1>
        <p className="mt-1 text-slate-600 dark:text-slate-400">
          Fase 0 — esqueleto. Login, tenants e inventário do Proxmox chegam na Fase 1.
        </p>
      </div>
      <ApiStatus />
    </main>
  );
}
