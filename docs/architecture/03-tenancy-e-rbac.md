# 03 — Modelo de tenant e RBAC

## Hierarquia

```
Platform                       (operador do Cloud Manager — você)
 └── Tenant  (= Organization)  isolamento, quota, cobrança
      ├── Members (users)
      ├── Quotas / Price table
      ├── Networks, Images privadas, SSH keys
      └── Project               agrupamento operacional
           └── Instances (VM/LXC), Volumes, Snapshots
```

**Decisão:** `Tenant` e `Organization` são o mesmo conceito. Dois níveis acima de
`Project` (Organization → Tenant → Project) duplicariam regras de quota, cobrança e
isolamento sem ganho real para o caso de uso (consultoria/hosting multi-cliente). Se no
futuro um cliente precisar de "sub-organizações", isso vira hierarquia de projetos
(`projects.parent_id`), não um terceiro nível de tenant.

## Isolamento de tenant — defesa em profundidade

| Camada | Mecanismo | O que impede |
|---|---|---|
| 1. API | IDs opacos (UUIDv7), nunca `vmid`/`node` vindos do cliente | Enumeração e acesso direto ao guest por número |
| 2. Autorização | `authorize(principal, permission, resource)` resolve o projeto/tenant **do recurso carregado do banco**, não do que o cliente enviou | Confused deputy (`tenant_id` forjado no body) |
| 3. Repositório | Toda query tenant-scoped exige um `TenantScope`; não existe método `get_by_id` sem escopo | Esquecer o `WHERE tenant_id = …` |
| 4. PostgreSQL RLS | `SET LOCAL app.tenant_ids = '{…}'` por transação; policy `tenant_id = ANY(current_setting('app.tenant_ids')::uuid[])` | Bug na camada 3 vazando dados |
| 5. Provider | Instâncias de tenants ficam em *resource pools* `cm-<tenant>-<project>` e com tag `cm-managed` no PVE | Ajuda auditoria/recuperação; o isolamento real é na plataforma |
| 6. Resposta | Recurso de outro tenant → **404**, nunca 403 | Vazamento de existência |
| 7. Testes | Matriz cross-tenant obrigatória em CI (GET/POST/PUT/DELETE/WS) | Regressão |

### RLS na prática

```sql
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;
-- sem FORCE: o dono (cm_owner, usado só por migrations/seeds) não é afetado;
-- o role de runtime (cm_app) não é dono → a policy sempre se aplica a ele.

CREATE POLICY tenant_isolation ON instances
  USING (
    current_setting('app.platform_scope', true) = 'on'
    OR tenant_id = ANY (string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[])
  )
  WITH CHECK (
    current_setting('app.platform_scope', true) = 'on'
    OR tenant_id = ANY (string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[])
  );
```

- O role de conexão da aplicação (`cm_app`) **não é dono** das tabelas e não tem
  `BYPASSRLS`. Migrations rodam com `cm_owner`.
- Comportamento validado na Fase 0 (PostgreSQL 16, roles criados por
  `deploy/docker/postgres/init/01-roles.sh`): `cm_app` sem contexto vê **0 linhas**;
  com `app.tenant_ids = A` vê só A; `INSERT` de linha do tenant B estando no escopo A é
  rejeitado pela policy; DDL é negado.
- `app.tenant_ids` recebe **só o tenant ativo da requisição** (header
  `X-Tenant-Id` validado contra as memberships), não todos os tenants do usuário.
  Usuários com binding de plataforma (que valem para todos os tenants) podem entrar
  num tenant sem membership; cada request assim gera audit `PLATFORM_SCOPE_ACCESS`.
- `app.platform_scope = on` só é setado por endpoints `/api/v1/admin/*` após checagem
  de permissão de plataforma; toda request com esse escopo gera audit
  `PLATFORM_SCOPE_ACCESS`.
- Settings usam `SET LOCAL` (escopo de transação) → seguro com pool de conexões.

## RBAC

### Modelo

```
Permission  = "<recurso>:<ação>"        ex.: vm:start
Role        = conjunto de permissions   ex.: OPERATOR
RoleBinding = (user, role, scope)       scope = platform | tenant:<id> | project:<id>
```

Herança de escopo: binding em `tenant:X` vale para todos os projetos de X; binding em
`platform` vale para todos os tenants. A verificação percorre
`project → tenant → platform` e para no primeiro binding que conceda a permissão.

```python
async def authorize(principal, permission: str, resource: Scoped) -> None:
    scopes = [("project", resource.project_id), ("tenant", resource.tenant_id), ("platform", None)]
    if not await rbac.has_permission(principal.user_id, permission, scopes):
        audit.denied(principal, permission, resource)
        raise NotFound() if not await rbac.can_see(principal, resource) else Forbidden()
```

### Roles do sistema

| Role | Escopo típico | Intenção |
|---|---|---|
| `SUPER_ADMIN` | platform | Tudo, inclusive gerenciar admins e credenciais de cluster. Break-glass; poucos usuários; MFA obrigatório. |
| `PLATFORM_ADMIN` | platform | Operar a plataforma: clusters, sync, tenants, quotas, preços. Não gerencia SUPER_ADMIN. |
| `TENANT_ADMIN` | tenant | Tudo dentro do tenant: membros, projetos, recursos, billing view. |
| `PROJECT_ADMIN` | project | Tudo dentro do projeto, incluindo membros do projeto. |
| `OPERATOR` | project/tenant | Ciclo de vida das instâncias, sem criar/destruir. |
| `USER` | project | Criar e operar recursos próprios do projeto, console, SSH. |
| `READ_ONLY` | qualquer | Somente leitura. |

### Matriz de permissões (MVP + previstas)

Legenda: ✅ concede · — não concede

| Permission | SUPER | PLATF. | TEN_ADM | PROJ_ADM | OPER. | USER | RO |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `vm:view` / `container:view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `vm:start` `vm:stop` `vm:restart` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `vm:console` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `vm:create` `vm:delete` | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| `vm:configure` (resize, NIC, disco) | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| `vm:migrate` | ✅ | ✅ | — | — | — | — | — |
| `container:*` (análogo a `vm:*`) | ✅ | ✅ | ✅ | ✅ | parcial¹ | ✅ | — |
| `snapshot:create` `snapshot:rollback` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `template:clone` | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| `template:create` (privado do tenant) | ✅ | ✅ | ✅ | — | — | — | — |
| `template:publish` (público) | ✅ | ✅ | — | — | — | — | — |
| `storage:view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `storage:create` `storage:delete` | ✅ | ✅ | — | — | — | — | — |
| `network:view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `network:manage` (redes do tenant) | ✅ | ✅ | ✅ | — | — | — | — |
| `project:create` `project:delete` | ✅ | ✅ | ✅ | — | — | — | — |
| `member:manage` | ✅ | ✅ | ✅ | ✅² | — | — | — |
| `quota:view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `quota:manage` | ✅ | ✅ | — | — | — | — | — |
| `billing:view` (no projeto: só os custos dele) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `k8s:view` (clusters vinculados ao tenant, sem kubeconfig) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `billing:manage` (preços) | ✅ | ✅ | — | — | — | — | — |
| `audit:view` | ✅ | ✅ | ✅³ | — | — | — | — |
| `tenant:create` `tenant:delete` | ✅ | ✅ | — | — | — | — | — |
| `tenant:manage` | ✅ | ✅ | ✅ | — | — | — | — |
| `cluster:manage` `cluster:sync` | ✅ | ✅ | — | — | — | — | — |
| `node:view` | ✅ | ✅ | — | — | — | — | — |
| `user:manage` (contas: dados, ativação, desbloqueio, reset) | ✅ | ✅ | — | — | — | — | — |
| `platform:admin` (gerenciar admins) | ✅ | — | — | — | — | — | — |

¹ OPERATOR: `container:start|stop|restart|console`, sem create/delete/configure.
² PROJECT_ADMIN só gerencia membros do próprio projeto e não pode conceder role acima da sua.
³ TENANT_ADMIN vê só a auditoria do próprio tenant (RLS).

### Regras anti-escalonamento

- Ninguém concede role com permissões que não possui no mesmo escopo.
- Ninguém altera o próprio binding.
- Remover o último `TENANT_ADMIN` de um tenant é bloqueado.
- Bindings de `platform` só via `/api/v1/admin/*` com `platform:admin`.
- Administração de contas (`user:manage`): ninguém edita/desativa a própria conta por lá
  (usa o perfil); o admin precisa ter todas as permissões de plataforma da conta-alvo
  (PLATFORM_ADMIN não mexe em SUPER_ADMIN); o último SUPER_ADMIN ativo não pode ser
  desativado nem rebaixado; desativar encerra todas as sessões na hora.

### Onde o RBAC é aplicado

1. **Dependência FastAPI por rota** (`Depends(require("vm:start"))`) para checagem
   rápida de escopo.
2. **Serviço de domínio** chama `authorize()` com o recurso carregado — é a checagem
   que vale. A dependência da rota é conveniência, não segurança.
3. **WebSocket**: permissão verificada na emissão do ticket e novamente no upgrade.
4. **Frontend** recebe `GET /api/v1/me/permissions?scope=…` só para esconder botões —
   nunca como controle de acesso.
