# Cloud Manager

Plataforma de cloud management multi-tenant sobre **Proxmox VE**: tenants, projetos,
RBAC, quotas, preço, catálogo de imagens, console/SSH no browser e auditoria — sem que
o usuário final precise acessar o Proxmox.

> **Status: Fase 1 — pronta para validação final.** Backend (RLS, auth, auditoria,
> IAM, provider Proxmox, inventário, jobs, instâncias) e frontend (login, seletor de
> tenant, dashboard, instâncias com ações de energia, admin de clusters). Validação
> ponta a ponta contra um Proxmox real: `scripts/e2e-lab.sh`. Próximo: Fase 2 —
> ver [roadmap](docs/roadmap.md).

## Documentação

- [Arquitetura](docs/architecture/README.md)
- [Decisões (ADRs)](docs/adr/README.md)
- [Roadmap](docs/roadmap.md)

## Rodando em desenvolvimento

Requisitos: Docker + Docker Compose v2.

```bash
cp .env.example .env          # ajuste senhas locais
docker compose run --rm --no-deps migrate python -m app.cli gen-keys >> .env   # chave JWT
docker compose up --build -d  # o serviço migrate aplica as migrations antes da API subir

# primeiro administrador da plataforma (pede a senha, mín. 12 caracteres)
docker compose run --rm migrate python -m app.cli create-admin --email voce@exemplo.com --name "Seu Nome"
```

| URL | O quê |
|---|---|
| http://localhost/ | Frontend |
| http://localhost/api/healthz | Liveness da API |
| http://localhost/api/readyz | Readiness (Postgres + Redis) |
| http://localhost/api/docs | OpenAPI (só fora de produção) |
| http://localhost:8080/ | Dashboard do Traefik (só dev) |
| http://localhost:8025/ | Mailpit — e-mails de dev (reset de senha) |

Testes e lint do backend:

```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]" && pytest -q && ruff check .
```

O contrato da API fica em `docs/api/openapi.json` e os tipos do frontend são gerados
dele. Ao mudar a API:

```bash
cd backend && .venv/bin/python -m app.cli openapi > ../docs/api/openapi.json
cd ../frontend && npm run gen:api && npm run typecheck
```

Os testes em `tests/integration/` sobem PostgreSQL e Redis reais via testcontainers
(precisam do Docker rodando; sem Docker são pulados). O Postgres de teste é
inicializado com o mesmo `deploy/docker/postgres/init/01-roles.sh` do compose, então
RLS e grants são testados exatamente como em produção.

## Estrutura

```
backend/    FastAPI (API + worker, mesma imagem)
frontend/   Next.js + TypeScript + Tailwind
deploy/     init do Postgres, (futuro) Helm/OpenShift, role do Proxmox
terraform/  (futuro) ambientes dev/staging/production
docs/       arquitetura, ADRs, roadmap
```
