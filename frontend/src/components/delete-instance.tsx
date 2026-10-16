"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Dialog, ErrorBox, Field, Input, Spinner } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { useJob } from "@/lib/jobs";
import { usePermissions } from "@/lib/session";

/** Typing the name is the UI side of the `confirm` the API requires. */
export function DeleteInstance({ instance }: { instance: Schemas["InstanceOut"] }) {
  const t = useT();
  const router = useRouter();
  const perms = usePermissions(`project:${instance.project_id}`);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, done } = useJob(jobId, {
    invalidate: [["instances"], ["dashboard"], ["quotas"]],
  });

  const remove = useMutation({
    mutationFn: async ({ key }: { key: string }) =>
      unwrap(
        await api.DELETE("/api/v1/instances/{instance_id}", {
          params: { path: { instance_id: instance.id } },
          body: { confirm: typed },
          headers: { "Idempotency-Key": key },
        }),
      ).job,
    onSuccess: (j) => {
      setOpen(false);
      setJobId(j.id);
    },
  });

  useEffect(() => {
    if (done && job?.status === "succeeded") router.replace("/instances");
  }, [done, job?.status, router]);

  if (instance.read_only || !perms.has(`${instance.kind}:delete`) || !["active", "error"].includes(instance.state)) {
    return jobId && !done ? <Spinner /> : null;
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {t("compute.delete.delete")}
      </Button>
      {job?.status === "failed" && <ErrorBox message={t("compute.delete.failed", { error: job.error_message ?? "" })} />}
      <Dialog open={open} onClose={() => setOpen(false)} title={t("compute.delete.title")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            remove.mutate({ key: crypto.randomUUID() });
          }}
          className="space-y-4"
        >
          <p className="text-sm">
            {t("compute.delete.bodyBefore")} <strong>{instance.name}</strong> {t("compute.delete.bodyAfter")}
          </p>
          <Field label={t("compute.delete.typeToConfirm", { name: instance.name })}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
          <ErrorBox message={remove.isError ? errorMessage(remove.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t("compute.delete.cancel")}
            </Button>
            <Button type="submit" variant="danger" disabled={typed !== instance.name || remove.isPending}>
              {t("compute.delete.confirm")}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
