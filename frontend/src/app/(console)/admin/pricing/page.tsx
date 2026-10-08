"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, formatDate } from "@/components/ui";
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
          {table.name}
          {table.is_default && <Badge tone="blue">padrão</Badge>}
          {table.tenants.length > 0 && <Badge>{table.tenants.length} cliente(s)</Badge>}
        </span>
      }
      actions={
        <>
          {!table.is_default && (
            <Button variant="ghost" onClick={() => save.mutate({ is_default: true })}>
              Tornar padrão
            </Button>
          )}
          {!table.is_default && table.tenants.length === 0 && (
            <Button
              variant="ghost"
              onClick={() => confirm(`Excluir a tabela "${table.name}"?`) && remove.mutate()}
            >
              Excluir
            </Button>
          )}
        </>
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
          {saved && <span className="text-sm text-emerald-600">Salvo. Novos preços valem a partir de agora.</span>}
          <button
            type="button"
            className="ml-auto text-sm text-indigo-600 hover:underline dark:text-indigo-400"
            onClick={() => setHistory((h) => !h)}
          >
            {history ? "Ocultar histórico" : "Histórico de preços"}
          </button>
        </div>
      </form>
      {history && (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 font-medium">Desde</th>
              <th className="py-1 font-medium">Recurso</th>
              <th className="py-1 text-right font-medium">Preço/mês</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {table.history.map((h) => (
              <tr key={`${h.resource}-${h.effective_from}`}>
                <td className="py-1">{formatDate(h.effective_from)}</td>
                <td className="py-1">{RESOURCE_LABEL[h.resource] ?? h.resource}</td>
                <td className="py-1 text-right tabular-nums">{money(h.monthly_price, "BRL", true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const def = tables.find((t) => t.is_default);
  return (
    <Card title="Tabela por cliente">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Clientes sem tabela própria usam a padrão. A troca vale a partir de agora; o que já foi acumulado
        mantém o preço da época.
      </p>
      <ErrorBox message={assign.isError ? errorMessage(assign.error) : summary.isError ? errorMessage(summary.error) : null} />
      {summary.data?.tenants.length === 0 && <Empty>Nenhum cliente.</Empty>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {summary.data?.tenants.map((t) => (
          <li key={t.tenant_id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
            <span className="font-medium">
              {t.name} <span className="font-normal text-slate-500">({t.slug})</span>
            </span>
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
          </li>
        ))}
      </ul>
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Preços</h1>
          <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            As VMs são precificadas pelos recursos alocados, com preço mensal (730 h) cobrado por segundo:
            vCPU e memória enquanto a instância está ligada; disco e taxa por instância enquanto ela existe.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Nova tabela</Button>
      </div>
      <ErrorBox message={tables.isError ? errorMessage(tables.error) : null} />
      {tables.data?.length === 0 && (
        <Empty>Nenhuma tabela. Crie uma e torne-a padrão para começar a calcular custos.</Empty>
      )}
      {tables.data?.map((t) => <TableEditor key={t.id} table={t} />)}
      {tables.data && tables.data.length > 0 && <TenantAssignments tables={tables.data} />}
      <NewTableDialog
        open={creating}
        onClose={() => setCreating(false)}
        makeDefault={!tables.data?.some((t) => t.is_default)}
      />
    </div>
  );
}
