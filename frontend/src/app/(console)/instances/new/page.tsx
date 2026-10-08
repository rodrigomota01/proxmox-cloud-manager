"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { PageHeader } from "@/components/page";
import { Alert, Button, Card, ErrorBox, Field, Input, Select } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { money, num } from "@/lib/money";
import { useProjects } from "@/lib/queries";
import { useSession } from "@/lib/session";

const MEMORY_OPTIONS = [1, 2, 4, 8, 16, 32]; // GiB
const QUOTA_LABEL: Record<string, string> = {
  instances: "Instâncias",
  vcpus: "vCPUs",
  memory_mb: "Memória (MiB)",
  storage_gb: "Disco (GiB)",
};

export default function NewInstancePage() {
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
        title="Criar instância"
        breadcrumbs={[{ label: "Máquinas virtuais", href: "/instances" }, { label: "Criar instância" }]}
        description="Escolha onde a VM roda, a imagem, o tamanho, a rede e as chaves de acesso."
      />

      <form onSubmit={submit} className="grid items-start gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="1. Localização" description="Região e zona onde a instância vai rodar.">
            {regions.data?.length === 0 ? (
              <Alert variant="warning">Nenhuma região disponível para criar instâncias. Peça a um administrador.</Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Região">
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
                      Selecione…
                    </option>
                    {regions.data?.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.slug})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Zona" hint="A plataforma escolhe o servidor dentro da zona.">
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
                      {region ? "Selecione…" : "Escolha a região primeiro"}
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

          <Card title="2. Básico" description="Projeto, nome e sistema operacional.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Projeto">
                <Select name="project_id" className="w-full" required defaultValue="">
                  <option value="" disabled>
                    Selecione…
                  </option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Nome (hostname)" hint="Minúsculas, números e hífen.">
                <Input name="name" required pattern="[a-z]([a-z0-9\-]{0,61}[a-z0-9])?" placeholder="web-01" />
              </Field>
              <Field label="Imagem">
                <Select
                  className="w-full"
                  required
                  disabled={!zoneId}
                  value={imageId}
                  onChange={(e) => setImageId(e.target.value)}
                >
                  <option value="" disabled>
                    {!zoneId ? "Escolha a zona primeiro" : zoneImages.length ? "Selecione…" : "Nenhuma imagem nesta zona"}
                  </option>
                  {zoneImages.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Usuário de acesso" hint="Criado pelo cloud-init com as suas chaves.">
                <Input value={image?.default_user ?? ""} readOnly disabled />
              </Field>
            </div>
          </Card>

          <Card title="3. Recursos" description="Tamanho da instância.">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="vCPUs">
                <Select className="w-full" value={vcpus} onChange={(e) => setVcpus(Number(e.target.value))}>
                  {[1, 2, 4, 8, 16].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Memória">
                <Select className="w-full" value={memoryGb} onChange={(e) => setMemoryGb(Number(e.target.value))}>
                  {MEMORY_OPTIONS.map((g) => (
                    <option key={g} value={g}>
                      {g} GiB
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Disco (GiB)" hint={image ? `Mínimo: ${image.min_disk_gb} GiB` : undefined}>
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

          <Card title="4. Rede">
            {fromIpam ? (
              <>
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
                  IPs livres no cadastro de IPs desta zona. O escolhido é reservado no cadastro ao
                  criar e liberado ao excluir a instância; gateway, máscara e VLAN vêm da rede dele.
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="IP" hint={`${addresses.data!.length} livre(s)`}>
                    <Select name="ipam_address_id" className="w-full" required defaultValue="" key={`${zoneId}-${imageId}`}>
                      <option value="" disabled>
                        Selecione…
                      </option>
                      {addresses.data!.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.address} (gw {a.gateway})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="DNS (opcional)" hint="Padrão: 8.8.8.8 1.1.1.1">
                    <Input name="dns" placeholder="8.8.8.8 1.1.1.1" />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
                  IP fixo configurado pelo cloud-init. Os servidores desta zona não têm IPs no cadastro:
                  a plataforma impede IPs repetidos entre as instâncias dela, mas <strong>não</strong>{" "}
                  detecta IPs usados fora dela. Confira com o responsável pela rede.
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Endereço/prefixo">
                    <Input name="address" required placeholder="203.0.113.10/28" />
                  </Field>
                  <Field label="Gateway">
                    <Input name="gateway" required placeholder="203.0.113.14" />
                  </Field>
                  <Field label="DNS (opcional)" hint="Até 3, separados por espaço.">
                    <Input name="dns" placeholder="1.1.1.1 8.8.8.8" />
                  </Field>
                </div>
              </>
            )}
          </Card>

          <Card title="5. Chaves SSH" description="Pelo menos uma chave é necessária para acessar a instância.">
            {keys.data?.length === 0 ? (
              <p className="text-sm">
                Você ainda não tem chaves.{" "}
                <Link href="/ssh-keys" className="text-indigo-600 hover:underline dark:text-indigo-400">
                  Adicione uma chave pública
                </Link>{" "}
                para acessar a instância.
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
          <Card title="Resumo">
            <dl className="space-y-2 text-sm">
              {[
                ["Zona", region?.zones.find((z) => z.id === zoneId)?.name ?? "—"],
                ["Imagem", image?.name ?? "—"],
                ["Tamanho", `${vcpus} vCPU · ${memoryGb} GiB · ${diskGb || "—"} GiB disco`],
                ["Chaves SSH", selectedKeys.length || "nenhuma"],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {estimate && estimate.running > 0 && (
              <div className="mt-4 rounded-md bg-indigo-50 px-3 py-2 text-sm dark:bg-indigo-950/50">
                <div className="text-xs text-slate-600 dark:text-slate-400">Custo estimado</div>
                <div className="text-lg font-semibold tabular-nums">
                  {money(estimate.running, prices.data!.currency)}/mês
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-400">
                  ligada ({money(estimate.hourly, prices.data!.currency, true)}/hora) ·{" "}
                  {money(estimate.stopped, prices.data!.currency)}/mês desligada
                </div>
              </div>
            )}
            {quotas.data && (
              <div className="mt-4 space-y-1 text-xs">
                <div className="font-semibold text-slate-700 dark:text-slate-300">Quota do cliente</div>
                {quotas.data.map((q) => {
                  const over = overQuota.some((o) => o.resource === q.resource);
                  return (
                    <div
                      key={q.resource}
                      className={`flex justify-between ${over ? "font-medium text-rose-700 dark:text-rose-300" : "text-slate-600 dark:text-slate-400"}`}
                    >
                      <span>{QUOTA_LABEL[q.resource] ?? q.resource}</span>
                      <span className="tabular-nums">
                        {q.available} de {q.limit} livres
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
                  message={`Acima da quota: ${overQuota.map((o) => QUOTA_LABEL[o.resource] ?? o.resource).join(", ")}.`}
                />
              )}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={create.isPending || selectedKeys.length === 0 || !imageId || !zoneId || overQuota.length > 0}
                >
                  Criar instância
                </Button>
                <Link href="/instances">
                  <Button type="button" variant="secondary">
                    Cancelar
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
