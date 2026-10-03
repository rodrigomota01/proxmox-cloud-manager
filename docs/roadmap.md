# Roadmap do MVP

Cada fase entrega algo utilizável, com testes de segurança e isolamento passando, antes
de começar a próxima. O **MVP utilizável** é o fim da Fase 2a: login → tenant/projeto →
inventário → power → criar instância a partir de template → dashboard.

## Ajustes em relação ao plano original

1. **Criação por template sobe para a Fase 2a** (antes de storage/rede/LXC completos):
   é o que torna a plataforma self-service de verdade.
2. **Quota mínima (vCPU, RAM, disco, nº de instâncias) entra junto com a criação**, na
   Fase 2a. Criar recurso self-service sem quota num ambiente multi-tenant permite que um
   tenant esgote o cluster. Preço/billing continuam na Fase 4.
3. **Gravação de auditoria começa na Fase 1** (custa pouco e não dá para recuperar
   retroativamente). A UI de auditoria fica na Fase 5.
4. **LXC entra na leitura e power já na Fase 1** — `/cluster/resources` devolve VM e LXC
   na mesma chamada; separar não economiza nada.

## Fase 0 — Arquitetura (este entregável)

- Documentos em `docs/architecture/` e ADRs em `docs/adr/`.
- Esqueleto executável: API com `/healthz` e `/readyz`, worker stub, frontend
  placeholder, Docker Compose com Traefik, PostgreSQL e Redis.

**Saída:** `docker compose up` sobe tudo; arquitetura revisada e aprovada por você.

## Fase 1 — Fundação, identidade e inventário ✅ (concluída em 2026-10-02)

| Bloco | Conteúdo |
|---|---|
| Core | config, logging JSON, request-id, problem+json, métricas básicas |
| Banco | SQLAlchemy 2 async, Alembic, roles `cm_owner`/`cm_app`, RLS, seeds de roles/permissões |
| Auth | login, refresh com rotação, logout, sessões, rate limit, lock, reset de senha, audit de login |
| IAM | users, tenants, memberships, projects, role bindings, `authorize()` |
| Provider | `CloudProvider`, `ProxmoxClient` (token, TLS pin, retry, breaker), `FakeProvider`, mock PVE |
| Admin | cadastro de cluster + credencial cifrada + teste de conexão + sync manual |
| Inventário | reconciliador (nodes, VMs, LXC, storage), descobertos (`managed=false`), adoção para projeto |
| Compute | listar/detalhar instâncias; start/stop/shutdown/restart via jobs |
| Jobs | fila em Postgres, worker, `GET /jobs/{id}` (polling; WS na Fase 3) |
| Frontend | login, seletor de tenant/projeto, dashboard básico, lista e detalhe de instância, ações de power, admin de clusters |

**Critérios de saída:**
- Testes cross-tenant (GET/POST/DELETE) para todos os endpoints e RBAC por role.
- Testado contra o lab Proxmox real (inventário + power) com token de privilégio mínimo.
- Token do PVE nunca aparece em resposta, log ou frontend (teste automatizado).

**Como foi validada:** 156 testes (unitários + integração com Postgres/Redis reais,
matrizes cross-tenant e RBAC); `pytest -m lab` (conexão, isolamento do pool, ciclo de
energia) e `scripts/e2e-lab.sh` (cluster → sync → adoção → start/stop como jobs do
tenant) contra PVE 8.4.19; `scripts/security-scan.sh` sem achados altos corrigíveis.

**Pendências levadas adiante:** reconciliação de vários clusters em paralelo e teste
com dois clusters (há vários PVE independentes); `Idempotency-Key` só em ações de
energia por enquanto; pin de fingerprint TLS descartado (ver 04-integracao-proxmox).

## Fase 2 — Provisionamento

**2a (MVP):** imagens (registro de templates existentes no PVE, visibilidade
pública/tenant), criação por template com cloud-init (usuário, chave SSH, IP
DHCP/estático), quota mínima com reserva transacional, exclusão com confirmação,
chaves SSH públicas do usuário.

**2b:** clone, resize CPU/RAM/disco, snapshots + rollback, suspend/resume, discos e
NICs adicionais, storage classes, redes de tenant (bridge/VLAN, depois SDN VNet),
criação de LXC a partir de templates de container, criar imagem a partir de instância.

## Fase 3 — Acesso e tempo real

WebSocket hub com tickets, eventos de job/instância, console VGA (noVNC) via proxy,
terminal LXC/serial (termproxy + xterm.js), SSH no browser com certificados efêmeros,
`console_sessions`/`ssh_sessions`, limites e timeouts.

## Fase 4 — Quotas completas, preço e uso

Quotas de snapshots/IPs/containers e por projeto, tabelas de preço versionadas, preço
por tenant, estimativa no formulário de criação, coleta horária de uso
(`usage_records`), relatório de custo por projeto, export CSV. Arquitetura pronta para
integração com billing externo.

## Fase 5 — Operação

Métricas por instância (RRD do PVE → API), UI de auditoria com filtros/export,
painel de jobs/erros para admin, multi-cluster na UI, MFA (TOTP), particionamento de
`audit_logs`, ServiceMonitor/dashboards Grafana da própria plataforma.

## Fase 6 — Enterprise

OIDC/SSO (Keycloak, Entra ID, Okta, Google), mapeamento de grupos, Helm chart,
overlays OpenShift (SCC `restricted-v2`, Routes), HA (API e worker com N réplicas,
PostgreSQL HA, Redis Sentinel), External Secrets/Vault, imagens assinadas,
Terraform para os ambientes.

## Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Diferenças entre PVE 8 e 9 (privilégios, campos) | Testes de contrato do mapper com fixtures das duas versões; versão detectada no cadastro do cluster |
| IP da VM depende de qemu-guest-agent | Contrato de imagem exige o agente; fallback por lease DHCP/IPAM da plataforma |
| SSH no browser precisa de rota até redes de tenant | Decisão de topologia de rede no início da Fase 3 |
| Escopo virar "OpenStack completo" | Fases fechadas com critérios de saída; backlog fora de fase só entra por ADR |
