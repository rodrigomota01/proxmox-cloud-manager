"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { Menu, PageHeader, ResourceIcon } from "@/components/page";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, formatDate, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { money, RESOURCE_LABEL } from "@/lib/money";

const RESOURCES = ["vcpu", "memory_gb", "disk_gb", "instance"] as const;
const HINT: Record<string, string> = {
  vcpu: "por vCPU, com a instância ligada",
  memory_gb: "por GiB de RAM, com a instância ligada",
  disk_gb: "por GiB de disco alocado, sempre",
  instance: "por instância existente, sempre",
};

function pricesFrom(form: FormData): Schemas["PriceSet"] {
  return Object.fromEntries(
    RESOURCES.map((r) => [r, String(form.get(r) ?? "0").replace(",", ".") || "0"]),
  ) as Schemas["PriceSet"];
}

function PriceInputs({ prices, compact = false }: { prices?: Record<string, string>; compact?: boolean }) {
  return (
    <div className={`grid gap-3 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-4"}`}>
      {RESOURCES.map((r) => (
        <Field key={r} label={`${RESOURCE_LABEL[r]} / mês`} hint={HINT[r]}>
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
          <Icon name="tag" className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          {table.name}
          {table.is_default && <Badge tone="indigo">padrão</Badge>}
        </span>
      }
      description={
        table.tenants.length > 0 ? `Usada por ${table.tenants.length} cliente(s)` : table.is_default ? "Vale para clientes sem tabela própria" : "Nenhum cliente usa esta tabela"
      }
      actions={
        <Menu
          ariaLabel={`Ações da tabela ${table.name}`}
          items={[
            !table.is_default && { label: "Tornar padrão", onClick: () => save.mutate({ is_default: true }) },
            { label: history ? "Ocultar histórico" : "Histórico de preços", onClick: () => setHistory((h) => !h) },
            !table.is_default &&
              table.tenants.length === 0 && {
                label: "Excluir",
                danger: true,
                onClick: () => confirm(`Excluir a tabela "${table.name}"?`) && remove.mutate(),
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
        <Field label="Nome">
          <Input name="name" required maxLength={100} defaultValue={table.name} className="max-w-sm" />
        </Field>
        <PriceInputs prices={table.prices} />
        <ErrorBox message={save.isError ? errorMessage(save.error) : remove.isError ? errorMessage(remove.error) : null} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="secondary" disabled={save.isPending}>
            Salvar
          </Button>
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Salvo. Novos preços valem a partir de agora.</span>}
          <Button type="button" variant="link" className="ml-auto" onClick={() => setHistory((h) => !h)}>
            {history ? "Ocultar histórico" : "Histórico de preços"}
          </Button>
        </div>
      </form>
      {history && (
        <div className={`${tbl.wrap} -mx-5 mt-4 border-t border-slate-200 dark:border-slate-800`}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>Desde</th>
                <th className={tbl.th}>Recurso</th>
                <th className={`${tbl.th} text-right`}>Preço/mês</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {table.history.map((h) => (
                <tr key={`${h.resource}-${h.effective_from}`} className={tbl.tr}>
                  <td className={tbl.td}>{formatDate(h.effective_from)}</td>
                  <td className={tbl.td}>{RESOURCE_LABEL[h.resource] ?? h.resource}</td>
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
    <Dialog open={open} onClose={close} title="Nova tabela de preços">
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
        <Field label="Nome" hint="Ex.: um contrato com desconto para um cliente.">
          <Input name="name" required maxLength={100} />
        </Field>
        <PriceInputs compact />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_default" defaultChecked={makeDefault} />
          Usar como tabela padrão
        </label>
        <ErrorBox message={create.isError ? errorMessage(create.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Criar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type CostVisibility = Schemas["TenantCostOut"]["cost_visibility"];

const COST_VISIBILITY: { value: CostVisibility; label: string }[] = [
  { value: "full", label: "Custos e uso de recursos" },
  { value: "usage", label: "Somente uso de recursos (sem valores)" },
  { value: "none", label: "Oculto" },
];

function TenantAssignments({ tables }: { tables: Schemas["PriceTableOut"][] }) {
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
  const def = tables.find((t) => t.is_default);
  const error = [assign, visibility, summary].find((q) => q.isError)?.error;
  return (
    <Card
      title="Por cliente"
      description="Clientes sem tabela própria usam a padrão; a troca vale a partir de agora e o que já foi acumulado mantém o preço da época. A visibilidade define o que os usuários do cliente veem em Custos."
      flush
    >
      {error && (
        <div className="px-5 pb-3">
          <ErrorBox message={errorMessage(error)} />
        </div>
      )}
      {summary.data?.tenants.length === 0 ? (
        <Empty icon="building">Nenhum cliente.</Empty>
      ) : (
        <div className={tbl.wrap}>
          <table className={`${tbl.table} min-w-[40rem]`}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>Cliente</th>
                <th className={tbl.th}>Tabela de preços</th>
                <th className={tbl.th}>Visível para o cliente</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {summary.data?.tenants.map((t) => (
                <tr key={t.tenant_id} className={tbl.tr}>
                  <td className={tbl.td}>
                    <div className="flex items-start gap-2">
                      <ResourceIcon kind="tenant" className="mt-0.5" />
                      <div>
                        <div className="font-medium">{t.name}</div>
                        <div className="text-xs text-slate-500">{t.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td className={tbl.td}>
                    <Select
                      aria-label={`Tabela de preços de ${t.name}`}
                      value={t.custom_price_table ? (t.price_table_id ?? "") : ""}
                      disabled={assign.isPending}
                      onChange={(e) => assign.mutate({ tenantId: t.tenant_id, tableId: e.target.value || null })}
                    >
                      <option value="">Padrão{def ? ` (${def.name})` : ""}</option>
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
                      aria-label={`O que ${t.name} vê em Custos`}
                      value={t.cost_visibility}
                      disabled={visibility.isPending}
                      onChange={(e) =>
                        visibility.mutate({ tenantId: t.tenant_id, value: e.target.value as CostVisibility })
                      }
                    >
                      {COST_VISIBILITY.map((v) => (
                        <option key={v.value} value={v.value}>
                          {v.label}
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
  const [creating, setCreating] = useState(false);
  const tables = useQuery({
    queryKey: ["admin", "price-tables"],
    queryFn: async () => unwrap(await api.GET("/api/v1/admin/price-tables")),
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Tabelas de preço"
        breadcrumbs={[{ label: "Custos" }, { label: "Tabelas de preço" }]}
        description="As VMs são precificadas pelos recursos alocados, com preço mensal (730 h) cobrado por segundo: vCPU e memória enquanto a instância está ligada; disco e taxa por instância enquanto ela existe."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" /> Nova tabela
          </Button>
        }
      />
      <ErrorBox message={tables.isError ? errorMessage(tables.error) : null} />
      {tables.data?.length === 0 && (
        <Card>
          <Empty
            icon="tag"
            title="Nenhuma tabela de preços"
            action={
              <Button onClick={() => setCreating(true)}>
                <Icon name="plus" /> Nova tabela
              </Button>
            }
          >
            Crie uma e torne-a padrão para começar a calcular custos.
          </Empty>
        </Card>
      )}
      {tables.data?.map((t) => <TableEditor key={t.id} table={t} />)}
      {tables.data && <TenantAssignments tables={tables.data} />}
      <NewTableDialog
        open={creating}
        onClose={() => setCreating(false)}
        makeDefault={!tables.data?.some((t) => t.is_default)}
      />
    </div>
  );
}
