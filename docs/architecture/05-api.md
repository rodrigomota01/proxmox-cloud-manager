# 05 — API v1 (especificação inicial)

A especificação OpenAPI 3.1 é **gerada pelo FastAPI** a partir dos schemas Pydantic
(`/api/v1/openapi.json`, UI em `/api/docs` só fora de produção). Este documento define as
convenções e o inventário de endpoints; o contrato executável é o OpenAPI gerado e
versionado em `docs/api/openapi.json` pelo CI.

## Convenções

| Tema | Regra |
|---|---|
| Base | `/api/v1`. Breaking change → `/api/v2`. |
| Recursos | Substantivos do domínio: `instances`, `images`, `volumes`, `networks`. **`/instances` cobre VM e LXC** (`?kind=vm\|container`), conforme a abstração da seção 32 do requisito. |
| Tenant ativo | Header `X-Tenant-Id` (UUID) obrigatório em rotas tenant-scoped; validado contra memberships. Projeto vem no recurso ou em `?project_id=`. |
| IDs | UUID em toda a API. `vmid`/`node` só aparecem em `/admin/*`. |
| Ações | `POST /instances/{id}/start` (verbo como sub-recurso). |
| Assíncrono | Mutação que toca o provider → `202 Accepted` + `{"job": {...}}` + header `Location: /api/v1/jobs/{id}`. |
| Idempotência | `Idempotency-Key` aceito (e recomendado) em todo `POST` de criação; chave + usuário + rota guardada 24h. |
| Destrutivas | `DELETE` e `rollback` exigem `confirm` no body igual ao nome do recurso (`{"confirm": "web-01"}`). A confirmação visual é do front; esta é a garantia no backend. |
| Paginação | Cursor: `?limit=50&cursor=…` → `{"items": [...], "next_cursor": "…"}` |
| Filtro/ordem | `?status=running&tag=prod&sort=-created_at` (allowlist por endpoint) |
| Concorrência | `ETag`/`If-Match` (campo `version`) em `PATCH`. |
| Erros | RFC 9457 `application/problem+json` (abaixo). |
| Correlation | Request: `X-Request-Id` opcional; Response: sempre `X-Request-Id`. |
| Rate limit | Headers `RateLimit-Limit`, `RateLimit-Remaining`, `Retry-After` em 429. |

### Formato de erro

```json
{
  "type": "https://cloud-manager.dev/errors/quota-exceeded",
  "title": "Quota exceeded",
  "status": 409,
  "detail": "Tenant quota for vcpus would be exceeded (requested 4, available 2).",
  "code": "QUOTA_EXCEEDED",
  "request_id": "01J9Z3X8…",
  "errors": [{"field": "vcpus", "message": "exceeds available quota"}]
}
```

Códigos estáveis: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `QUOTA_EXCEEDED`, `CONFIRMATION_REQUIRED`, `RATE_LIMITED`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_TASK_FAILED`, `INTERNAL_ERROR`.

### Exemplo — criar instância

```http
POST /api/v1/instances
Authorization: Bearer eyJ…
X-Tenant-Id: 0192f6d4-…
Idempotency-Key: 6b0c…

{
  "project_id": "0192f6d5-…",
  "name": "ubuntu-web-01",
  "kind": "vm",
  "image_id": "0192f6aa-…",
  "vcpus": 4,
  "memory_gb": 8,
  "root_disk_gb": 100,
  "network_id": "0192f6bb-…",
  "ssh_key_ids": ["0192f6cc-…"],
  "tags": ["web", "prod"]
}
```

```http
HTTP/1.1 202 Accepted
Location: /api/v1/jobs/0192f6dd-…

{
  "instance": {"id": "0192f6de-…", "name": "ubuntu-web-01", "state": "provisioning", ...},
  "job": {"id": "0192f6dd-…", "type": "instance.create", "status": "pending"},
  "estimated_monthly_cost": {"amount": "74.00", "currency": "USD"}
}
```

## Inventário de endpoints

Fase indica quando entra. Permissão é a checada no serviço de domínio.

### Auth & sessão (Fase 1)

| Método | Rota | Permissão | Notas |
|---|---|---|---|
| POST | `/auth/login` | pública | rate limit por IP + por e-mail; retorna access token, seta cookie de refresh |
| POST | `/auth/refresh` | cookie | rotação; reuso detectado revoga a família |
| POST | `/auth/logout` | autenticado | revoga refresh atual |
| POST | `/auth/logout-all` | autenticado | revoga todas as sessões do usuário |
| POST | `/auth/password/forgot` | pública | resposta sempre 202 (não revela se e-mail existe) |
| POST | `/auth/password/reset` | token de reset | token de uso único, 30 min |
| POST | `/auth/mfa/*` | autenticado | Fase 1 só modelo; TOTP na Fase 5/6 |
| GET | `/me` | autenticado | perfil + tenants |
| GET | `/me/permissions?scope=platform\|tenant:<id>\|project:<id>` | autenticado (escopo `project` exige `X-Tenant-Id`) | para a UI esconder ações |
| PATCH | `/me` | autenticado | nome de exibição (e-mail só via admin) |
| POST | `/me/password` | autenticado | exige a senha atual; encerra as outras sessões |
| GET/DELETE | `/me/sessions` · `/me/sessions/{id}` | autenticado | sessões próprias |

### Tenancy & IAM (Fase 1)

| Método | Rota | Permissão |
|---|---|---|
| GET/POST | `/tenants` | GET: memberships do usuário; POST: `tenant:create` (opcional `admin_email` → TENANT_ADMIN, convidado se novo) |
| GET/PATCH/DELETE | `/tenants/{tenantId}` | GET: membro; PATCH: `tenant:manage`; DELETE: `tenant:delete` + confirm (slug), só sem projetos |
| GET/POST | `/tenants/{tenantId}/members` | `member:manage` no escopo do binding (tenant ou projeto); e-mail desconhecido vira convite |
| DELETE | `/tenants/{tenantId}/members/{userId}` | `member:manage` (tenant) |
| GET/POST | `/projects` | GET: `vm:view` no tenant lista todos, senão só projetos com binding; POST: `project:create` |
| GET/PATCH/DELETE | `/projects/{projectId}` | `vm:view` (projeto) / `project:create` / `project:delete` + confirm (slug), soft delete |
| GET/POST/DELETE | `/role-bindings` | `member:manage` (+ regras anti-escalonamento) |
| GET | `/roles` | autenticado |

### Compute (Fase 1: leitura + power; Fase 2: criar/alterar)

| Método | Rota | Permissão | Fase |
|---|---|---|---|
| GET | `/instances` | `vm:view` / `container:view` | 1 |
| GET | `/instances/{id}` | `vm:view` | 1 |
| POST | `/instances/{id}/start` · `/stop` · `/shutdown` · `/restart` | `vm:start` / `vm:stop` / `vm:restart` (`container:*` para LXC) → 202 + job; uma operação ativa por instância (409); `Idempotency-Key` aceito | 1 |
| POST | `/instances/{id}/suspend` · `/resume` | `vm:stop` / `vm:start` | 2 |
| POST | `/instances` | `vm:create` no projeto → 202 + job `instance.create`; imagem visível ao tenant, chaves do próprio usuário, IP estático único no cluster, quota | 2a ✅ |
| PATCH | `/instances/{id}` | `vm:configure` (nome, tags, vCPU, RAM) | 2 |
| DELETE | `/instances/{id}` | `vm:delete` + `confirm` (nome) → 202 + job `instance.delete` | 2a ✅ |
| POST | `/instances/{id}/clone` | `vm:create` + `vm:view` origem | 2 |
| GET/POST | `/instances/{id}/volumes` | `vm:configure` | 2 |
| POST | `/instances/{id}/volumes/{volId}/resize` | `vm:configure` | 2 |
| GET/POST | `/instances/{id}/snapshots` | `snapshot:create` | 2 |
| POST | `/instances/{id}/snapshots/{name}/rollback` | `snapshot:rollback` + confirm | 2 |
| GET/POST/DELETE | `/instances/{id}/nics` | `vm:configure` | 2 |
| POST | `/instances/{id}/console-tickets` | `vm:console` | 3 |
| POST | `/instances/{id}/ssh-tickets` | `vm:console` | 3 |
| GET | `/instances/{id}/metrics?range=hour\|day\|week` | `vm:view` (RRD do PVE; cache Redis 30s/5min; 503 se o provider cair) | 2a ✅ |
| GET | `/instances/{id}/events` | `vm:view` | 3 |

### Catálogo, storage e rede (Fase 2)

| Método | Rota | Permissão |
|---|---|---|
| GET | `/images` | membro do tenant (públicas + do tenant, ativas; sem ids do provider) |
| POST | `/images` | `template:create` (a partir de instância parada) |
| PATCH/DELETE | `/images/{id}` | `template:create` / `template:publish` |
| GET | `/storage-classes` | `storage:view` (storage pools oferecidos, sem detalhes do PVE) |
| GET/POST/DELETE | `/networks` | `network:view` / `network:manage` |
| GET/POST/DELETE | `/ssh-keys` | dono (só chaves públicas; tipo e base64 validados, fingerprint SHA256) |

### Quota, preço, billing (Fase 4)

| Método | Rota | Permissão |
|---|---|---|
| GET | `/quotas` | membro do tenant → `{resource, limit, used, available}` (2a ✅) |
| POST | `/pricing/estimate` | autenticado (calcula custo de um spec) |
| GET | `/billing/usage?from=&to=&group_by=project` | `billing:view` |

### Jobs, eventos, auditoria

| Método | Rota | Permissão | Fase |
|---|---|---|---|
| GET | `/jobs` · `/jobs/{id}` | dono do job ou `vm:view`/`container:view` no projeto; eventos sem dados do provider | 1 |
| POST | `/jobs/{id}/cancel` | dono | 2 |
| GET | `/audit-logs` | `audit:view` (tenant) | 1 (gravação) / 5 (UI) |
| GET | `/dashboard/summary` | autenticado (escopo do tenant) | 1 |
| WS | `/ws/events` | autenticado (ticket) | 3 |
| WS | `/ws/console/{sessionId}` | ticket de console | 3 |
| WS | `/ws/terminal/{sessionId}` | ticket de SSH | 3 |

### Administração de plataforma (`/admin/*`, Fase 1+)

| Método | Rota | Permissão |
|---|---|---|
| GET/POST | `/admin/clusters` | `cluster:manage` |
| GET/PATCH/DELETE | `/admin/clusters/{id}` | `cluster:manage` |
| PUT | `/admin/clusters/{id}/credentials` | `cluster:manage` (write-only; nunca retorna o segredo) |
| POST | `/admin/clusters/{id}/test` | `cluster:manage` |
| POST | `/admin/clusters/{id}/sync` | `cluster:sync` → 202 job (`cluster.sync`) |
| GET | `/admin/clusters/{id}/sync-runs` | `cluster:manage` |
| GET | `/admin/tenants` | `tenant:create` (todos os tenants; `/tenants` lista só memberships) |
| GET/POST | `/admin/users` | `user:manage` (busca `?q=`; criar = convite por e-mail) |
| GET/PATCH | `/admin/users/{id}` | `user:manage` (nome, e-mail, ativo; regras anti-escalonamento) |
| POST | `/admin/users/{id}/unlock` · `/password-reset` · `/sessions/revoke` | `user:manage` |
| PUT | `/admin/users/{id}/platform-roles` | `platform:admin` |
| GET | `/admin/nodes` · `/admin/nodes/{id}` | `node:view` (uso real + vCPU/RAM alocadas às VMs do node) |
| GET | `/admin/nodes/{id}/metrics?range=hour\|day\|week` | `node:view` (RRD do node; cache) |
| GET | `/admin/instances?managed=false` | `node:view` (descobertos) |
| POST | `/admin/instances/{id}/adopt` | `cluster:manage` → atribui tenant/projeto |
| GET | `/admin/storage` · `/admin/networks` | `cluster:manage` |
| GET/PUT | `/admin/tenants/{id}/quotas` | `quota:manage` (sem linha = padrão da plataforma) |
| GET | `/admin/clusters/{id}/templates` | `template:publish` (templates visíveis ao token) |
| GET/POST/PATCH | `/admin/images` · `/admin/images/{id}` | `template:publish` (exige drive de cloud-init) |
| GET/POST | `/admin/price-tables` | `billing:manage` |
| GET | `/admin/jobs` · `/admin/jobs/{id}` | `cluster:manage` (inclui dados dos eventos: UPID, node) |
| GET | `/admin/audit-logs` | `platform:admin` ou `audit:view` (platform) |

### Operacional (sem auth, não roteado publicamente para `/metrics`)

| Rota | Uso |
|---|---|
| `GET /healthz` | liveness (processo vivo) |
| `GET /readyz` | readiness (Postgres + Redis acessíveis) |
| `GET /metrics` | Prometheus — exposto só na rede interna/ServiceMonitor |
