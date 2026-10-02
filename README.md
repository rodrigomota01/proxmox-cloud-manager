# Cloud Manager

Plataforma de cloud management multi-tenant sobre **Proxmox VE**: tenants, projetos,
RBAC, quotas, preço, catálogo de imagens, console/SSH no browser e auditoria — sem que
o usuário final precise acessar o Proxmox.

> **Status: Fase 0 (arquitetura).** O código atual é só o esqueleto executável
> (health checks + compose). As funcionalidades entram fase a fase — ver
> [roadmap](docs/roadmap.md).

## Documentação

- [Arquitetura](docs/architecture/README.md)
- [Decisões (ADRs)](docs/adr/README.md)
- [Roadmap](docs/roadmap.md)

## Rodando em desenvolvimento

Requisitos: Docker + Docker Compose v2.

```bash
cp .env.example .env          # ajuste senhas locais
docker compose up --build -d
```

| URL | O quê |
|---|---|
| http://localhost/ | Frontend |
| http://localhost/api/healthz | Liveness da API |
| http://localhost/api/readyz | Readiness (Postgres + Redis) |
| http://localhost/api/docs | OpenAPI (só fora de produção) |
| http://localhost:8080/ | Dashboard do Traefik (só dev) |

Testes e lint do backend:

```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]" && pytest -q && ruff check .
```

## Estrutura

```
backend/    FastAPI (API + worker, mesma imagem)
frontend/   Next.js + TypeScript + Tailwind
deploy/     init do Postgres, (futuro) Helm/OpenShift, role do Proxmox
terraform/  (futuro) ambientes dev/staging/production
docs/       arquitetura, ADRs, roadmap
```
