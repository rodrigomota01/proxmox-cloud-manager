"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/page";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Status, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT } from "@/lib/i18n";

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
  const t = useT();
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
    <Dialog open={open} onClose={onClose} title={t("infra.regions.newRegion")}>
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
        <Field label={t("infra.regions.slug")} hint={t("infra.regions.slugHint")}>
          <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder="br-sp" />
        </Field>
        <Field label={t("infra.common.name")}>
          <Input name="name" required maxLength={100} placeholder={t("infra.regions.namePlaceholder")} />
        </Field>
        <Field label={t("infra.regions.country")} hint="BR, US, CA…">
          <Input name="country_code" required maxLength={2} placeholder="BR" />
        </Field>
        <Field label={t("infra.common.descriptionOptional")}>
          <Input name="description" maxLength={500} />
        </Field>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("infra.common.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t("infra.regions.createRegion")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NewZoneForm({ region }: { region: Region }) {
  const t = useT();
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
        <Icon name="plus" /> {t("infra.regions.newZone")}
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
      <Field label={t("infra.regions.slug")}>
        <Input name="slug" required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" placeholder="sp02-hv08" className="w-40" />
      </Field>
      <Field label={t("infra.common.name")}>
        <Input name="name" required maxLength={100} placeholder="SP02 HV08" className="w-48" />
      </Field>
      <Button type="submit" disabled={create.isPending}>
        {t("infra.common.create")}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
        {t("infra.common.cancel")}
      </Button>
      {create.isError && <ErrorBox message={errorMessage(create.error)} />}
    </form>
  );
}

/** Name, country and description; the slug is fixed (servers and instances refer to it). */
function EditRegionDialog({ region, onClose }: { region: Region | null; onClose: () => void }) {
  const t = useT();
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: async (body: Schemas["RegionUpdate"]) =>
      unwrap(
        await api.PATCH("/api/v1/admin/regions/{region_id}", {
          params: { path: { region_id: region!.id } },
          body,
        }),
      ),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const close = () => {
    save.reset(); // an error from this edit must not show up on the next one
    onClose();
  };
  return (
    <Dialog open={region !== null} onClose={close} title={t("infra.regions.editRegion")}>
      {region && (
        <form
          key={region.id}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            save.mutate({
              name: String(f.get("name")),
              country_code: String(f.get("country_code")),
              description: String(f.get("description") ?? ""),
            });
          }}
          className="space-y-3"
        >
          <Field label={t("infra.regions.slug")} hint={t("infra.regions.slugFixed")}>
            <Input value={region.slug} disabled readOnly />
          </Field>
          <Field label={t("infra.common.name")}>
            <Input name="name" required maxLength={100} defaultValue={region.name} autoFocus />
          </Field>
          <Field label={t("infra.regions.country")} hint="BR, US, CA…">
            <Input name="country_code" required maxLength={2} defaultValue={region.country_code} />
          </Field>
          <Field label={t("infra.common.descriptionOptional")}>
            <Input name="description" maxLength={500} defaultValue={region.description} />
          </Field>
          <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              {t("infra.common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t("infra.common.save")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Name and description; the slug is fixed (servers and instances refer to it). */
function EditZoneDialog({ zone, onClose }: { zone: Schemas["AdminZoneOut"] | null; onClose: () => void }) {
  const t = useT();
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: async (body: Schemas["ZoneUpdate"]) =>
      unwrap(
        await api.PATCH("/api/v1/admin/zones/{zone_id}", {
          params: { path: { zone_id: zone!.id } },
          body,
        }),
      ),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const close = () => {
    save.reset();
    onClose();
  };
  return (
    <Dialog open={zone !== null} onClose={close} title={t("infra.regions.editZone")}>
      {zone && (
        <form
          key={zone.id}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            save.mutate({ name: String(f.get("name")), description: String(f.get("description") ?? "") });
          }}
          className="space-y-3"
        >
          <Field label={t("infra.regions.slug")} hint={t("infra.regions.slugFixed")}>
            <Input value={zone.slug} disabled readOnly />
          </Field>
          <Field label={t("infra.common.name")}>
            <Input name="name" required maxLength={100} defaultValue={zone.name} autoFocus />
          </Field>
          <Field label={t("infra.common.descriptionOptional")}>
            <Input name="description" maxLength={500} defaultValue={zone.description} />
          </Field>
          <ErrorBox message={save.isError ? errorMessage(save.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              {t("infra.common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t("infra.common.save")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ZoneToggle({ zone }: { zone: Schemas["AdminZoneOut"] }) {
  const t = useT();
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
      {zone.active ? t("infra.regions.deactivate") : t("infra.regions.activate")}
    </Button>
  );
}

export default function RegionsPage() {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [editingRegion, setEditingRegion] = useState<Region | null>(null);
  const [editingZone, setEditingZone] = useState<Schemas["AdminZoneOut"] | null>(null);
  const regions = useQuery({
    queryKey: ["admin", "regions"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/regions")),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("nav.regionsAndZones")}
        breadcrumbs={[{ label: t("nav.infrastructure") }, { label: t("nav.regionsAndZones") }]}
        description={
          <>
            {t("infra.regions.descriptionBefore")}
            <Link href="/admin/nodes" className="text-brand-600 hover:underline dark:text-brand-400">
              {t("nav.hypervisors")}
            </Link>
            {t("infra.regions.descriptionAfter")}
          </>
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" /> {t("infra.regions.newRegion")}
          </Button>
        }
      />
      <ErrorBox message={regions.isError ? errorMessage(regions.error) : null} />
      {regions.data?.length === 0 && (
        <Card>
          <Empty
            icon="globe"
            title={t("infra.regions.emptyTitle")}
            action={
              <Button onClick={() => setCreating(true)}>
                <Icon name="plus" /> {t("infra.regions.newRegion")}
              </Button>
            }
          >
            {t("infra.regions.emptyBody")}
          </Empty>
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
              {!r.active && <Badge tone="red">{t("infra.regions.inactiveBadge")}</Badge>}
            </span>
          }
          description={t(r.zones.length === 1 ? "infra.regions.zoneOne" : "infra.regions.zoneOther", { count: r.zones.length })}
          actions={
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="ghost" onClick={() => setEditingRegion(r)}>
                {t("infra.regions.editRegion")}
              </Button>
              <NewZoneForm region={r} />
            </div>
          }
          flush
        >
          {r.zones.length === 0 ? (
            <Empty icon="globe">{t("infra.regions.noZones")}</Empty>
          ) : (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={tbl.th}>{t("infra.common.zone")}</th>
                    <th className={tbl.th}>{t("infra.regions.servers")}</th>
                    <th className={tbl.th}>{t("infra.common.situation")}</th>
                    <th className={tbl.th} />
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {r.zones.map((z) => (
                    <tr key={z.id} className={tbl.tr}>
                      <td className={tbl.td}>
                        <span className="font-medium">{z.name}</span>{" "}
                        <span className="font-mono text-xs text-slate-500">{z.slug}</span>
                      </td>
                      <td className={tbl.td}>{z.clusters.length ? z.clusters.join(", ") : "—"}</td>
                      <td className={tbl.td}>
                        {!z.active ? (
                          <Status tone="off">{t("infra.regions.inactive")}</Status>
                        ) : z.usable ? (
                          <Status tone="ok">{t("infra.regions.receivesInstances")}</Status>
                        ) : (
                          <Status tone="warn">{t("infra.regions.noServerReady")}</Status>
                        )}
                      </td>
                      <td className={`${tbl.td} whitespace-nowrap text-right`}>
                        <Button variant="ghost" onClick={() => setEditingZone(z)}>
                          {t("infra.common.edit")}
                        </Button>
                        <ZoneToggle zone={z} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
      <NewRegionDialog open={creating} onClose={() => setCreating(false)} />
      <EditRegionDialog region={editingRegion} onClose={() => setEditingRegion(null)} />
      <EditZoneDialog zone={editingZone} onClose={() => setEditingZone(null)} />
    </div>
  );
}
