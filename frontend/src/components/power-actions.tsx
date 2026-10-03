"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Dialog, ErrorBox, JobBadge, Spinner } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useJob } from "@/lib/jobs";
import { usePermissions } from "@/lib/session";

type Instance = Schemas["InstanceOut"];
type Action = "start" | "shutdown" | "stop" | "restart";

const ACTIONS: { action: Action; label: string; verb: string; when: string[] }[] = [
  { action: "start", label: "Ligar", verb: "start", when: ["stopped", "paused", "unknown"] },
  { action: "shutdown", label: "Desligar", verb: "stop", when: ["running", "unknown"] },
  { action: "restart", label: "Reiniciar", verb: "restart", when: ["running"] },
  { action: "stop", label: "Forçar desligamento", verb: "stop", when: ["running", "paused", "unknown"] },
];

export function PowerActions({ instance, compact = false }: { instance: Instance; compact?: boolean }) {
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {available.map((a) =>
        a.action === "stop" && compact ? null : (
          <Button
            key={a.action}
            variant={a.action === "stop" ? "danger" : "secondary"}
            disabled={busy}
            onClick={() => (a.action === "stop" ? setConfirming(true) : trigger(a.action))}
          >
            {a.label}
          </Button>
        ),
      )}
      {busy && <Spinner />}
      {job && !busy && job.status === "failed" && <JobBadge status="failed" />}
      {!compact && job?.status === "failed" && <ErrorBox message={job.error_message} />}
      {run.isError && <ErrorBox message={errorMessage(run.error)} />}

      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Forçar desligamento">
        <p className="text-sm">
          Desliga <strong>{instance.name}</strong> imediatamente, como tirar da tomada. Dados não
          gravados podem ser perdidos. Prefira <em>Desligar</em>, que pede ao sistema operacional.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirming(false);
              trigger("stop");
            }}
          >
            Forçar desligamento
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
