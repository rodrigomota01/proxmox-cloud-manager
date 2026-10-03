"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";

import { NoTenant } from "@/components/no-tenant";
import { PowerActions } from "@/components/power-actions";
import { DeleteInstance } from "@/components/delete-instance";
import { InstanceMetrics } from "@/components/metrics-panel";
import { DiskUsage } from "@/components/disk-usage";
import { Meter, mib, rate, uptime } from "@/components/viz";
import { ActivityRow } from "@/components/activity";
import { Badge, Card, Empty, ErrorBox, PowerBadge, StateBadge, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap } from "@/lib/api/client";
import { useProjectNames } from "@/lib/queries";
import { useSession } from "@/lib/session";

const BUSY = ["provisioning", "deleting"];

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
    // poll faster while a job is creating/deleting it
    refetchInterval: (q) => (q.state.data && BUSY.includes(q.state.data.state) ? 2_000 : 15_000),
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
            {i.state === "active" ? <PowerBadge state={i.power_state} /> : <StateBadge state={i.state} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PowerActions instance={i} />
            <DeleteInstance instance={i} />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Visão geral">
          <dl className="divide-y divide-slate-100 dark:divide-slate-800">
            <Row label="Tipo">{i.kind === "vm" ? "Máquina virtual" : "Container"}</Row>
            <Row label="Projeto">{projectNames.get(i.project_id) ?? "—"}</Row>
            <Row label="Região / zona">
              {i.region_name ? `${i.region_name} · ${i.zone_name}` : "—"}
            </Row>
            <Row label="vCPUs">{i.vcpus}</Row>
            {i.power_state === "running" && i.state === "active" && (
              <>
                <Row label="CPU agora">
                  <Meter value={i.cpu_usage} title="CPU" />
                </Row>
                <Row label="Memória agora">
                  <Meter
                    value={i.memory_mb ? i.memory_used_mb / i.memory_mb : 0}
                    label={`${mib(i.memory_used_mb)} / ${mib(i.memory_mb)}`}
                    title="Memória"
                  />
                </Row>
                <Row label="Disco usado">
                  <DiskUsage disk={i.disk} detailed />
                </Row>
                <Row label="Rede agora">
                  <span className="text-sm tabular-nums">
                    ↓ {rate(i.net_in_bps)} · ↑ {rate(i.net_out_bps)}
                  </span>
                </Row>
                <Row label="Ligada há">{uptime(i.uptime_seconds)}</Row>
              </>
            )}
            <Row label="Memória">{(i.memory_mb / 1024).toFixed(1)} GiB</Row>
            <Row label="Disco raiz">{i.root_disk_gb} GiB</Row>
            <Row label="IP">
              {i.ipv4 ? (
                <span className="font-mono">
                  {i.ipv4} <span className="text-slate-500">via {i.gateway}</span>
                </span>
              ) : (
                "—"
              )}
            </Row>
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

        <Card
          title="Histórico"
          actions={
            <Link href="/history" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
              Ver tudo
            </Link>
          }
        >
          {jobs.data?.length === 0 && <Empty>Nenhuma operação nesta instância.</Empty>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {jobs.data?.map((job) => (
              <ActivityRow key={job.id} job={job} showResource={false} />
            ))}
          </ul>
        </Card>
      </div>

      {i.state === "active" && tenantId && <InstanceMetrics instanceId={i.id} tenantId={tenantId} />}
    </div>
  );
}
