"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";

type Region = Schemas["AdminRegionOut"];

const FLAG: Record<string, string> = { BR: "🇧🇷", US: "🇺🇸", CA: "🇨🇦" };

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "regions"] });
    queryClient.invalidateQueries({ queryKey: ["regions"] });
  };
}

function NewRegionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationFn: async (body: Schemas["RegionCreate"]) =>
      unwrap(await api.POST("/api/v1/admin/regions", { body })),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Nova região">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({
            slug: String(f.get("slug")),
            name: String(f.get("name")),
            country_code: String(f.get("country_code")),
            description: String(f.get("description") ?? ""),
          });
        }}
        className="space-y-3"
      >
        <Field label="Identificador" hint="Curto e estável, aparece na API. Ex.: br-sp, us-east, ca-central.">
          <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder="br-sp" />
        </Field>
        <Field label="Nome">
          <Input name="name" required maxLength={100} placeholder="Brasil - São Paulo" />
        </Field>
        <Field label="País (código ISO)" hint="BR, US, CA…">
          <Input name="country_code" required maxLength={2} placeholder="BR" />
        </Field>
        <Field label="Descrição (opcional)">
          <Input name="description" maxLength={500} />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Criar região
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NewZoneForm({ region }: { region: Region }) {
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: async (body: Schemas["ZoneCreate"]) =>
      unwrap(
        await api.POST("/api/v1/admin/regions/{region_id}/zones", {
          params: { path: { region_id: region.id } },
          body,
        }),
      ),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
  });
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Nova zona
      </Button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        create.mutate({ slug: String(f.get("slug")), name: String(f.get("name")) });
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <Field label="Identificador">
        <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder="sp02-hv08" className="w-40" />
      </Field>
      <Field label="Nome">
        <Input name="name" required maxLength={100} placeholder="SP02 HV08" className="w-48" />
      </Field>
      <Button type="submit" disabled={create.isPending}>
        Criar
      </Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
        Cancelar
      </Button>
      {create.isError && <ErrorBox message={errorMessage(create.error)} />}
    </form>
  );
}

function ZoneToggle({ zone }: { zone: Schemas["AdminZoneOut"] }) {
  const invalidate = useInvalidate();
  const toggle = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.PATCH("/api/v1/admin/zones/{zone_id}", {
          params: { path: { zone_id: zone.id } },
          body: { active: !zone.active },
        }),
      ),
    onSuccess: invalidate,
  });
  return (
    <Button variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
      {zone.active ? "Desativar" : "Ativar"}
    </Button>
  );
}

export default function RegionsPage() {
  const [creating, setCreating] = useState(false);
  const regions = useQuery({
    queryKey: ["admin", "regions"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/regions")),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Regiões e zonas</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Os usuários escolhem região e zona ao criar instâncias; a plataforma escolhe o servidor
            dentro da zona. Vincule servidores às zonas em{" "}
            <Link href="/admin/nodes" className="text-indigo-600 hover:underline dark:text-indigo-400">
              Hypervisors
            </Link>{" "}
            (aba Configuração de cada servidor)
            .
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Nova região</Button>
      </div>
      <ErrorBox message={regions.isError ? errorMessage(regions.error) : null} />
      {regions.data?.length === 0 && (
        <Card>
          <Empty>Nenhuma região. Crie a primeira, por exemplo “br-sp”.</Empty>
        </Card>
      )}
      {regions.data?.map((r) => (
        <Card
          key={r.id}
          title={
            <span className="flex items-center gap-2">
              <span aria-hidden>{FLAG[r.country_code] ?? "🌐"}</span>
              {r.name}
              <span className="font-mono text-xs font-normal text-slate-500">{r.slug}</span>
              {!r.active && <Badge tone="red">inativa</Badge>}
            </span>
          }
          actions={<NewZoneForm region={r} />}
        >
          {r.zones.length === 0 ? (
            <Empty>Nenhuma zona nesta região.</Empty>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Zona</th>
                  <th className="py-2 pr-4 font-medium">Servidores</th>
                  <th className="py-2 pr-4 font-medium">Situação</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {r.zones.map((z) => (
                  <tr key={z.id}>
                    <td className="py-2 pr-4">
                      <span className="font-medium">{z.name}</span>{" "}
                      <span className="font-mono text-xs text-slate-500">{z.slug}</span>
                    </td>
                    <td className="py-2 pr-4">{z.clusters.length ? z.clusters.join(", ") : "—"}</td>
                    <td className="py-2 pr-4">
                      {!z.active ? (
                        <Badge tone="red">Inativa</Badge>
                      ) : z.usable ? (
                        <Badge tone="green">Recebe instâncias</Badge>
                      ) : (
                        <Badge tone="amber">Sem servidor pronto</Badge>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <ZoneToggle zone={z} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ))}
      <NewRegionDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
