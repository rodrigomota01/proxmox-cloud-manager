"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { NoTenant } from "@/components/no-tenant";
import { Menu, PageHeader, SearchInput, Toolbar } from "@/components/page";
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, tbl } from "@/components/ui";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api/client";
import { useProjectNames, useProjects } from "@/lib/queries";
import { ROLE_INFO, roleLabel } from "@/lib/roles";
import { usePermissions, useSession } from "@/lib/session";

type Member = Schemas["MemberOut"];
const TENANT_SCOPE = "__tenant__";

function useRoles() {
  return useQuery({
    queryKey: ["roles"],
    queryFn: async () => unwrap(await api.GET("/api/v1/roles")),
    staleTime: 300_000,
  });
}

/** Scope (whole tenant or one project) + a role allowed at that scope. */
function AccessFields({ scope, setScope }: { scope: string; setScope: (s: string) => void }) {
  const projects = useProjects();
  const roles = useRoles();
  const kind = scope === TENANT_SCOPE ? "tenant" : "project";
  const options = (roles.data ?? []).filter((r) => r.allowed_scopes.includes(kind));
  return (
    <>
      <Field label="Acesso a">
        <Select className="w-full" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value={TENANT_SCOPE}>Cliente inteiro (todos os projetos)</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              Projeto {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Papel">
        <Select name="role" className="w-full" required key={kind} defaultValue="">
          <option value="" disabled>
            Selecione…
          </option>
          {options.map((r) => (
            <option key={r.name} value={r.name}>
              {roleLabel(r.name)} — {ROLE_INFO[r.name]?.hint ?? r.description}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

function InviteDialog({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState(TENANT_SCOPE);
  const [result, setResult] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: async (body: Schemas["MemberAdd"]) =>
      unwrap(await api.POST("/api/v1/tenants/{tenant_id}/members", { params: { path: { tenant_id: tenantId } }, body })),
    onSuccess: (res, body) => {
      queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
      setResult(
        res.invited
          ? `${body.email} recebeu um convite por e-mail para definir a senha.`
          : `${body.email} já tinha conta e agora tem acesso.`,
      );
    },
  });
  const close = () => {
    setResult(null);
    invite.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Convidar membro">
      {result ? (
        <div className="space-y-4 text-sm">
          <p>{result}</p>
          <div className="flex justify-end">
            <Button onClick={close}>Fechar</Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const name = String(f.get("display_name") ?? "").trim();
            invite.mutate({
              email: String(f.get("email")),
              role: String(f.get("role")),
              ...(name ? { display_name: name } : {}),
              ...(scope !== TENANT_SCOPE ? { project_id: scope } : {}),
            });
          }}
          className="space-y-3"
        >
          <Field label="E-mail">
            <Input name="email" type="email" required />
          </Field>
          <Field label="Nome (para contas novas)">
            <Input name="display_name" maxLength={100} />
          </Field>
          <AccessFields scope={scope} setScope={setScope} />
          <ErrorBox message={invite.isError ? errorMessage(invite.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              Convidar
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function AddAccessDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const { tenantId } = useSession();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState(TENANT_SCOPE);
  const add = useMutation({
    mutationFn: async (body: { user_id: string; role: string; project_id?: string }) =>
      unwrap(await api.POST("/api/v1/role-bindings", { body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
      onClose();
    },
  });
  return (
    <Dialog open={member !== null} onClose={onClose} title={`Adicionar acesso para ${member?.display_name ?? ""}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          add.mutate({
            user_id: member!.user_id,
            role: String(f.get("role")),
            ...(scope !== TENANT_SCOPE ? { project_id: scope } : {}),
          });
        }}
        className="space-y-3"
      >
        <AccessFields scope={scope} setScope={setScope} />
        <ErrorBox message={add.isError ? errorMessage(add.error) : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={add.isPending}>
            Adicionar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function MembersPage() {
  const { tenantId, tenant, me } = useSession();
  const queryClient = useQueryClient();
  const perms = usePermissions(tenantId ? `tenant:${tenantId}` : null);
  const projectNames = useProjectNames();
  const [inviting, setInviting] = useState(false);
  const [adding, setAdding] = useState<Member | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);
  const [search, setSearch] = useState("");

  const members = useQuery({
    queryKey: ["members", tenantId],
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/tenants/{tenant_id}/members", { params: { path: { tenant_id: tenantId! } } })),
    enabled: tenantId !== null && perms.has("member:manage"),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
  const unbind = useMutation({
    mutationFn: async (bindingId: string) =>
      unwrap(await api.DELETE("/api/v1/role-bindings/{binding_id}", { params: { path: { binding_id: bindingId } } })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (userId: string) =>
      unwrap(
        await api.DELETE("/api/v1/tenants/{tenant_id}/members/{user_id}", {
          params: { path: { tenant_id: tenantId!, user_id: userId } },
        }),
      ),
    onSuccess: () => {
      setConfirmRemove(null);
      refresh();
    },
  });

  if (!tenantId) return <NoTenant />;
  if (perms.size > 0 && !perms.has("member:manage")) {
    return (
      <div className="space-y-4">
        <PageHeader title="Membros" />
        <Alert variant="info" title="Sem acesso">
          Só o admin do cliente gerencia membros de {tenant?.name}.
        </Alert>
      </div>
    );
  }
  const scopeLabel = (b: Schemas["BindingOut"]) =>
    b.scope_type === "tenant" ? "cliente inteiro" : `projeto ${projectNames.get(b.scope_id) ?? "?"}`;
  const error = unbind.error ?? remove.error;

  const q = search.trim().toLowerCase();
  const visible = (members.data ?? []).filter(
    (m) => !q || m.display_name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Membros de ${tenant?.name ?? ""}`}
        description="Cada pessoa vê apenas o que o acesso dela permite: o cliente inteiro ou só os projetos indicados."
        actions={<Button onClick={() => setInviting(true)}>Convidar membro</Button>}
      />
      <ErrorBox message={members.isError ? errorMessage(members.error) : error ? errorMessage(error) : null} />
      <Card flush>
        <Toolbar count={members.data ? `${visible.length} de ${members.data.length} membros` : undefined}>
          <SearchInput value={search} onChange={setSearch} placeholder="Filtrar por nome ou e-mail…" />
        </Toolbar>
        {members.data?.length === 0 ? (
          <Empty
            title="Nenhum membro"
            icon="users"
            action={<Button onClick={() => setInviting(true)}>Convidar membro</Button>}
          >
            Convide a equipe do cliente para gerenciar as VMs.
          </Empty>
        ) : members.data && visible.length === 0 ? (
          <Empty title="Nenhum resultado">Nenhum membro corresponde ao filtro.</Empty>
        ) : (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>Membro</th>
                  <th className={tbl.th}>Acessos</th>
                  <th className={tbl.th}>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {visible.map((m) => {
                  const self = m.user_id === me.id;
                  return (
                    <tr key={m.user_id} className={`${tbl.tr} align-top`}>
                      <td className={tbl.td}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{m.display_name}</span>
                          {self && <Badge tone="indigo">você</Badge>}
                          {m.invited && <Badge tone="amber">convite pendente</Badge>}
                        </div>
                        <div className="text-xs text-slate-500">{m.email}</div>
                      </td>
                      <td className={tbl.td}>
                        <ul className="flex flex-wrap gap-1.5">
                          {m.bindings.map((b) => (
                            <li
                              key={b.id}
                              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pr-1.5 pl-2.5 text-xs dark:border-slate-700 dark:bg-slate-800"
                            >
                              <span>
                                <strong>{roleLabel(b.role)}</strong> · {scopeLabel(b)}
                              </span>
                              {!self && (
                                <button
                                  aria-label={`Remover ${roleLabel(b.role)} de ${m.display_name}`}
                                  title="Remover este acesso"
                                  className="rounded-full p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                                  disabled={unbind.isPending}
                                  onClick={() => unbind.mutate(b.id)}
                                >
                                  <Icon name="x" className="h-3 w-3" />
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className={`${tbl.td} text-right`}>
                        {!self && (
                          <Menu
                            ariaLabel={`Ações de ${m.display_name}`}
                            items={[
                              { label: "Adicionar acesso", onClick: () => setAdding(m) },
                              { label: "Remover do cliente", danger: true, onClick: () => setConfirmRemove(m) },
                            ]}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <InviteDialog tenantId={tenantId} open={inviting} onClose={() => setInviting(false)} />
      <AddAccessDialog key={adding?.user_id ?? "none"} member={adding} onClose={() => setAdding(null)} />
      <Dialog open={confirmRemove !== null} onClose={() => setConfirmRemove(null)} title="Remover membro">
        <p className="text-sm">
          <strong>{confirmRemove?.display_name}</strong> perde imediatamente o acesso a {tenant?.name}. A conta
          continua existindo.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
            Cancelar
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(confirmRemove!.user_id)}>
            Remover
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
