"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { relativeTime } from "@/components/activity";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Spinner, formatDate } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { translate, useT, type MessageKey } from "@/lib/i18n";
import { useJob } from "@/lib/jobs";

type Alert = Schemas["AlertOut"] & Partial<Pick<Schemas["AdminAlertOut"], "tenant_name">>;
type Rule = Schemas["AlertRuleOut"];
type Channel = Schemas["ChannelOut"];
type Mode = "tenant" | "platform";

/** Message keys; translate where rendered. */
export const METRIC_LABEL: Record<string, MessageKey> = {
  cpu: "alerts.metric.cpu",
  memory: "alerts.metric.memory",
  disk: "alerts.metric.disk",
  net_in: "alerts.metric.netIn",
  net_out: "alerts.metric.netOut",
};
export const TARGET_LABEL: Record<string, MessageKey> = {
  instance: "alerts.target.instance",
  node: "alerts.target.node",
  storage: "alerts.target.storage",
};
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
  if (!seconds) return translate("alerts.rule.immediate");
  return seconds % 60 ? `${seconds} s` : `${seconds / 60} min`;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const t = useT();
  return severity === "critical" ? (
    <Badge tone="red">⚠ {t("alerts.severity.critical")}</Badge>
  ) : (
    <Badge tone="amber">⚠ {t("alerts.severity.warning")}</Badge>
  );
}

/** Firing (or resolved) alerts, newest first. */
export function AlertList({
  alerts,
  href,
  showTenant = false,
  empty,
}: {
  alerts: Alert[];
  href: (a: Alert) => string | null;
  showTenant?: boolean;
  empty?: string;
}) {
  const t = useT();
  if (alerts.length === 0) return <Empty>{empty ?? t("alerts.list.empty")}</Empty>;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {alerts.map((a) => {
        const link = href(a);
        const name = link ? (
          <Link href={link} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            {a.resource_name}
          </Link>
        ) : (
          <span className="font-medium">{a.resource_name}</span>
        );
        return (
          <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {a.state === "firing" ? <SeverityBadge severity={a.severity} /> : <Badge tone="green">{t("alerts.list.resolved")}</Badge>}
                <span className="text-slate-500">{t(TARGET_LABEL[a.resource_type])}</span> {name}
                {showTenant && <span className="text-xs text-slate-500">· {a.tenant_name ?? t("alerts.list.platform")}</span>}
              </div>
              <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                {t("alerts.list.detail", {
                  rule: a.rule_name,
                  metric: t(METRIC_LABEL[a.metric]),
                  value: formatMetric(a.metric, a.value),
                  threshold: formatMetric(a.metric, a.threshold),
                  peak: formatMetric(a.metric, a.peak),
                })}
              </div>
            </div>
            <div className="text-right text-xs text-slate-500" title={formatDate(a.fired_at ?? a.started_at)}>
              {a.state === "resolved" && a.resolved_at
                ? t("alerts.list.resolvedAt", { time: relativeTime(a.resolved_at) })
                : t("alerts.list.since", { time: relativeTime(a.fired_at ?? a.started_at) })}
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
  const t = useT();
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
    <Dialog open={open} onClose={onClose} title={t("alerts.rule.newTitle")}>
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
        <Field label={t("alerts.common.name")}>
          <Input name="name" required maxLength={100} placeholder={t("alerts.rule.namePlaceholder")} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {mode === "platform" && (
            <Field label={t("alerts.rule.resource")}>
              <Select
                className="w-full"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setMetric(TARGET_METRICS[e.target.value][0]);
                }}
              >
                {Object.keys(TARGET_METRICS).map((k) => (
                  <option key={k} value={k}>
                    {t(TARGET_LABEL[k])}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("alerts.rule.metric")}>
            <Select className="w-full" value={metric} onChange={(e) => setMetric(e.target.value)}>
              {TARGET_METRICS[target].map((m) => (
                <option key={m} value={m}>
                  {t(METRIC_LABEL[m])}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("alerts.rule.threshold", { unit: unit(metric) })}>
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
          <Field label={t("alerts.rule.duration")} hint={t("alerts.rule.durationHint")}>
            <Input name="duration" type="number" required min={0} max={10080} defaultValue={5} />
          </Field>
          <Field label={t("alerts.rule.severity")}>
            <Select name="severity" className="w-full" defaultValue="warning">
              <option value="warning">{t("alerts.rule.warning")}</option>
              <option value="critical">{t("alerts.rule.critical")}</option>
            </Select>
          </Field>
        </div>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("alerts.common.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t("alerts.rule.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RuleRow({ mode, rule }: { mode: Mode; rule: Rule }) {
  const queryClient = useQueryClient();
  const t = useT();
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
          {t(TARGET_LABEL[rule.target])} · {t(METRIC_LABEL[rule.metric])} ·{" "}
          {t("alerts.rule.forDuration", { duration: duration(rule.duration_seconds) })}
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
            aria-label={t("alerts.rule.thresholdOf", { name: rule.name })}
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
              {t("alerts.common.save")}
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
            {t("alerts.rule.enabled")}
          </label>
          <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t("alerts.common.delete")}
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
  const t = useT();
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
    <Dialog open={open} onClose={close} title={t("alerts.channel.newTitle")}>
      {secret ? (
        <div className="space-y-3 text-sm">
          <p>
            {t("alerts.channel.secretBefore")} <code>X-CM-Timestamp</code> {t("alerts.channel.secretAnd")}{" "}
            <code>{t("alerts.channel.signature")}</code>. {t("alerts.channel.secretKeep")}{" "}
            <strong>{t("alerts.channel.secretOnce")}</strong>.
          </p>
          <code className="block break-all rounded-md bg-slate-100 p-2 text-xs dark:bg-slate-800">{secret}</code>
          <div className="flex justify-end">
            <Button onClick={close}>{t("alerts.common.close")}</Button>
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
          <Field label={t("alerts.common.name")}>
            <Input name="name" required maxLength={100} placeholder={t("alerts.channel.namePlaceholder")} />
          </Field>
          <Field label={t("alerts.channel.type")}>
            <Select className="w-full" value={type} onChange={(e) => setType(e.target.value as "email" | "webhook")}>
              <option value="email">{t("alerts.channel.email")}</option>
              <option value="webhook">{t("alerts.channel.webhook")}</option>
            </Select>
          </Field>
          {type === "email" ? (
            <Field label={t("alerts.channel.recipients")} hint={t("alerts.channel.recipientsHint")}>
              <Input name="to" required placeholder={t("alerts.channel.recipientsPlaceholder")} />
            </Field>
          ) : (
            <Field label={t("alerts.channel.url")} hint={t("alerts.channel.urlHint")}>
              <Input name="url" type="url" required placeholder={t("alerts.channel.urlPlaceholder")} />
            </Field>
          )}
          <Field label={t("alerts.channel.send")}>
            <Select name="min_severity" className="w-full" defaultValue="warning">
              <option value="warning">{t("alerts.channel.warningAndCritical")}</option>
              <option value="critical">{t("alerts.channel.criticalOnly")}</option>
            </Select>
          </Field>
          <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              {t("alerts.common.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {t("alerts.channel.create")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ChannelRow({ mode, channel }: { mode: Mode; channel: Channel }) {
  const queryClient = useQueryClient();
  const t = useT();
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
          <Badge>{channel.type === "email" ? t("alerts.channel.badgeEmail") : t("alerts.channel.badgeWebhook")}</Badge>
          {channel.min_severity === "critical" && <Badge tone="red">{t("alerts.channel.badgeCriticalOnly")}</Badge>}
          {!channel.enabled && <Badge tone="gray">{t("alerts.channel.paused")}</Badge>}
        </div>
        <div className="truncate text-xs text-slate-500">
          {channel.type === "email" ? channel.to.join(", ") : channel.url}
        </div>
        {done && job?.status === "succeeded" && <div className="text-xs text-emerald-600">{t("alerts.channel.testSent")}</div>}
        {done && job?.status === "failed" && (
          <div className="text-xs text-rose-600">{t("alerts.channel.testFailed", { error: job.error_message ?? "" })}</div>
        )}
        {(test.isError || update.isError || remove.isError) && (
          <div className="text-xs text-rose-600">{errorMessage(test.error ?? update.error ?? remove.error)}</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={testing} onClick={() => test.mutate()}>
          {testing ? <Spinner /> : null} {t("alerts.channel.test")}
        </Button>
        <Button variant="ghost" onClick={() => update.mutate({ enabled: !channel.enabled })}>
          {channel.enabled ? t("alerts.channel.pause") : t("alerts.channel.enable")}
        </Button>
        <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {t("alerts.common.delete")}
        </Button>
      </div>
    </li>
  );
}

/** Rules and channels of the tenant (its instances) or of the platform (everything). */
export function AlertSettings({ mode }: { mode: Mode }) {
  const t = useT();
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
        title={t("alerts.settings.rules")}
        actions={<Button onClick={() => setCreatingRule(true)}>{t("alerts.settings.newRule")}</Button>}
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          {mode === "platform"
            ? t("alerts.settings.platformScope")
            : t("alerts.settings.tenantScope")}{" "}
          {t("alerts.settings.rulesExplain")}
        </p>
        <ErrorBox message={rules.isError ? errorMessage(rules.error) : null} />
        {rules.data?.length === 0 && <Empty>{t("alerts.settings.noRules")}</Empty>}
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
        title={t("alerts.settings.channels")}
        actions={<Button onClick={() => setCreatingChannel(true)}>{t("alerts.settings.newChannel")}</Button>}
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          {t("alerts.settings.channelsExplain")}
        </p>
        <ErrorBox message={channels.isError ? errorMessage(channels.error) : null} />
        {channels.data?.length === 0 && <Empty>{t("alerts.settings.noChannels")}</Empty>}
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
