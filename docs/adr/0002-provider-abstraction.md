# ADR-0002 — Abstração `CloudProvider`

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
O produto deve expor `Instance/Image/Volume/Network` e não conceitos do PVE, e
precisa permitir VMware/OpenStack/AWS no futuro. Chamadas diretas ao PVE espalhadas
pelo código tornariam isso impossível e dificultariam testes.

## Decisão
- `app/providers/base.py` define `CloudProvider` (Protocol) com tipos do domínio
  (`InstanceSpec`, `PowerAction`, `ProviderRef`, `OperationHandle`).
- `ProxmoxProvider` implementa o contrato compondo services (`vms`, `containers`,
  `storage`, `network`, `console`, `tasks`) sobre um único `ProxmoxClient` HTTP.
- `ProviderRegistry` resolve o provider por `cluster_id`; o domínio nunca importa
  `providers.proxmox`.
- Campos específicos do provider ficam em `provider_ref`/`spec` (JSONB), validados pelo
  provider.
- `FakeProvider` em memória para testes de domínio; mock HTTP da PVE API para testes do
  adapter.

## Alternativas
- **Usar `proxmoxer` diretamente** — biblioteca síncrona, sem tipos; serve de referência
  mas não substitui um client async com retry/breaker/métricas.
- **Abstração genérica "multi-cloud" completa já agora** — over-engineering; o contrato
  cresce conforme as fases, guiado pelo Proxmox, com revisão quando entrar o 2º provider.

## Consequências
- Capacidades diferem entre providers → `ProviderCapabilities` (ex.: `supports_lxc`,
  `supports_live_migration`) consultado pelo domínio e pela UI.
- Um custo de mapeamento (mapper) em toda operação — aceito.
