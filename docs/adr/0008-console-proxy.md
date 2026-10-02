# ADR-0008 — Console e terminal via proxy no backend

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
O console do PVE (`vncproxy`/`termproxy` + `vncwebsocket`) exige autenticação na API
do PVE. Expor o PVE ao browser violaria o requisito e o isolamento.

## Decisão
- A API abre o console no PVE com o token técnico e faz **relay de WebSocket**
  browser ⇄ API ⇄ PVE.
- O browser se autentica com **ticket de uso único (30s)** emitido após
  `authorize(vm:console)`.
- Para VGA, o proxy termina a autenticação RFB (VNC auth) e apresenta `None` ao
  browser → nenhum segredo do PVE chega ao cliente. **Risco aceito temporário:** se isso
  atrasar a Fase 3, entrega-se ao browser apenas o password VNC efêmero de uso único.
- Terminal (termproxy) é traduzido para o protocolo de terminal da plataforma (o mesmo
  usado pelo SSH).

## Alternativas
- **Redirecionar o browser para o noVNC do PVE** — exige o browser alcançar o PVE e ter
  sessão nele; inviável para tenants.
- **Spice** — requer cliente nativo; fora do escopo.

## Consequências
- A API mantém conexões longas → limites por usuário/instância, timeouts, métricas
  de conexões ativas; candidato a serviço separado se a carga crescer.
- Sessões auditadas (`console_sessions`).
