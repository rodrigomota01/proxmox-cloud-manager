# ADR-0011 — Stack e borda

**Status:** Aceito · **Data:** 2026-10-02

## Decisão
| Camada | Escolha | Motivo |
|---|---|---|
| API | Python 3.12, FastAPI, Pydantic v2, Uvicorn | Requisito; async nativo para I/O com PVE e WebSockets |
| ORM / migrations | SQLAlchemy 2.0 async + asyncpg, Alembic | Requisito; controle fino de transação e `SET LOCAL` |
| HTTP para PVE | httpx (async) | Pool, timeouts, HTTP/1.1 keep-alive, testável com respx |
| SSH | AsyncSSH | Async, suporte a certificados OpenSSH |
| Banco | PostgreSQL 17 | RLS, JSONB, SKIP LOCKED, LISTEN/NOTIFY |
| Efêmeros | Redis 7 | pub/sub, rate limit, tickets |
| Frontend | Next.js (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Query | Requisito; ecossistema |
| Borda | Traefik (dev e Docker); Ingress/Route em K8s/OpenShift | Mesma origem para front e API |
| Observabilidade | structlog (JSON), prometheus-client, OpenTelemetry SDK | Requisito |
| Qualidade | ruff, mypy (strict nos módulos novos), pytest, import-linter, ESLint, Vitest, Playwright | |

**Mesma origem:** `/` → frontend, `/api` e `/ws` → API. Elimina CORS em produção e
permite `SameSite=Strict` no refresh token.

## Consequências
- O frontend chama a API por caminho relativo (`/api/v1/...`), inclusive em dev
  (Traefik local em `http://localhost`).
- API e worker compartilham imagem e código; diferem pelo comando.
