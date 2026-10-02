# 01 — Visão geral da arquitetura

## Objetivo

O Cloud Manager é uma **camada de cloud management multi-tenant sobre o Proxmox VE**.
O Proxmox continua sendo o hypervisor e a fonte de verdade do estado de execução; a
plataforma adiciona o que o Proxmox não resolve para self-service: tenants, projetos,
RBAC por escopo, quotas, preço, catálogo de imagens, auditoria, console/SSH mediados e
uma API estável que não vaza conceitos do PVE.

O usuário enxerga `Instance`, `Image`, `Volume`, `Network`, `Project`, `Tenant`.
Ele **não** enxerga `qemu config`, `UPID`, `vmid`, `node` (o node aparece só para
administradores de plataforma).

## Princípios

1. **Monólito modular + worker** — um único backend FastAPI com módulos de domínio bem
   separados e um processo worker que executa jobs longos. Sem microsserviços no MVP
   ([ADR-0001](../adr/0001-monolito-modular.md)).
2. **Provider abstraction desde o dia 1** — o domínio fala com `CloudProvider`; o
   `ProxmoxProvider` é a única implementação inicial ([ADR-0002](../adr/0002-provider-abstraction.md)).
3. **Proxmox é a fonte de verdade do runtime; o banco é a fonte de verdade de posse,
   intenção e política** ([ADR-0003](../adr/0003-fonte-de-verdade-e-sincronizacao.md)).
4. **Isolamento de tenant em duas camadas** — escopo obrigatório na aplicação +
   Row-Level Security no PostgreSQL ([ADR-0004](../adr/0004-isolamento-de-tenant.md)).
5. **Tudo que demora vira job** — HTTP responde `202 Accepted` com `job_id`; o worker
   executa e publica progresso ([ADR-0006](../adr/0006-jobs-em-postgres.md)).
6. **O browser nunca fala com o Proxmox** — nem API, nem WebSocket de console. O backend
   é proxy autenticado ([ADR-0008](../adr/0008-console-proxy.md)).
7. **Credenciais nunca em texto puro** — token do PVE cifrado em repouso (envelope
   encryption), SSH com certificados efêmeros ([ADR-0007](../adr/0007-credenciais-proxmox.md),
   [ADR-0009](../adr/0009-ssh-certificados-efemeros.md)).

## Topologia de deploy (MVP)

```mermaid
flowchart TB
    user([Usuário / Browser])
    subgraph edge[Borda]
        traefik[Traefik / Ingress<br/>TLS, roteamento por path]
    end
    subgraph app[Cloud Manager]
        fe[Frontend<br/>Next.js]
        api[API<br/>FastAPI + Uvicorn<br/>REST + WebSocket]
        worker[Worker<br/>jobs + reconciliação]
        sshgw[SSH Gateway<br/>módulo da API no MVP]
    end
    subgraph data[Dados]
        pg[(PostgreSQL<br/>estado, jobs, auditoria)]
        redis[(Redis<br/>pub/sub, rate limit,<br/>tickets efêmeros)]
    end
    subgraph pve[Proxmox VE]
        pveapi[PVE API :8006]
        n1[pve01] & n2[pve02] & n3[pve03]
    end

    user -- "HTTPS / WSS" --> traefik
    traefik -- "/" --> fe
    traefik -- "/api, /ws" --> api
    api <--> pg
    api <--> redis
    worker <--> pg
    worker --> redis
    api -- "API token (server-side)" --> pveapi
    worker -- "API token (server-side)" --> pveapi
    sshgw -. "SSH (rede de gerência)" .-> n1
    pveapi --- n1 & n2 & n3
```

Frontend e API ficam **na mesma origem** (`https://cloud.exemplo.com/` e
`https://cloud.exemplo.com/api`). Isso elimina CORS na operação normal e permite
cookie `SameSite=Strict` para o refresh token ([ADR-0005](../adr/0005-autenticacao.md)).

## Diagrama de componentes (backend)

```mermaid
flowchart LR
    subgraph API[API Layer — app/api]
        routers[Routers REST v1]
        ws[WebSocket hub<br/>events, console, terminal]
        mw[Middlewares<br/>request-id, auth, rate limit,<br/>tenant context, logging]
    end

    subgraph Domain[Business Layer — módulos de domínio]
        auth[auth]
        iam[iam<br/>users, roles, bindings]
        tenancy[tenancy<br/>tenants, projects, quotas]
        compute[compute<br/>instances, snapshots]
        images[images<br/>templates]
        storage[storage<br/>volumes, pools]
        network[network]
        billing[pricing / billing]
        audit[audit]
        jobs[jobs]
        inventory[inventory / sync]
        access[access<br/>console, ssh]
    end

    subgraph Infra[Infrastructure Layer]
        db[db<br/>SQLAlchemy, RLS, UoW]
        cache[redis<br/>pubsub, limiter]
        secrets[secrets<br/>envelope encryption]
        obs[observability<br/>logs, metrics, traces]
    end

    subgraph Providers[Provider Integration Layer]
        base[CloudProvider<br/>interface]
        pxp[ProxmoxProvider]
        pxc[ProxmoxClient<br/>httpx, retry, task poller]
    end

    routers --> mw --> Domain
    ws --> access
    ws --> jobs
    Domain --> db
    Domain --> cache
    compute & images & storage & network & inventory & access --> base
    base --> pxp --> pxc
    pxp --> secrets
```

Regra de dependência (verificada por `import-linter` a partir da Fase 1):

- `api` → `domain` → (`infra`, `providers.base`)
- `providers.proxmox` → `providers.base`, `infra.secrets`
- **Nenhum módulo de domínio importa `providers.proxmox`**. O provider é resolvido por
  cluster em runtime através de um registry.

## Fluxos principais

### Ação síncrona curta: `start` de uma instância

`start` no PVE já é uma task assíncrona (devolve `UPID`), então até ações "simples"
viram job. A diferença é que são jobs curtos e a UI mostra progresso inline.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant DB as PostgreSQL
    participant W as Worker
    participant P as Proxmox API
    participant R as Redis

    B->>A: POST /api/v1/instances/{id}/actions/start
    A->>A: authn (JWT) → principal
    A->>DB: SET LOCAL app.tenant_ids, SELECT instance (RLS)
    A->>A: authz instance:start no escopo do projeto
    A->>DB: INSERT job (pending) + audit_log (mesma transação)
    A-->>B: 202 {job_id, status: pending}
    W->>DB: SELECT ... FOR UPDATE SKIP LOCKED
    W->>P: POST /nodes/{node}/qemu/{vmid}/status/start
    P-->>W: UPID
    loop até terminar
        W->>P: GET /nodes/{node}/tasks/{upid}/status
        W->>R: PUBLISH job progress
    end
    W->>DB: UPDATE job (succeeded), instance.power_state
    R-->>A: evento
    A-->>B: WS: job.succeeded / instance.updated
```

### Criação de instância a partir de imagem

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant DB as PostgreSQL
    participant W as Worker
    participant P as Proxmox

    B->>A: POST /instances {name, image_id, flavor, volume_gb, network_id, ssh_key_id}<br/>Idempotency-Key
    A->>A: validar + authz instance:create (projeto)
    A->>DB: BEGIN, lock quota do tenant/projeto, reservar CPU/RAM/disco/IP
    A->>DB: INSERT instance (state=provisioning), job, audit, COMMIT
    A-->>B: 202 {job_id, instance_id}
    W->>P: POST /qemu/{template}/clone (newid, pool, storage, full)
    W->>P: PUT /qemu/{vmid}/config (cores, memory, ipconfig0, sshkeys, tags)
    W->>P: PUT /qemu/{vmid}/resize (scsi0 +N G)
    W->>P: POST /qemu/{vmid}/status/start
    W->>P: GET agent/network-get-interfaces (IP)
    W->>DB: instance(state=active, ip), quota reservation → committed
    Note over W,DB: Falha em qualquer etapa → compensação:<br/>destroy do vmid criado, liberar reserva, job=failed
```

### Console web

Ver [07 — Tempo real, console e SSH](07-realtime-console-ssh.md).

## Requisitos não-funcionais e como são atendidos

| Requisito | Como |
|---|---|
| Isolamento entre tenants | Escopo obrigatório no repositório + RLS no PostgreSQL + IDs opacos (UUID) + 404 para recurso de outro tenant + suíte de testes cross-tenant |
| Proxmox indisponível não derruba a UI | Leituras servem do inventário em banco (com `last_synced_at`), circuit breaker por cluster, erros em `application/problem+json` com `request_id` |
| Operações longas não bloqueiam HTTP | Jobs em PostgreSQL + worker, progresso por WebSocket |
| Auditabilidade | `audit_logs` append-only, gravado na mesma transação da intenção |
| Extensível para outros hypervisors | `CloudProvider` + registry; modelo de domínio sem campos do PVE (exceto `provider_ref` JSONB) |
| Escala horizontal | API stateless; WebSocket fan-out via Redis pub/sub; worker com `SKIP LOCKED` permite N réplicas |
| Observabilidade | Logs JSON com `request_id`/`tenant_id`, `/metrics` Prometheus, OpenTelemetry opcional |
