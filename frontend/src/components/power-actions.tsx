"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Menu } from "@/components/page";
import { Badge, Button, Dialog, ErrorBox, JobBadge, Spinner } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";
import { useJob } from "@/lib/jobs";
import { usePermissions } from "@/lib/session";

type Instance = Schemas["InstanceOut"];
type Action = "start" | "shutdown" | "stop" | "restart";

const ACTIONS: { action: Action; label: MessageKey; verb: string; when: string[] }[] = [
  { action: "start", label: "compute.power.start", verb: "start", when: ["stopped", "paused", "unknown"] },
  { action: "shutdown", label: "compute.power.shutdown", verb: "stop", when: ["running", "unknown"] },
  { action: "restart", label: "compute.power.restart", verb: "restart", when: ["running"] },
  { action: "stop", label: "compute.power.forceStop", verb: "stop", when: ["running", "paused", "unknown"] },
];

/** Power buttons; `compact` (table rows) folds them into a kebab menu. */
export function PowerActions({ instance, compact = false }: { instance: Instance; compact?: boolean }) {
  const t = useT();
  const perms = usePermissions(`project:${instance.project_id}`);
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { job, done } = useJob(jobId, {
    invalidate: [["instances"], ["instance", instance.id], ["dashboard"], ["jobs"]],
  });

  const run = useMutation({
    // the key is minted per click, so a retried request never enqueues twice
    mutationFn: async ({ action, key }: { action: Action; key: string }) =>
      unwrap(
        await api.POST("/api/v1/instances/{instance_id}/{action}", {
          params: { path: { instance_id: instance.id, action } },
          headers: { "Idempotency-Key": key },
        }),
      ).job,
    onSuccess: (j) => setJobId(j.id),
  });

  const trigger = (action: Action) => run.mutate({ action, key: crypto.randomUUID() });
  const busy = run.isPending || (jobId !== null && !done);
  const available = ACTIONS.filter(
    (a) => a.when.includes(instance.power_state) && perms.has(`${instance.kind}:${a.verb}`),
  );
  if (instance.state !== "active") return null;
  if (instance.read_only) {
    return (
      <span title={t("compute.power.readOnlyHint")}>
        <Badge tone="gray">{t("compute.power.readOnly")}</Badge>
      </span>
    );
  }
  const onPick = (a: Action) => (a === "stop" ? setConfirming(true) : trigger(a));

  return (
    <div className={`flex items-center gap-2 ${compact ? "justify-end" : "flex-wrap"}`}>
      {compact ? (
        busy ? null : (
          <Menu
            ariaLabel={t("compute.power.actionsOf", { name: instance.name })}
            items={available.map((a) => ({ label: t(a.label), danger: a.action === "stop", onClick: () => onPick(a.action) }))}
          />
        )
      ) : (
        available.map((a) => (
          <Button
            key={a.action}
            variant={a.action === "stop" ? "danger" : "secondary"}
            disabled={busy}
            onClick={() => onPick(a.action)}
          >
            {t(a.label)}
          </Button>
        ))
      )}
      {busy && <Spinner />}
      {job && !busy && job.status === "failed" && <JobBadge status="failed" />}
      {!compact && job?.status === "failed" && <ErrorBox message={job.error_message} />}
      {run.isError && <ErrorBox message={errorMessage(run.error)} />}

      <Dialog open={confirming} onClose={() => setConfirming(false)} title={t("compute.power.forceStop")}>
        <p className="text-sm">
          {t("compute.power.forceStopBefore")} <strong>{instance.name}</strong> {t("compute.power.forceStopMiddle")}{" "}
          <em>{t("compute.power.shutdown")}</em>
          {t("compute.power.forceStopAfter")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            {t("compute.power.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirming(false);
              trigger("stop");
            }}
          >
            {t("compute.power.forceStop")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
