"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NoTenant } from "@/components/no-tenant";
import { Button, Card, ErrorBox, Field, Input, Select } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
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
        ipv4: {
          address: String(form.get("address")).trim(),
          gateway: String(form.get("gateway")).trim(),
          dns,
        },
      },
    });
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/instances" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← Instâncias
      </Link>
      <h1 className="text-lg font-semibold">Nova instância</h1>

      <form onSubmit={submit} className="space-y-4">
        <Card title="Localização">
          {regions.data?.length === 0 ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Nenhuma região disponível para criar instâncias. Peça a um administrador.
            </p>
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

        <Card title="Básico">
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

        <Card title="Recursos">
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
          {quotas.data && (
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {quotas.data.map((q) => (
                <div
                  key={q.resource}
                  className={`rounded-md border px-2 py-1 ${
                    overQuota.some((o) => o.resource === q.resource)
                      ? "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300"
                      : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400"
                  }`}
                >
                  {QUOTA_LABEL[q.resource] ?? q.resource}: {q.available} de {q.limit} livres
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Rede">
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
            IP fixo configurado pelo cloud-init. A plataforma impede IPs repetidos entre as
            instâncias dela, mas <strong>não</strong> detecta IPs usados fora dela: confira com o
            responsável pela rede.
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
        </Card>

        <Card title="Chaves SSH">
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

        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        {overQuota.length > 0 && (
          <ErrorBox
            message={`Acima da quota: ${overQuota.map((o) => QUOTA_LABEL[o.resource] ?? o.resource).join(", ")}.`}
          />
        )}
        <div className="flex justify-end gap-2">
          <Link href="/instances">
            <Button type="button" variant="secondary">
              Cancelar
            </Button>
          </Link>
          <Button
            type="submit"
            disabled={create.isPending || selectedKeys.length === 0 || !imageId || !zoneId || overQuota.length > 0}
          >
            Criar instância
          </Button>
        </div>
      </form>
    </div>
  );
}
