# ADR-0006 — Fila de jobs em PostgreSQL

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
Operações longas (criar, clonar, migrar, snapshot) precisam ser assíncronas, visíveis
ao usuário (`GET /jobs/{id}`), retomáveis se o worker cair, e criadas **atomicamente**
com a reserva de quota e a auditoria.

## Decisão
- Tabela `jobs` é a fila: worker usa `SELECT … FOR UPDATE SKIP LOCKED`, com
  `locked_until` (lease) e `attempts`; `LISTEN/NOTIFY` acorda workers sem polling
  agressivo.
- Handlers idempotentes por etapa; cada etapa e o UPID do PVE são registrados em
  `job_events`, permitindo retomar.
- **Redis** fica para o que é efêmero: pub/sub de eventos para WebSocket, rate limit,
  tickets de console, cache de permissões.

## Alternativas
- **Celery + Redis/RabbitMQ** — maduro, mas síncrono por natureza, e exige dual-write
  (banco + broker) ou outbox para não perder/duplicar jobs; o estado do job
  visível ao usuário ficaria em dois lugares.
- **Arq / Taskiq (Redis)** — async-friendly, mesmo problema de dual-write e de
  durabilidade do Redis.
- **Temporal** — excelente para workflows longos; operacionalmente pesado para o MVP.
  Reavaliar se surgirem workflows multi-hora com muitos passos.

## Consequências
- Um componente a menos para operar com garantias fortes (Redis pode ser reiniciado sem
  perder jobs).
- Throughput mais que suficiente (milhares de jobs/min) para o caso de uso.
- Interface `JobQueue` permite trocar a implementação se necessário.
