"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { Menu, PageHeader, ResourceIcon } from "@/components/page";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, formatDate, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useT, type MessageKey } from "@/lib/i18n";
import { money, resourceLabel } from "@/lib/money";

const RESOURCES = ["vcpu", "memory_gb", "disk_gb", "instance"] as const;
const HINT: Record<string, MessageKey> = {
  vcpu: "costs.pricing.hint.vcpu",
  memory_gb: "costs.pricing.hint.memoryGb",
  disk_gb: "costs.pricing.hint.diskGb",
  instance: "costs.pricing.hint.instance",
};

function pricesFrom(form: FormData): Schemas["PriceSet"] {
  return Object.fromEntries(
    RESOURCES.map((r) => [r, String(form.get(r) ?? "0").replace(",", ".") || "0"]),
  ) as Schemas["PriceSet"];
}

function PriceInputs({ prices, compact = false }: { prices?: Record<string, string>; compact?: boolean }) {
  const t = useT();
  return (
    <div className={`grid gap-3 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-4"}`}>
      {RESOURCES.map((r) => (
        <Field key={r} label={t("costs.pricing.perMonth", { resource: resourceLabel(r) })} hint={t(HINT[r])}>
          <Input
            name={r}
            inputMode="decimal"
            required
            pattern="\d+([.,]\d{1,6})?"
            defaultValue={prices ? String(Number(prices[r])) : "0"}
          />
        </Field>
      ))}
    </div>
  );
}

function TableEditor({ table }: { table: Schemas["PriceTableOut"] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "price-tables"] });
  const save = useMutation({
    mutationFn: async (body: Schemas["PriceTableUpdate"]) =>
      unwrap(
        await api.PATCH("/api/v1/admin/price-tables/{table_id}", {
          params: { path: { table_id: table.id } },
          body,
        }),
      ),
    onSuccess: () => {
      setSaved(true);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["admin", "billing"] });
    },
  });
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE("/api/v1/admin/price-tables/{table_id}", {
          params: { path: { table_id: table.id } },
        }),
      ),
    onSuccess: refresh,
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Icon name="tag" className="h-4 w-4 text-brand-600 dark:text-brand-400" />
          {table.name}
          {table.is_default && <Badge tone="brand">{t("costs.pricing.default")}</Badge>}
        </span>
      }
      description={
        table.tenants.length > 0
          ? t(table.tenants.length === 1 ? "costs.pricing.usedByOne" : "costs.pricing.usedByOther", {
              count: table.tenants.length,
            })
          : table.is_default
            ? t("costs.pricing.defaultFallback")
            : t("costs.pricing.unused")
      }
      actions={
        <Menu
          ariaLabel={t("costs.pricing.tableActions", { name: table.name })}
          items={[
            !table.is_default && { label: t("costs.pricing.makeDefault"), onClick: () => save.mutate({ is_default: true }) },
            { label: history ? t("costs.pricing.hideHistory") : t("costs.pricing.history"), onClick: () => setHistory((h) => !h) },
            !table.is_default &&
              table.tenants.length === 0 && {
                label: t("costs.pricing.delete"),
                danger: true,
                onClick: () => confirm(t("costs.pricing.confirmDelete", { name: table.name })) && remove.mutate(),
              },
          ]}
        />
      }
    >
      <form
        key={table.history[0]?.effective_from ?? table.id}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          const f = new FormData(e.currentTarget);
          save.mutate({ name: String(f.get("name")).trim(), prices: pricesFrom(f) });
        }}
      >
        <Field label={t("costs.pricing.name")}>
          <Input name="name" required maxLength={100} defaultValue={table.name} className="max-w-sm" />
        </Field>
        <PriceInputs prices={table.prices} />
        <ErrorBox message={save.isError ? errorMessage(save.error) : remove.isError ? errorMessage(remove.error) : null} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="secondary" disabled={save.isPending}>
            {t("costs.pricing.save")}
          </Button>
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">{t("costs.pricing.saved")}</span>}
          <Button type="button" variant="link" className="ml-auto" onClick={() => setHistory((h) => !h)}>
            {history ? t("costs.pricing.hideHistory") : t("costs.pricing.history")}
          </Button>
        </div>
      </form>
      {history && (
        <div className={`${tbl.wrap} -mx-5 mt-4 border-t border-slate-200 dark:border-slate-800`}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>{t("costs.pricing.since")}</th>
                <th className={tbl.th}>{t("costs.pricing.resource")}</th>
                <th className={`${tbl.th} text-right`}>{t("costs.pricing.pricePerMonth")}</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {table.history.map((h) => (
                <tr key={`${h.resource}-${h.effective_from}`} className={tbl.tr}>
                  <td className={tbl.td}>{formatDate(h.effective_from)}</td>
                  <td className={tbl.td}>{resourceLabel(h.resource)}</td>
                  <td className={`${tbl.td} text-right tabular-nums`}>{money(h.monthly_price, "BRL", true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function NewTableDialog({
  open,
  onClose,
  makeDefault,
}: {
  open: boolean;
  onClose: () => void;
  makeDefault: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async (body: Schemas["PriceTableCreate"]) =>
      unwrap(await api.POST("/api/v1/admin/price-tables", { body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "price-tables"] });
      close();
    },
  });
  const close = () => {
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={t("costs.pricing.newTableTitle")}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({
            name: String(f.get("name")).trim(),
            prices: pricesFrom(f),
            is_default: f.get("is_default") === "on",
          });
        }}
      >
        <Field label={t("costs.pricing.name")} hint={t("costs.pricing.nameHint")}>
          <Input name="name" required maxLength={100} />
        </Field>
        <PriceInputs compact />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_default" defaultChecked={makeDefault} />
          {t("costs.pricing.useAsDefault")}
        </label>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            {t("costs.pricing.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t("costs.pricing.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type CostVisibility = Schemas["TenantCostOut"]["cost_visibility"];

const COST_VISIBILITY: { value: CostVisibility; label: MessageKey }[] = [
  { value: "full", label: "costs.pricing.visibility.full" },
  { value: "usage", label: "costs.pricing.visibility.usage" },
  { value: "none", label: "costs.pricing.visibility.none" },
];

function TenantAssignments({ tables }: { tables: Schemas["PriceTableOut"][] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: ["admin", "billing", "summary", "current"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/billing/summary")),
  });
  const assign = useMutation({
    mutationFn: async ({ tenantId, tableId }: { tenantId: string; tableId: string | null }) =>
      unwrap(
        await api.PUT("/api/v1/admin/tenants/{tenant_id}/price-table", {
          params: { path: { tenant_id: tenantId } },
          body: { price_table_id: tableId },
        }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "billing"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "price-tables"] });
    },
  });
  const visibility = useMutation({
    mutationFn: async ({ tenantId, value }: { tenantId: string; value: CostVisibility }) =>
      unwrap(
        await api.PUT("/api/v1/admin/tenants/{tenant_id}/cost-visibility", {
          params: { path: { tenant_id: tenantId } },
          body: { cost_visibility: value },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "billing"] }),
  });
  const def = tables.find((tb) => tb.is_default);
  const error = [assign, visibility, summary].find((q) => q.isError)?.error;
  return (
    <Card
      title={t("costs.pricing.byClient")}
      description={t("costs.pricing.byClientDescription")}
      flush
    >
      {error && (
        <div className="px-5 pb-3">
          <ErrorBox message={errorMessage(error)} />
        </div>
      )}
      {summary.data?.tenants.length === 0 ? (
        <Empty icon="building">{t("costs.pricing.noClients")}</Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={`${tbl.table} min-w-[40rem]`}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>{t("costs.pricing.client")}</th>
                <th className={tbl.th}>{t("costs.pricing.priceTable")}</th>
                <th className={tbl.th}>{t("costs.pricing.visibleToClient")}</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {summary.data?.tenants.map((row) => (
                <tr key={row.tenant_id} className={tbl.tr}>
                  <td className={tbl.td}>
                    <div className="flex items-start gap-2">
                      <ResourceIcon kind="tenant" className="mt-0.5" />
                      <div>
                        <div className="font-medium">{row.name}</div>
                        <div className="text-xs text-slate-500">{row.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td className={tbl.td}>
                    <Select
                      aria-label={t("costs.pricing.priceTableOf", { name: row.name })}
                      value={row.custom_price_table ? (row.price_table_id ?? "") : ""}
                      disabled={assign.isPending}
                      onChange={(e) => assign.mutate({ tenantId: row.tenant_id, tableId: e.target.value || null })}
                    >
                      <option value="">{def ? t("costs.pricing.defaultOptionNamed", { name: def.name }) : t("costs.pricing.defaultOption")}</option>
                      {tables
                        .filter((tb) => !tb.is_default)
                        .map((tb) => (
                          <option key={tb.id} value={tb.id}>
                            {tb.name}
                          </option>
                        ))}
                    </Select>
                  </td>
                  <td className={tbl.td}>
                    <Select
                      aria-label={t("costs.pricing.visibilityOf", { name: row.name })}
                      value={row.cost_visibility}
                      disabled={visibility.isPending}
                      onChange={(e) =>
                        visibility.mutate({ tenantId: row.tenant_id, value: e.target.value as CostVisibility })
                      }
                    >
                      {COST_VISIBILITY.map((v) => (
                        <option key={v.value} value={v.value}>
                          {t(v.label)}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function AdminPricingPage() {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const tables = useQuery({
    queryKey: ["admin", "price-tables"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/price-tables")),
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("costs.pricing.title")}
        breadcrumbs={[{ label: t("costs.pricing.breadcrumb") }, { label: t("costs.pricing.title") }]}
        description={t("costs.pricing.description")}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" /> {t("costs.pricing.newTable")}
          </Button>
        }
      />
      <ErrorBox message={tables.isError ? errorMessage(tables.error) : null} />
      {tables.data?.length === 0 && (
        <Card>
          <Empty
            icon="tag"
            title={t("costs.pricing.emptyTitle")}
            action={
              <Button onClick={() => setCreating(true)}>
                <Icon name="plus" /> {t("costs.pricing.newTable")}
              </Button>
            }
          >
            {t("costs.pricing.emptyBody")}
          </Empty>
        </Card>
      )}
      {tables.data?.map((table) => <TableEditor key={table.id} table={table} />)}
      {tables.data && <TenantAssignments tables={tables.data} />}
      <NewTableDialog
        open={creating}
        onClose={() => setCreating(false)}
        makeDefault={!tables.data?.some((table) => table.is_default)}
      />
    </div>
  );
}
