# 09 — Estrutura do repositório

Monorepo: backend, frontend, deploy e docs evoluem juntos e o contrato OpenAPI é
gerado no mesmo commit que o frontend consome.

```
cloud-manager/
├── README.md
├── docker-compose.yml            # dev: traefik, frontend, api, worker, postgres, redis
├── .env.example
├── docs/
│   ├── architecture/             # este conjunto de documentos
│   ├── adr/                      # Architecture Decision Records
│   ├── api/openapi.json          # gerado pelo CI (Fase 1)
│   └── roadmap.md
├── backend/
├── frontend/
├── deploy/
│   ├── docker/postgres/init/     # cria roles cm_owner / cm_app
│   ├── proxmox/                  # role/ACL do usuário técnico (Fase 1)
│   ├── helm/cloud-manager/       # Fase 6
│   └── openshift/                # overlays (SCC restricted-v2, Routes) — Fase 6
└── terraform/
    ├── modules/                  # postgres, redis, k8s app, dns
    └── environments/{dev,staging,production}/
```

## Backend

```
backend/
├── pyproject.toml                # deps + ruff + mypy + pytest + import-linter
├── Dockerfile                    # multi-stage, non-root; mesmo image para api e worker
├── alembic.ini
├── migrations/                   # Alembic (Fase 1)
├── app/
│   ├── main.py                   # create_app(): middlewares, routers, lifespan
│   ├── core/                     # config (pydantic-settings), logging JSON, request-id,
│   │                             # erros problem+json, segurança (hash, jwt), ids (uuid7)
│   ├── api/
│   │   ├── deps.py               # get_principal, get_tenant_scope, require(permission)
│   │   ├── health.py             # /healthz /readyz
│   │   └── v1/router.py          # agrega routers dos módulos
│   ├── db/                       # engine, session, UoW, RLS (SET LOCAL), base model
│   ├── auth/                     # login, refresh, sessions, password reset, (oidc/)
│   ├── iam/                      # users, roles, permissions, bindings, authorize()
│   ├── tenancy/                  # tenants, memberships, projects, quotas
│   ├── compute/                  # instances, volumes, snapshots
│   ├── images/                   # templates / catálogo
│   ├── storage/                  # storage classes (pools oferecidos)
│   ├── network/                  # redes de tenant, IPAM
│   ├── pricing/                  # tabelas de preço, estimativa
│   ├── billing/                  # uso e custo (Fase 4)
│   ├── audit/                    # gravação e consulta
│   ├── jobs/                     # modelo de job, fila em Postgres, handlers registry
│   ├── inventory/                # reconciliador, drifts, adoção
│   ├── access/                   # console proxy, terminal, ssh gateway, tickets
│   ├── realtime/                 # WS hub, pub/sub Redis
│   ├── admin/                    # rotas /admin/*
│   ├── providers/
│   │   ├── base.py               # CloudProvider Protocol + tipos do domínio
│   │   ├── registry.py           # cluster_id → provider
│   │   ├── fake.py               # FakeProvider para testes
│   │   └── proxmox/
│   │       ├── client.py  cluster.py  nodes.py  vms.py  containers.py
│   │       ├── storage.py  network.py  templates.py  console.py  tasks.py
│   │       ├── mapper.py  errors.py  provider.py
│   ├── infra/
│   │   ├── redis.py  secrets.py  ratelimit.py  metrics.py  tracing.py
│   └── worker/
│       └── main.py               # loop: jobs + reconciliador + manutenção
└── tests/
    ├── unit/
    ├── integration/              # Postgres/Redis reais via testcontainers
    ├── api/
    ├── security/                 # tenant isolation + RBAC matrix (obrigatórios)
    ├── providers/proxmox/        # contra mock HTTP (respx) da PVE API
    └── e2e/                      # opcional, contra lab Proxmox real (marcador @lab)
```

### Layout interno de um módulo de domínio

```
compute/
├── router.py       # FastAPI: só HTTP (parse, status code, chama service)
├── schemas.py      # Pydantic: entrada/saída da API
├── service.py      # regras de negócio, authorize(), quota, cria job, audit
├── repository.py   # SQLAlchemy; exige TenantScope em toda query
├── models.py       # ORM
├── jobs.py         # handlers de job (instance.create, instance.power…)
└── permissions.py  # constantes de permissão do módulo
```

Regras (enforced por `import-linter`):
- `router` → `service` → `repository` / `providers.base` / `jobs`.
- `service` de um módulo pode chamar `service` de outro (ex.: compute → tenancy.quota),
  nunca `repository` de outro.
- Ninguém fora de `providers/proxmox` importa `providers.proxmox`.

## Frontend

```
frontend/
├── package.json  tsconfig.json  next.config.ts  tailwind (v4, via postcss)
├── Dockerfile                    # build standalone, non-root
└── src/
    ├── app/
    │   ├── (auth)/login/page.tsx
    │   ├── (console)/                   # layout com sidebar + seletor de tenant/projeto
    │   │   ├── dashboard/page.tsx
    │   │   ├── instances/page.tsx
    │   │   ├── instances/[id]/(tabs)/…  # overview, console, terminal, hardware, snapshots…
    │   │   ├── images/  networks/  storage/  projects/  members/  billing/  audit/
    │   │   └── admin/                   # clusters, nodes, tenants, quotas, pricing, jobs
    │   ├── layout.tsx
    │   └── page.tsx
    ├── lib/
    │   ├── api/                         # cliente gerado do OpenAPI (openapi-typescript + fetch)
    │   ├── auth/                        # access token em memória, refresh silencioso
    │   ├── ws/                          # cliente de eventos com reconexão
    │   └── rbac.ts                      # can("vm:start") — só para UI
    ├── components/
    │   ├── ui/                          # primitives (shadcn/ui)
    │   ├── instances/  console/  terminal/  confirm-dialog/
    └── hooks/
```

Escolhas do frontend:

- **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui** — componentes acessíveis
  sem framework pesado.
- **TanStack Query** para cache de servidor; eventos WS apenas invalidam queries.
- **Cliente tipado gerado do OpenAPI** — quebra de contrato vira erro de compilação.
- **noVNC** (console VGA) e **xterm.js** (terminal/SSH), carregados só nas abas que usam.
- O Next.js **não** é BFF nem guarda tokens no servidor: é UI. Toda autorização está na
  API. Isso mantém um único ponto de segurança e permite trocar o front sem risco.
- `ConfirmDialog` com digitação do nome para toda ação destrutiva, espelhando o
  `confirm` exigido pela API.
