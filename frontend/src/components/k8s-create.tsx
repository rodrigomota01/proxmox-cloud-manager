"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Icon } from "@/components/icons";
import type { K8sMode } from "@/components/k8s";
import { PageHeader } from "@/components/page";
import { Alert, Button, Card, ErrorBox, Field, Input, Select } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useSession } from "@/lib/session";

type Pool = { name: string; count: number; vcpus: number; memoryGb: number; disk: number };

const MEMORY_OPTIONS = [2, 4, 8, 16, 32, 64]; // GiB
const VCPU_OPTIONS = [1, 2, 4, 8, 16];
const NAME_RE = /^[a-z]([a-z0-9-]{1,28}[a-z0-9])$/;
const POOL_RE = /^[a-z]([a-z0-9-]{0,14}[a-z0-9])?$/;

function SizeFields({
  value,
  onChange,
  minDisk,
  minVcpus = 1,
  minMemoryGb = 2,
}: {
  value: Pool;
  onChange: (p: Pool) => void;
  minDisk: number;
  minVcpus?: number;
  minMemoryGb?: number;
}) {
  return (
    <>
      <Field label="vCPUs">
        <Select className="w-full" value={value.vcpus} onChange={(e) => onChange({ ...value, vcpus: Number(e.target.value) })}>
          {VCPU_OPTIONS.filter((n) => n >= minVcpus).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Memória">
        <Select className="w-full" value={value.memoryGb} onChange={(e) => onChange({ ...value, memoryGb: Number(e.target.value) })}>
          {MEMORY_OPTIONS.filter((g) => g >= minMemoryGb).map((g) => (
            <option key={g} value={g}>
              {g} GiB
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Disco (GiB)" hint={`Mínimo: ${minDisk} GiB`}>
        <Input
          type="number"
          min={Math.max(minDisk, 10)}
          max={2048}
          required
          value={value.disk || ""}
          onChange={(e) => onChange({ ...value, disk: Number(e.target.value) })}
        />
      </Field>
    </>
  );
}

/** Creates a Kubernetes cluster on the platform's VMs (ADR-0018). Admins pick the client
 * first; every client-scoped query then runs in that client's scope. */
export function K8sCreateForm({ mode }: { mode: K8sMode }) {
  const admin = mode === "admin";
  const base = admin ? "/admin/kubernetes" : "/kubernetes";
  const router = useRouter();
  const session = useSession();
  const [tenantId, setTenantId] = useState(admin ? "" : (session.tenantId ?? ""));
  const scoped = { headers: { "X-Tenant-Id": tenantId } };

  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/tenants")),
    enabled: admin,
  });
  const projects = useQuery({
    queryKey: ["projects", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/projects", { params: { query: { limit: 200 } }, ...scoped })).items,
    enabled: tenantId !== "",
  });
  const images = useQuery({
    queryKey: ["k8s-images", tenantId],
    queryFn: async () => unwrap(await api.GET("/api/v1/kubernetes/images", scoped)),
    enabled: tenantId !== "",
  });
  const regions = useQuery({
    queryKey: ["regions"],
    queryFn: async () => unwrap(await api.GET("/api/v1/regions")),
  });
  const keys = useQuery({
    queryKey: ["ssh-keys"],
    queryFn: async () => unwrap(await api.GET("/api/v1/ssh-keys")),
  });

  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [imageId, setImageId] = useState("");
  const image = images.data?.find((i) => i.id === imageId);
  const minDisk = Math.max(image?.min_disk_gb ?? 10, 10);
  const [cp, setCp] = useState<Pool>({ name: "cp", count: 1, vcpus: 2, memoryGb: 4, disk: 40 });
  const [pools, setPools] = useState<Pool[]>([{ name: "workers", count: 2, vcpus: 2, memoryGb: 4, disk: 40 }]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const zones = (regions.data ?? []).flatMap((r) => r.zones.map((z) => ({ id: z.id, label: `${r.name} · ${z.name}` })));
  const zoneImages = (images.data ?? []).filter((i) => zoneId && i.zone_ids.includes(zoneId));

  const addresses = useQuery({
    queryKey: ["zone-addresses", tenantId, zoneId, imageId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/zones/{zone_id}/addresses", {
          params: { path: { zone_id: zoneId }, query: imageId ? { image_id: imageId } : {} },
          ...scoped,
        }),
      ),
    enabled: tenantId !== "" && zoneId !== "",
  });
  const fromIpam = (addresses.data?.length ?? 0) > 0;

  // node names as the platform will create them: <cluster>-<pool>-<n>, control plane first
  const nodes = useMemo(() => {
    const prefix = name || "cluster";
    return [
      `${prefix}-cp-1`,
      ...pools.flatMap((p) => Array.from({ length: p.count }, (_, i) => `${prefix}-${p.name || "pool"}-${i + 1}`)),
    ];
  }, [name, pools]);

  const [nodeAddr, setNodeAddr] = useState<string[]>([]); // IPAM ids or "IP/prefix"
  const [lbAddr, setLbAddr] = useState("");
  const [gateway, setGateway] = useState("");
  const [bridge, setBridge] = useState("");
  const [vlan, setVlan] = useState("");
  const [dns, setDns] = useState("");
  const chosen = new Set([...nodeAddr, lbAddr].filter(Boolean));

  const totals = useMemo(() => {
    const all = [cp, ...pools];
    return {
      nodes: all.reduce((a, p) => a + p.count, 0),
      vcpus: all.reduce((a, p) => a + p.count * p.vcpus, 0),
      memoryGb: all.reduce((a, p) => a + p.count * p.memoryGb, 0),
      disk: all.reduce((a, p) => a + p.count * p.disk, 0),
    };
  }, [cp, pools]);

  const create = useMutation({
    mutationFn: async ({ body, key }: { body: Schemas["K8sProvision"]; key: string }) =>
      admin
        ? unwrap(
            await api.POST("/api/v1/admin/kubernetes/clusters/provision", {
              body: { ...body, tenant_id: tenantId },
              headers: { "Idempotency-Key": key },
            }),
          )
        : unwrap(await api.POST("/api/v1/kubernetes/clusters", { body, headers: { "Idempotency-Key": key } })),
    onSuccess: (res) => router.push(`${base}/${res.job.resource_id}`),
  });

  const poolNames = pools.map((p) => p.name);
  const poolsValid =
    pools.every((p) => POOL_RE.test(p.name) && p.name !== "cp" && p.count >= 1) &&
    new Set(poolNames).size === poolNames.length;
  const networkValid =
    nodeAddr.slice(0, nodes.length).filter(Boolean).length === nodes.length &&
    lbAddr !== "" &&
    (fromIpam || gateway !== "");
  const ready = tenantId && NAME_RE.test(name) && projectId && zoneId && imageId && poolsValid && networkValid;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const dnsList = dns.split(/[\s,]+/).filter(Boolean);
    const size = (p: Pool) => ({ vcpus: p.vcpus, memory_mb: p.memoryGb * 1024, disk_gb: p.disk });
    const ids = nodeAddr.slice(0, nodes.length);
    create.mutate({
      key: crypto.randomUUID(),
      body: {
        name,
        project_id: projectId,
        zone_id: zoneId,
        image_id: imageId,
        control_plane: size(cp),
        workers: pools.map((p) => ({ name: p.name, count: p.count, ...size(p) })),
        ssh_key_ids: selectedKeys,
        network: fromIpam
          ? { mode: "ipam", node_address_ids: ids, lb_address_id: lbAddr, dns: dnsList }
          : {
              mode: "static",
              node_ipv4: ids.map((address) => ({ address: address.trim(), gateway: gateway.trim(), dns: dnsList })),
              lb_ip: lbAddr.trim(),
              ...(admin && bridge ? { bridge: bridge.trim() } : {}),
              ...(admin && vlan ? { vlan: Number(vlan) } : {}),
            },
      },
    });
  }

  const setPool = (i: number, p: Pool) => setPools((cur) => cur.map((x, j) => (j === i ? p : x)));
  const addressOptions = (current: string) =>
    (addresses.data ?? []).filter((a) => a.id === current || !chosen.has(a.id));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Criar cluster Kubernetes"
        breadcrumbs={[{ label: "Kubernetes" }, { label: "Clusters", href: base }, { label: "Criar" }]}
        description="A plataforma cria as VMs, instala o Kubernetes com kubeadm e entrega o cluster com Cilium (rede e Gateway API), MetalLB, cert-manager e local-path."
      />
      <form onSubmit={submit} className="grid items-start gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="1. Básico">
            <div className="grid gap-4 sm:grid-cols-2">
              {admin && (
                <Field label="Cliente" hint="O cluster, as VMs e a quota são deste cliente.">
                  <Select
                    className="w-full"
                    required
                    value={tenantId}
                    onChange={(e) => {
                      setTenantId(e.target.value);
                      setProjectId("");
                      setImageId("");
                      setNodeAddr([]);
                      setLbAddr("");
                    }}
                  >
                    <option value="" disabled>
                      Selecione…
                    </option>
                    {tenants.data?.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Nome do cluster" hint="Minúsculas, números e hífen (3 a 30). Vira o prefixo das VMs.">
                <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} required placeholder="producao" />
              </Field>
              <Field label="Projeto" hint="As VMs dos nós ficam neste projeto.">
                <Select className="w-full" required disabled={!tenantId} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
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
              <Field label="Zona">
                <Select
                  className="w-full"
                  required
                  value={zoneId}
                  onChange={(e) => {
                    setZoneId(e.target.value);
                    setImageId("");
                    setNodeAddr([]);
                    setLbAddr("");
                  }}
                >
                  <option value="" disabled>
                    Selecione…
                  </option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Versão do Kubernetes" hint="Cada imagem traz uma versão fixa.">
                <Select className="w-full" required disabled={!zoneId} value={imageId} onChange={(e) => setImageId(e.target.value)}>
                  <option value="" disabled>
                    {!zoneId ? "Escolha a zona primeiro" : zoneImages.length ? "Selecione…" : "Nenhuma imagem Kubernetes nesta zona"}
                  </option>
                  {zoneImages.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.kubernetes_version} — {i.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>

          <Card title="2. Control plane" description="Um nó (alta disponibilidade com 3 nós chega numa próxima fase).">
            <div className="grid gap-4 sm:grid-cols-3">
              <SizeFields value={cp} onChange={setCp} minDisk={minDisk} minVcpus={2} />
            </div>
          </Card>

          <Card
            title="3. Pools de workers"
            description="Grupos de nós iguais; cada pool pode ter um tamanho diferente."
            actions={
              pools.length < 5 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setPools((cur) => [...cur, { name: `pool${cur.length + 1}`, count: 1, vcpus: 2, memoryGb: 4, disk: 40 }])}
                >
                  <Icon name="plus" /> Adicionar pool
                </Button>
              )
            }
          >
            <div className="space-y-4">
              {pools.map((p, i) => (
                <div key={i} className="grid gap-4 rounded-md border border-slate-200 p-3 sm:grid-cols-5 dark:border-slate-800">
                  <Field label="Nome do pool">
                    <Input value={p.name} onChange={(e) => setPool(i, { ...p, name: e.target.value.toLowerCase() })} required />
                  </Field>
                  <Field label="Nós">
                    <Input type="number" min={1} max={20} value={p.count} onChange={(e) => setPool(i, { ...p, count: Number(e.target.value) })} />
                  </Field>
                  <SizeFields value={p} onChange={(v) => setPool(i, v)} minDisk={minDisk} />
                  {pools.length > 1 && (
                    <div className="sm:col-span-5">
                      <Button type="button" variant="secondary" onClick={() => setPools((cur) => cur.filter((_, j) => j !== i))}>
                        Remover pool
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {!poolsValid && <Alert variant="warning">Nomes de pool: minúsculas/números/hífen, únicos e diferentes de “cp”.</Alert>}
            </div>
          </Card>

          <Card title="4. Rede" description="Todos os nós e o IP do load balancer ficam na mesma rede: o MetalLB anuncia o IP a partir dos nós.">
            {!zoneId ? (
              <p className="text-sm text-slate-500">Escolha a zona primeiro.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {nodes.map((n, i) => (
                    <Field key={n} label={n}>
                      {fromIpam ? (
                        <Select
                          className="w-full"
                          required
                          value={nodeAddr[i] ?? ""}
                          onChange={(e) => setNodeAddr((cur) => Object.assign([...cur], { [i]: e.target.value }))}
                        >
                          <option value="" disabled>
                            Selecione…
                          </option>
                          {addressOptions(nodeAddr[i] ?? "").map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.address}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Input
                          required
                          placeholder="203.0.113.10/28"
                          value={nodeAddr[i] ?? ""}
                          onChange={(e) => setNodeAddr((cur) => Object.assign([...cur], { [i]: e.target.value }))}
                        />
                      )}
                    </Field>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="IP do load balancer" hint="IP público do Gateway compartilhado (HTTPRoute).">
                    {fromIpam ? (
                      <Select className="w-full" required value={lbAddr} onChange={(e) => setLbAddr(e.target.value)}>
                        <option value="" disabled>
                          Selecione…
                        </option>
                        {addressOptions(lbAddr).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.address}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input required placeholder="203.0.113.20" value={lbAddr} onChange={(e) => setLbAddr(e.target.value)} />
                    )}
                  </Field>
                  {!fromIpam && (
                    <Field label="Gateway">
                      <Input required placeholder="203.0.113.14" value={gateway} onChange={(e) => setGateway(e.target.value)} />
                    </Field>
                  )}
                  <Field label="DNS (opcional)" hint="Padrão: 8.8.8.8 1.1.1.1">
                    <Input placeholder="8.8.8.8 1.1.1.1" value={dns} onChange={(e) => setDns(e.target.value)} />
                  </Field>
                  {admin && !fromIpam && (
                    <>
                      <Field label="Bridge (opcional)" hint="Padrão: a do template.">
                        <Input placeholder="vmbr0" value={bridge} onChange={(e) => setBridge(e.target.value)} />
                      </Field>
                      <Field label="VLAN (opcional)">
                        <Input type="number" min={1} max={4094} value={vlan} onChange={(e) => setVlan(e.target.value)} />
                      </Field>
                    </>
                  )}
                </div>
                {fromIpam ? (
                  <p className="text-xs text-slate-500">IPs livres no cadastro de IPs desta zona; ficam reservados enquanto o cluster existir.</p>
                ) : (
                  <p className="text-xs text-slate-500">
                    Esta zona não tem IPs no cadastro: digite IP/prefixo de cada nó. A plataforma impede IPs repetidos entre as VMs dela, mas
                    não detecta IPs usados fora dela.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="5. Chaves SSH (opcional)" description="Para acessar os nós por SSH, se precisar diagnosticar.">
            {keys.data?.length === 0 ? (
              <p className="text-sm text-slate-500">Você não tem chaves SSH cadastradas.</p>
            ) : (
              <ul className="space-y-2">
                {keys.data?.map((k) => (
                  <li key={k.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(k.id)}
                        onChange={(e) =>
                          setSelectedKeys((cur) => (e.target.checked ? [...cur, k.id] : cur.filter((id) => id !== k.id)))
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
                ["Kubernetes", image?.kubernetes_version ?? "—"],
                ["Nós", `${totals.nodes} (1 control plane + ${totals.nodes - 1} workers)`],
                ["Total", `${totals.vcpus} vCPU · ${totals.memoryGb} GiB · ${totals.disk} GiB disco`],
                ["Componentes", "Cilium · Gateway API · MetalLB · cert-manager · local-path"],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              A criação leva alguns minutos. As VMs contam na quota e nos custos do cliente como qualquer VM.
            </p>
            <div className="mt-4 space-y-3">
              <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
              <div className="flex gap-2">
                <Button type="submit" className="flex-1" disabled={!ready || create.isPending}>
                  Criar cluster
                </Button>
                <Link href={base}>
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
