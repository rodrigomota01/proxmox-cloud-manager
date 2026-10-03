"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { relativeTime } from "@/components/activity";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Spinner, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useJob } from "@/lib/jobs";

type Alert = Schemas["AlertOut"] & Partial<Pick<Schemas["AdminAlertOut"], "tenant_name">>;
type Rule = Schemas["AlertRuleOut"];
type Channel = Schemas["ChannelOut"];
type Mode = "tenant" | "platform";

export const METRIC_LABEL: Record<string, string> = {
  cpu: "CPU",
  memory: "Memória",
  disk: "Disco",
  net_in: "Rede (entrada)",
  net_out: "Rede (saída)",
};
export const TARGET_LABEL: Record<string, string> = { instance: "VM", node: "Hypervisor", storage: "Storage" };
const TARGET_METRICS: Record<string, string[]> = {
  instance: ["cpu", "memory", "disk", "net_in", "net_out"],
  node: ["cpu", "memory", "net_in", "net_out"],
  storage: ["disk"],
};
const isRatio = (metric: string) => ["cpu", "memory", "disk"].includes(metric);
const MBIT = 125_000; // bytes/s in one Mbit/s

/** Ratios as %, network rates as Mbit/s (how thresholds are typed in the forms too). */
export function formatMetric(metric: string, value: number): string {
  return isRatio(metric) ? `${(value * 100).toFixed(0)}%` : `${(value / MBIT).toFixed(1)} Mbit/s`;
}
const toInput = (metric: string, value: number) => (isRatio(metric) ? value * 100 : value / MBIT);
const fromInput = (metric: string, value: number) => (isRatio(metric) ? value / 100 : value * MBIT);
const unit = (metric: string) => (isRatio(metric) ? "%" : "Mbit/s");

function duration(seconds: number): string {
  if (!seconds) return "imediato";
  return seconds % 60 ? `${seconds} s` : `${seconds / 60} min`;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return severity === "critical" ? (
    <Badge tone="red">⚠ crítico</Badge>
  ) : (
    <Badge tone="amber">⚠ atenção</Badge>
  );
}

/** Firing (or resolved) alerts, newest first. */
export function AlertList({
  alerts,
  href,
  showTenant = false,
  empty = "Nenhum alerta ativo.",
}: {
  alerts: Alert[];
  href: (a: Alert) => string | null;
  showTenant?: boolean;
  empty?: string;
}) {
  if (alerts.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {alerts.map((a) => {
        const link = href(a);
        const name = link ? (
          <Link href={link} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            {a.resource_name}
          </Link>
        ) : (
          <span className="font-medium">{a.resource_name}</span>
        );
        return (
          <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {a.state === "firing" ? <SeverityBadge severity={a.severity} /> : <Badge tone="green">resolvido</Badge>}
                <span className="text-slate-500">{TARGET_LABEL[a.resource_type]}</span> {name}
                {showTenant && <span className="text-xs text-slate-500">· {a.tenant_name ?? "plataforma"}</span>}
              </div>
              <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                {a.rule_name}: {METRIC_LABEL[a.metric]} {formatMetric(a.metric, a.value)} (limite{" "}
                {formatMetric(a.metric, a.threshold)}, pico {formatMetric(a.metric, a.peak)})
              </div>
            </div>
            <div className="text-right text-xs text-slate-500" title={formatDate(a.fired_at ?? a.started_at)}>
              {a.state === "resolved" && a.resolved_at
                ? `resolvido ${relativeTime(a.resolved_at)}`
                : `desde ${relativeTime(a.fired_at ?? a.started_at)}`}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// --- settings ---------------------------------------------------------------------------

function RuleDialog({ mode, open, onClose }: { mode: Mode; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState("instance");
  const [metric, setMetric] = useState("cpu");
  const create = useMutation({
    mutationFn: async (body: Schemas["AlertRuleCreate"]) =>
      mode === "tenant"
        ? unwrap(await api.POST("/api/v1/alert-rules", { body }))
        : unwrap(await api.POST("/api/v1/admin/alert-rules", { body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alert-rules", mode] });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Nova regra de alerta">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({
            name: String(f.get("name")),
            target: target as Schemas["AlertRuleCreate"]["target"],
            metric: metric as Schemas["AlertRuleCreate"]["metric"],
            threshold: fromInput(metric, Number(f.get("threshold"))),
            duration_seconds: Number(f.get("duration")) * 60,
            severity: String(f.get("severity")) as "warning" | "critical",
          });
        }}
      >
        <Field label="Nome">
          <Input name="name" required maxLength={100} placeholder="VM com CPU alta" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {mode === "platform" && (
            <Field label="Recurso">
              <Select
                className="w-full"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setMetric(TARGET_METRICS[e.target.value][0]);
                }}
              >
                {Object.keys(TARGET_METRICS).map((t) => (
                  <option key={t} value={t}>
                    {TARGET_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Métrica">
            <Select className="w-full" value={metric} onChange={(e) => setMetric(e.target.value)}>
              {TARGET_METRICS[target].map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Alerta acima de (${unit(metric)})`}>
            <Input
              name="threshold"
              type="number"
              required
              min={isRatio(metric) ? 1 : 0.1}
              max={isRatio(metric) ? 99 : undefined}
              step={isRatio(metric) ? 1 : 0.1}
              defaultValue={isRatio(metric) ? 90 : 100}
              key={metric}
            />
          </Field>
          <Field label="Por pelo menos (min)" hint="0 = alerta na hora">
            <Input name="duration" type="number" required min={0} max={10080} defaultValue={5} />
          </Field>
          <Field label="Severidade">
            <Select name="severity" className="w-full" defaultValue="warning">
              <option value="warning">Atenção</option>
              <option value="critical">Crítico</option>
            </Select>
          </Field>
        </div>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Criar regra
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RuleRow({ mode, rule }: { mode: Mode; rule: Rule }) {
  const queryClient = useQueryClient();
  const [threshold, setThreshold] = useState(String(Math.round(toInput(rule.metric, rule.threshold) * 10) / 10));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["alert-rules", mode] });
  const update = useMutation({
    mutationFn: async (body: Schemas["AlertRuleUpdate"]) => {
      const params = { path: { rule_id: rule.id } };
      return mode === "tenant"
        ? unwrap(await api.PATCH("/api/v1/alert-rules/{rule_id}", { params, body }))
        : unwrap(await api.PATCH("/api/v1/admin/alert-rules/{rule_id}", { params, body }));
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async () => {
      const params = { path: { rule_id: rule.id } };
      return mode === "tenant"
        ? unwrap(await api.DELETE("/api/v1/alert-rules/{rule_id}", { params }))
        : unwrap(await api.DELETE("/api/v1/admin/alert-rules/{rule_id}", { params }));
    },
    onSuccess: refresh,
  });
  const changed = Number(threshold) !== Math.round(toInput(rule.metric, rule.threshold) * 10) / 10;
  return (
    <tr className={rule.enabled ? "" : "opacity-60"}>
      <td className="py-2 pr-3">
        <div className="font-medium">{rule.name}</div>
        <div className="text-xs text-slate-500">
          {TARGET_LABEL[rule.target]} · {METRIC_LABEL[rule.metric]} · por {duration(rule.duration_seconds)}
        </div>
      </td>
      <td className="py-2 pr-3">
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ threshold: fromInput(rule.metric, Number(threshold)) });
          }}
        >
          <span className="text-xs text-slate-500">&gt;</span>
          <Input
            aria-label={`Limite de ${rule.name}`}
            className="w-20"
            type="number"
            step={isRatio(rule.metric) ? 1 : 0.1}
            min={isRatio(rule.metric) ? 1 : 0.1}
            max={isRatio(rule.metric) ? 99 : undefined}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <span className="text-xs text-slate-500">{unit(rule.metric)}</span>
          {changed && (
            <Button type="submit" variant="secondary" disabled={update.isPending}>
              Salvar
            </Button>
          )}
        </form>
      </td>
      <td className="py-2 pr-3">
        <SeverityBadge severity={rule.severity} />
      </td>
      <td className="py-2 text-right">
        <span className="flex items-center justify-end gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={rule.enabled}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ enabled: e.target.checked })}
            />
            ativa
          </label>
          <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Excluir
          </Button>
        </span>
        {(update.isError || remove.isError) && (
          <div className="text-xs text-rose-600">{errorMessage(update.error ?? remove.error)}</div>
        )}
      </td>
    </tr>
  );
}

function ChannelDialog({ mode, open, onClose }: { mode: Mode; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<"email" | "webhook">("email");
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (body: Schemas["ChannelCreate"]) =>
      mode === "tenant"
        ? unwrap(await api.POST("/api/v1/notification-channels", { body }))
        : unwrap(await api.POST("/api/v1/admin/notification-channels", { body })),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["channels", mode] });
      if (created.signing_secret) setSecret(created.signing_secret);
      else close();
    },
  });
  const close = () => {
    setSecret(null);
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Novo canal de notificação">
      {secret ? (
        <div className="space-y-3 text-sm">
          <p>
            Webhook criado. Cada envio leva <code>X-CM-Timestamp</code> e{" "}
            <code>X-CM-Signature: sha256=HMAC(segredo, timestamp + &quot;.&quot; + corpo)</code>. Guarde o
            segredo abaixo para verificar a assinatura: <strong>ele não será mostrado de novo</strong>.
          </p>
          <code className="block break-all rounded-md bg-slate-100 p-2 text-xs dark:bg-slate-800">{secret}</code>
          <div className="flex justify-end">
            <Button onClick={close}>Fechar</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const common = {
              name: String(f.get("name")),
              min_severity: String(f.get("min_severity")) as "warning" | "critical",
            };
            create.mutate(
              type === "email"
                ? {
                    ...common,
                    type,
                    to: String(f.get("to"))
                      .split(/[\s,;]+/)
                      .filter(Boolean),
                  }
                : { ...common, type, url: String(f.get("url")) },
            );
          }}
        >
          <Field label="Nome">
            <Input name="name" required maxLength={100} placeholder="Equipe de operações" />
          </Field>
          <Field label="Tipo">
            <Select className="w-full" value={type} onChange={(e) => setType(e.target.value as "email" | "webhook")}>
              <option value="email">E-mail</option>
              <option value="webhook">Webhook (Slack, Teams, Discord, n8n...)</option>
            </Select>
          </Field>
          {type === "email" ? (
            <Field label="Destinatários" hint="Até 10, separados por vírgula.">
              <Input name="to" required placeholder="ops@empresa.com, noc@empresa.com" />
            </Field>
          ) : (
            <Field label="URL" hint="https; endereços internos (rede privada, localhost) são recusados.">
              <Input name="url" type="url" required placeholder="https://hooks.exemplo.com/..." />
            </Field>
          )}
          <Field label="Enviar">
            <Select name="min_severity" className="w-full" defaultValue="warning">
              <option value="warning">Atenção e crítico</option>
              <option value="critical">Só crítico</option>
            </Select>
          </Field>
          <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Criar canal
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ChannelRow({ mode, channel }: { mode: Mode; channel: Channel }) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, done } = useJob(jobId, { admin: mode === "platform" });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["channels", mode] });
  const params = { path: { channel_id: channel.id } };
  const test = useMutation({
    mutationFn: async () =>
      mode === "tenant"
        ? unwrap(await api.POST("/api/v1/notification-channels/{channel_id}/test", { params })).job
        : unwrap(await api.POST("/api/v1/admin/notification-channels/{channel_id}/test", { params })).job,
    onSuccess: (j) => setJobId(j.id),
  });
  const update = useMutation({
    mutationFn: async (body: Schemas["ChannelUpdate"]) =>
      mode === "tenant"
        ? unwrap(await api.PATCH("/api/v1/notification-channels/{channel_id}", { params, body }))
        : unwrap(await api.PATCH("/api/v1/admin/notification-channels/{channel_id}", { params, body })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async () =>
      mode === "tenant"
        ? unwrap(await api.DELETE("/api/v1/notification-channels/{channel_id}", { params }))
        : unwrap(await api.DELETE("/api/v1/admin/notification-channels/{channel_id}", { params })),
    onSuccess: refresh,
  });
  const testing = test.isPending || (jobId !== null && !done);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{channel.name}</span>
          <Badge>{channel.type === "email" ? "e-mail" : "webhook"}</Badge>
          {channel.min_severity === "critical" && <Badge tone="red">só crítico</Badge>}
          {!channel.enabled && <Badge tone="gray">pausado</Badge>}
        </div>
        <div className="truncate text-xs text-slate-500">
          {channel.type === "email" ? channel.to.join(", ") : channel.url}
        </div>
        {done && job?.status === "succeeded" && <div className="text-xs text-emerald-600">Teste enviado.</div>}
        {done && job?.status === "failed" && (
          <div className="text-xs text-rose-600">Teste falhou: {job.error_message}</div>
        )}
        {(test.isError || update.isError || remove.isError) && (
          <div className="text-xs text-rose-600">{errorMessage(test.error ?? update.error ?? remove.error)}</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={testing} onClick={() => test.mutate()}>
          {testing ? <Spinner /> : null} Testar
        </Button>
        <Button variant="ghost" onClick={() => update.mutate({ enabled: !channel.enabled })}>
          {channel.enabled ? "Pausar" : "Ativar"}
        </Button>
        <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Excluir
        </Button>
      </div>
    </li>
  );
}

/** Rules and channels of the tenant (its instances) or of the platform (everything). */
export function AlertSettings({ mode }: { mode: Mode }) {
  const [creatingRule, setCreatingRule] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const rules = useQuery({
    queryKey: ["alert-rules", mode],
    queryFn: async () =>
      mode === "tenant"
        ? unwrap(await api.GET("/api/v1/alert-rules"))
        : unwrap(await api.GET("/api/v1/admin/alert-rules")),
  });
  const channels = useQuery({
    queryKey: ["channels", mode],
    queryFn: async () =>
      mode === "tenant"
        ? unwrap(await api.GET("/api/v1/notification-channels"))
        : unwrap(await api.GET("/api/v1/admin/notification-channels")),
  });
  return (
    <div className="space-y-4">
      <Card
        title="Regras"
        actions={<Button onClick={() => setCreatingRule(true)}>Nova regra</Button>}
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          {mode === "platform"
            ? "Valem para todos os hypervisors, storages e VMs. Alertas em VMs de clientes também aparecem para eles e vão para os canais deles."
            : "Valem para as VMs deste cliente, além das regras padrão da plataforma."}{" "}
          O alerta dispara quando o valor fica acima do limite pelo tempo indicado, e é resolvido quando cai
          abaixo de 95% do limite.
        </p>
        <ErrorBox message={rules.isError ? errorMessage(rules.error) : null} />
        {rules.data?.length === 0 && <Empty>Nenhuma regra.</Empty>}
        {!!rules.data?.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rules.data.map((r) => (
                  <RuleRow key={`${r.id}-${r.threshold}`} mode={mode} rule={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card
        title="Canais de notificação"
        actions={<Button onClick={() => setCreatingChannel(true)}>Novo canal</Button>}
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          Recebem um aviso quando um alerta dispara e quando é resolvido. Os alertas também ficam visíveis na
          plataforma, com ou sem canal.
        </p>
        <ErrorBox message={channels.isError ? errorMessage(channels.error) : null} />
        {channels.data?.length === 0 && <Empty>Nenhum canal: os alertas só aparecem na plataforma.</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {channels.data?.map((c) => (
            <ChannelRow key={c.id} mode={mode} channel={c} />
          ))}
        </ul>
      </Card>
      <RuleDialog key={`rule-${creatingRule}`} mode={mode} open={creatingRule} onClose={() => setCreatingRule(false)} />
      <ChannelDialog mode={mode} open={creatingChannel} onClose={() => setCreatingChannel(false)} />
    </div>
  );
}
