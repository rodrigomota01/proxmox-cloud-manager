# ADR-0003 — Fonte de verdade e sincronização

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
VMs podem ser criadas, alteradas e removidas diretamente no Proxmox. Nodes caem. A
plataforma precisa de dados próprios (dono, quota, preço) que o PVE não tem. O PVE não
publica eventos de lifecycle de guests.

## Decisão
**Fonte de verdade dividida:**

| Dado | Dono |
|---|---|
| Existência física, power state, node, uso em tempo real | Proxmox |
| Posse (tenant/projeto), nome amigável, imagem, quota, preço, política | Cloud Manager |
| Configuração (vCPU/RAM/discos) | Intenção no Cloud Manager; observação do PVE; divergência = drift |

**Reconciliação por polling** no worker: `GET /cluster/resources` por cluster a cada
15s; `config` detalhada só para guests que mudaram. Resultado: atualização de
observação, registro de drift, guests descobertos (`managed=false`), detecção de
remoção externa após 2 ciclos.

Leituras da API servem do banco (com `last_synced_at`); ações vão ao PVE e atualizam o
banco ao concluir.

## Alternativas
- **PVE como única fonte (sem banco de inventário)** — UI depende do PVE estar no ar;
  impossível filtrar por tenant de forma eficiente; sem histórico.
- **Banco como única fonte (forçar estado no PVE)** — perigoso: reverteria mudanças de
  operadores feitas no PVE durante incidentes.
- **Hooks/eventos do PVE** — não existem para lifecycle de VM; hookscripts por VM são
  locais ao node e frágeis.

## Consequências
- Estado pode ficar até ~15s defasado; ações do usuário atualizam imediatamente via job.
- Drift não é corrigido automaticamente no MVP (só reportado); auto-remediação opcional
  por política no futuro.
- Polling custa 1 request/15s/cluster — desprezível.
