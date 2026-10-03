"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";

import { NoTenant } from "@/components/no-tenant";
import { PowerActions } from "@/components/power-actions";
import { Badge, Card, Empty, ErrorBox, JobBadge, PowerBadge, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useProjectNames } from "@/lib/queries";
import { useSession } from "@/lib/session";

const ACTION_LABEL: Record<string, string> = {
  start: "Ligar",
  stop: "Forçar desligamento",
  shutdown: "Desligar",
  reboot: "Reiniciar",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2">{children}</dd>
    </div>
  );
}

export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { tenantId } = useSession();
  const projectNames = useProjectNames();

  const instance = useQuery({
    queryKey: ["instance", id, tenantId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/instances/{instance_id}", { params: { path: { instance_id: id } } })),
    enabled: tenantId !== null,
    refetchInterval: 15_000,
  });
  const jobs = useQuery({
    queryKey: ["jobs", tenantId, id],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/jobs", { params: { query: { resource_id: id, limit: 20 } } })).items,
    enabled: tenantId !== null,
    refetchInterval: 5_000,
  });

  if (!tenantId) return <NoTenant />;
  if (instance.isError) {
    return (
      <div className="space-y-4">
        <Link href="/instances" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          ← Instâncias
        </Link>
        <ErrorBox message={errorMessage(instance.error)} />
      </div>
    );
  }
  const i = instance.data;
  if (!i) return null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/instances" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          ← Instâncias
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">{i.name}</h1>
            <PowerBadge state={i.power_state} />
            {i.state !== "active" && <Badge tone="amber">{i.state}</Badge>}
          </div>
          <PowerActions instance={i} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Visão geral">
          <dl className="divide-y divide-slate-100 dark:divide-slate-800">
            <Row label="Tipo">{i.kind === "vm" ? "Máquina virtual" : "Container"}</Row>
            <Row label="Projeto">{projectNames.get(i.project_id) ?? "—"}</Row>
            <Row label="vCPUs">{i.vcpus}</Row>
            <Row label="Memória">{(i.memory_mb / 1024).toFixed(1)} GiB</Row>
            <Row label="Disco raiz">{i.root_disk_gb} GiB</Row>
            <Row label="Tags">
              {i.tags.length ? (
                <span className="flex flex-wrap gap-1">
                  {i.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </span>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Visto pela última vez">{formatDate(i.last_seen_at)}</Row>
          </dl>
        </Card>

        <Card title="Operações">
          {jobs.data?.length === 0 && <Empty>Nenhuma operação nesta instância.</Empty>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {jobs.data?.map((job) => {
              const action = String(job.payload.action ?? "");
              return (
                <li key={job.id} className="flex items-start justify-between gap-4 py-2 text-sm">
                  <div>
                    <div className="font-medium">
                      {ACTION_LABEL[action] ?? "Energia"}
                    </div>
                    <div className="text-xs text-slate-500">{formatDate(job.created_at)}</div>
                    {job.error_message && (
                      <div className="text-xs text-rose-600 dark:text-rose-400">{job.error_message}</div>
                    )}
                  </div>
                  <JobBadge status={job.status} />
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
