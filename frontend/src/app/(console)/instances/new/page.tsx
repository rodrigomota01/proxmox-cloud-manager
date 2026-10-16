"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { PageHeader } from "@/components/page";
import { Alert, Button, Card, ErrorBox, Field, Input, Select } from "@/components/ui";
import { api, ApiError, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";
import { money, num } from "@/lib/money";
import { useProjects } from "@/lib/queries";
import { useSession } from "@/lib/session";

const MEMORY_OPTIONS = [1, 2, 4, 8, 16, 32]; // GiB
const QUOTA_LABEL: Record<string, MessageKey> = {
  instances: "compute.create.quotaInstances",
  vcpus: "compute.create.quotaVcpus",
  memory_mb: "compute.create.quotaMemory",
  storage_gb: "compute.create.quotaStorage",
};

export default function NewInstancePage() {
  const t = useT();
  const quotaLabel = (resource: string) => (QUOTA_LABEL[resource] ? t(QUOTA_LABEL[resource]) : resource);
  const router = useRouter();
  const { tenantId } = useSession();
  const projects = useProjects();
  const images = useQuery({
    queryKey: ["images", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/images")),
    enabled: tenantId !== null,
  });
  const regions = useQuery({
    queryKey: ["regions"],
    queryFn: async () => unwrap(await api.GET("/api/v1/regions")),
  });
  const keys = useQuery({
    queryKey: ["ssh-keys"],
    queryFn: async () => unwrap(await api.GET("/api/v1/ssh-keys")),
  });
  const prices = useQuery({
    queryKey: ["billing", "prices", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/billing/prices")),
    enabled: tenantId !== null,
    staleTime: 60_000,
    // 403 when the client's costs are hidden: no estimate, no retries
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
  });
  const quotas = useQuery({
    queryKey: ["quotas", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/quotas")),
    enabled: tenantId !== null,
  });

  const [regionId, setRegionId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [imageId, setImageId] = useState("");
  const region = regions.data?.find((r) => r.id === regionId);
  const zoneImages = (images.data ?? []).filter((i) => zoneId && i.zone_ids.includes(zoneId));
  const [vcpus, setVcpus] = useState(2);
  const [memoryGb, setMemoryGb] = useState(2);
  const [disk, setDisk] = useState<number | "">("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const image = images.data?.find((i) => i.id === imageId);
  // addresses from the IPAM for this zone/image; none -> the IP is typed by hand
  const addresses = useQuery({
    queryKey: ["zone-addresses", tenantId, zoneId, imageId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/zones/{zone_id}/addresses", {
          params: { path: { zone_id: zoneId }, query: imageId ? { image_id: imageId } : {} },
        }),
      ),
    enabled: tenantId !== null && zoneId !== "",
  });
  const fromIpam = (addresses.data?.length ?? 0) > 0;
  const diskGb = disk === "" ? (image?.min_disk_gb ?? 0) : disk;

  // what this request would use, against what is left
  const overQuota = useMemo(() => {
    const request: Record<string, number> = {
      instances: 1,
      vcpus,
      memory_mb: memoryGb * 1024,
      storage_gb: diskGb,
    };
    return (quotas.data ?? []).filter((q) => request[q.resource] > q.available);
  }, [quotas.data, vcpus, memoryGb, diskGb]);

  // same rule as the backend: compute while running; disk and the fee while it exists
  const estimate = useMemo(() => {
    const p = prices.data?.prices;
    if (!p) return null;
    const stopped = num(p.disk_gb) * diskGb + num(p.instance);
    const running = stopped + num(p.vcpu) * vcpus + num(p.memory_gb) * memoryGb;
    return { running, stopped, hourly: running / (prices.data?.hours_per_month ?? 730) };
  }, [prices.data, vcpus, memoryGb, diskGb]);

  const create = useMutation({
    // the key is minted per submit: a retried request never creates two instances
    mutationFn: async ({ body, key }: { body: Schemas["InstanceCreate"]; key: string }) =>
      unwrap(await api.POST("/api/v1/instances", { body, headers: { "Idempotency-Key": key } })),
    onSuccess: (res) => router.push(`/instances/${res.instance.id}`),
  });

  if (!tenantId) return <NoTenant />;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const dns = String(form.get("dns") ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    create.mutate({
      key: crypto.randomUUID(),
      body: {
        project_id: String(form.get("project_id")),
        name: String(form.get("name")).trim(),
        image_id: imageId,
        zone_id: zoneId,
        vcpus,
        memory_mb: memoryGb * 1024,
        root_disk_gb: diskGb,
        ssh_key_ids: selectedKeys,
        ...(fromIpam
          ? { ipam_address_id: String(form.get("ipam_address_id")), dns }
          : {
              ipv4: {
                address: String(form.get("address")).trim(),
                gateway: String(form.get("gateway")).trim(),
                dns,
              },
            }),
      },
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("compute.create.title")}
        breadcrumbs={[{ label: t("nav.vms"), href: "/instances" }, { label: t("compute.create.title") }]}
        description={t("compute.create.description")}
      />

      <form onSubmit={submit} className="grid items-start gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={t("compute.create.location")} description={t("compute.create.locationDesc")}>
            {regions.data?.length === 0 ? (
              <Alert variant="warning">{t("compute.create.noRegions")}</Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("compute.create.region")}>
                  <Select
                    className="w-full"
                    required
                    value={regionId}
                    onChange={(e) => {
                      setRegionId(e.target.value);
                      const only = regions.data?.find((r) => r.id === e.target.value)?.zones;
                      setZoneId(only?.length === 1 ? only[0].id : "");
                      setImageId("");
                    }}
                  >
                    <option value="" disabled>
                      {t("compute.create.select")}
                    </option>
                    {regions.data?.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.slug})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("compute.create.zone")} hint={t("compute.create.zoneHint")}>
                  <Select
                    className="w-full"
                    required
                    disabled={!region}
                    value={zoneId}
                    onChange={(e) => {
                      setZoneId(e.target.value);
                      setImageId("");
                    }}
                  >
                    <option value="" disabled>
                      {region ? t("compute.create.select") : t("compute.create.pickRegionFirst")}
                    </option>
                    {region?.zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name} ({z.slug})
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </Card>

          <Card title={t("compute.create.basics")} description={t("compute.create.basicsDesc")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("compute.create.project")}>
                <Select name="project_id" className="w-full" required defaultValue="">
                  <option value="" disabled>
                    {t("compute.create.select")}
                  </option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("compute.create.name")} hint={t("compute.create.nameHint")}>
                <Input name="name" required pattern="[a-z]([a-z0-9\-]{0,61}[a-z0-9])?" placeholder="web-01" />
              </Field>
              <Field label={t("compute.create.image")}>
                <Select
                  className="w-full"
                  required
                  disabled={!zoneId}
                  value={imageId}
                  onChange={(e) => setImageId(e.target.value)}
                >
                  <option value="" disabled>
                    {!zoneId
                      ? t("compute.create.pickZoneFirst")
                      : zoneImages.length
                        ? t("compute.create.select")
                        : t("compute.create.noImages")}
                  </option>
                  {zoneImages.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("compute.create.user")} hint={t("compute.create.userHint")}>
                <Input value={image?.default_user ?? ""} readOnly disabled />
              </Field>
            </div>
          </Card>

          <Card title={t("compute.create.resources")} description={t("compute.create.resourcesDesc")}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("compute.create.vcpus")}>
                <Select className="w-full" value={vcpus} onChange={(e) => setVcpus(Number(e.target.value))}>
                  {[1, 2, 4, 8, 16].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("compute.create.memory")}>
                <Select className="w-full" value={memoryGb} onChange={(e) => setMemoryGb(Number(e.target.value))}>
                  {MEMORY_OPTIONS.map((g) => (
                    <option key={g} value={g}>
                      {g} GiB
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("compute.create.disk")} hint={image ? t("compute.create.diskMin", { size: image.min_disk_gb }) : undefined}>
                <Input
                  type="number"
                  min={image?.min_disk_gb ?? 1}
                  max={2048}
                  required
                  value={diskGb || ""}
                  onChange={(e) => setDisk(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </Field>
            </div>
          </Card>

          <Card title={t("compute.create.network")}>
            {fromIpam ? (
              <>
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
                  {t("compute.create.ipamIntro")}
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label={t("compute.create.ip")}
                    hint={t(addresses.data!.length === 1 ? "compute.create.freeOne" : "compute.create.freeOther", {
                      count: addresses.data!.length,
                    })}
                  >
                    <Select name="ipam_address_id" className="w-full" required defaultValue="" key={`${zoneId}-${imageId}`}>
                      <option value="" disabled>
                        {t("compute.create.select")}
                      </option>
                      {addresses.data!.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.address} (gw {a.gateway})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("compute.create.dnsOptional")} hint={t("compute.create.dnsDefault")}>
                    <Input name="dns" placeholder="8.8.8.8 1.1.1.1" />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
                  {t("compute.create.staticIntroBefore")} <strong>{t("compute.create.staticIntroNot")}</strong>{" "}
                  {t("compute.create.staticIntroAfter")}
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t("compute.create.address")}>
                    <Input name="address" required placeholder="203.0.113.10/28" />
                  </Field>
                  <Field label={t("compute.create.gateway")}>
                    <Input name="gateway" required placeholder="203.0.113.14" />
                  </Field>
                  <Field label={t("compute.create.dnsOptional")} hint={t("compute.create.dnsHint")}>
                    <Input name="dns" placeholder="1.1.1.1 8.8.8.8" />
                  </Field>
                </div>
              </>
            )}
          </Card>

          <Card title={t("compute.create.keys")} description={t("compute.create.keysDesc")}>
            {keys.data?.length === 0 ? (
              <p className="text-sm">
                {t("compute.create.noKeysBefore")}{" "}
                <Link href="/ssh-keys" className="text-brand-600 hover:underline dark:text-brand-400">
                  {t("compute.create.noKeysLink")}
                </Link>{" "}
                {t("compute.create.noKeysAfter")}
              </p>
            ) : (
              <ul className="space-y-2">
                {keys.data?.map((k) => (
                  <li key={k.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(k.id)}
                        onChange={(e) =>
                          setSelectedKeys((cur) =>
                            e.target.checked ? [...cur, k.id] : cur.filter((id) => id !== k.id),
                          )
                        }
                      />
                      <span className="font-medium">{k.name}</span>
                      <span className="font-mono text-xs text-slate-500">{k.fingerprint}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20">
          <Card title={t("compute.create.summary")}>
            <dl className="space-y-2 text-sm">
              {[
                [t("compute.create.sumZone"), region?.zones.find((z) => z.id === zoneId)?.name ?? "—"],
                [t("compute.create.sumImage"), image?.name ?? "—"],
                [t("compute.create.sumSize"), t("compute.create.sizeValue", { vcpus, memory: memoryGb, disk: diskGb || "—" })],
                [t("compute.create.sumKeys"), selectedKeys.length || t("compute.create.noneKeys")],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {estimate && estimate.running > 0 && (
              <div className="mt-4 rounded-md bg-brand-50 px-3 py-2 text-sm dark:bg-brand-950/50">
                <div className="text-xs text-slate-600 dark:text-slate-400">{t("compute.create.estimate")}</div>
                <div className="text-lg font-semibold tabular-nums">
                  {t("compute.create.perMonth", { amount: money(estimate.running, prices.data!.currency) })}
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-400">
                  {t("compute.create.estimateDetail", {
                    hourly: money(estimate.hourly, prices.data!.currency, true),
                    stopped: money(estimate.stopped, prices.data!.currency),
                  })}
                </div>
              </div>
            )}
            {quotas.data && (
              <div className="mt-4 space-y-1 text-xs">
                <div className="font-semibold text-slate-700 dark:text-slate-300">{t("compute.create.quota")}</div>
                {quotas.data.map((q) => {
                  const over = overQuota.some((o) => o.resource === q.resource);
                  return (
                    <div
                      key={q.resource}
                      className={`flex justify-between ${over ? "font-medium text-rose-700 dark:text-rose-300" : "text-slate-600 dark:text-slate-400"}`}
                    >
                      <span>{quotaLabel(q.resource)}</span>
                      <span className="tabular-nums">
                        {t("compute.create.quotaFree", { available: q.available, limit: q.limit })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 space-y-3">
              <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
              {overQuota.length > 0 && (
                <ErrorBox
                  message={t("compute.create.overQuota", { resources: overQuota.map((o) => quotaLabel(o.resource)).join(", ") })}
                />
              )}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={create.isPending || selectedKeys.length === 0 || !imageId || !zoneId || overQuota.length > 0}
                >
                  {t("compute.create.submit")}
                </Button>
                <Link href="/instances">
                  <Button type="button" variant="secondary">
                    {t("compute.create.cancel")}
                  </Button>
                </Link>
              </div>
            </div>
          </Card>
        </aside>
      </form>
    </div>
  );
}
