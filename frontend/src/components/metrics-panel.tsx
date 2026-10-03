"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card, ErrorBox } from "@/components/ui";
import { RangePicker, TimeSeriesChart, mib, pct, rate, type Range } from "@/components/viz";
import { api, errorMessage, unwrap } from "@/lib/api/client";

const REFRESH: Record<Range, number> = { hour: 30_000, day: 300_000, week: 300_000 };

function Panel({
  title,
  range,
  setRange,
  error,
  children,
}: {
  title: string;
  range: Range;
  setRange: (r: Range) => void;
  error: unknown;
  children: React.ReactNode;
}) {
  return (
    <Card title={title} actions={<RangePicker value={range} onChange={setRange} />}>
      <ErrorBox message={error ? errorMessage(error) : null} />
      <div className="grid gap-6 md:grid-cols-2">{children}</div>
    </Card>
  );
}

/** CPU, memory, network and disk of one instance, from the provider's own history. */
export function InstanceMetrics({ instanceId, tenantId }: { instanceId: string; tenantId: string }) {
  const [range, setRange] = useState<Range>("hour");
  const q = useQuery({
    queryKey: ["metrics", tenantId, instanceId, range],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/instances/{instance_id}/metrics", {
          params: { path: { instance_id: instanceId }, query: { range } },
        }),
      ),
    refetchInterval: REFRESH[range],
  });
  const p = q.data?.points ?? [];
  const t = p.map((x) => x.t);
  const memTotal = Math.max(0, ...p.map((x) => x.memory_total_mb));
  return (
    <Panel title="Métricas" range={range} setRange={setRange} error={q.error}>
      <TimeSeriesChart
        title="CPU"
        range={range}
        times={t}
        yMax={1}
        format={pct}
        series={[{ name: "CPU", values: p.map((x) => x.cpu), color: "var(--viz-series-1)" }]}
      />
      <TimeSeriesChart
        title={`Memória${memTotal ? ` (de ${mib(memTotal)})` : ""}`}
        range={range}
        times={t}
        yMax={memTotal || undefined}
        format={mib}
        series={[{ name: "Em uso", values: p.map((x) => x.memory_used_mb), color: "var(--viz-series-1)" }]}
      />
      <TimeSeriesChart
        title="Rede"
        range={range}
        times={t}
        format={rate}
        series={[
          { name: "Entrada", values: p.map((x) => x.net_in_bps), color: "var(--viz-series-1)" },
          { name: "Saída", values: p.map((x) => x.net_out_bps), color: "var(--viz-series-2)" },
        ]}
      />
      <TimeSeriesChart
        title="Disco"
        range={range}
        times={t}
        format={rate}
        series={[
          { name: "Leitura", values: p.map((x) => x.disk_read_bps), color: "var(--viz-series-1)" },
          { name: "Escrita", values: p.map((x) => x.disk_write_bps), color: "var(--viz-series-2)" },
        ]}
      />
    </Panel>
  );
}

/** A hypervisor's CPU, memory, network and load. */
export function NodeMetrics({ nodeId }: { nodeId: string }) {
  const [range, setRange] = useState<Range>("hour");
  const q = useQuery({
    queryKey: ["admin", "node-metrics", nodeId, range],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/admin/nodes/{node_id}/metrics", {
          params: { path: { node_id: nodeId }, query: { range } },
        }),
      ),
    refetchInterval: REFRESH[range],
  });
  const p = q.data?.points ?? [];
  const t = p.map((x) => x.t);
  const memTotal = Math.max(0, ...p.map((x) => x.memory_total_mb));
  return (
    <Panel title="Métricas do hypervisor" range={range} setRange={setRange} error={q.error}>
      <TimeSeriesChart
        title="CPU"
        range={range}
        times={t}
        yMax={1}
        format={pct}
        series={[{ name: "CPU", values: p.map((x) => x.cpu), color: "var(--viz-series-1)" }]}
      />
      <TimeSeriesChart
        title={`Memória${memTotal ? ` (de ${mib(memTotal)})` : ""}`}
        range={range}
        times={t}
        yMax={memTotal || undefined}
        format={mib}
        series={[{ name: "Em uso", values: p.map((x) => x.memory_used_mb), color: "var(--viz-series-1)" }]}
      />
      <TimeSeriesChart
        title="Rede"
        range={range}
        times={t}
        format={rate}
        series={[
          { name: "Entrada", values: p.map((x) => x.net_in_bps), color: "var(--viz-series-1)" },
          { name: "Saída", values: p.map((x) => x.net_out_bps), color: "var(--viz-series-2)" },
        ]}
      />
      <TimeSeriesChart
        title="Load (1 min)"
        range={range}
        times={t}
        format={(v) => v.toFixed(1)}
        series={[{ name: "Load", values: p.map((x) => x.load), color: "var(--viz-series-1)" }]}
      />
    </Panel>
  );
}
