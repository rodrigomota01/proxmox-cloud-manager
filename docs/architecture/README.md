# Arquitetura — Cloud Manager

Fase 0. Leitura sugerida na ordem abaixo; decisões estão justificadas nos
[ADRs](../adr/README.md).

| # | Documento | Cobre (itens do requisito §39/§41) |
|---|---|---|
| 01 | [Visão geral](01-visao-geral.md) | Arquitetura geral, diagrama de componentes, diagramas de fluxo, NFRs |
| 02 | [Domínio e modelo de dados](02-modelo-de-dados.md) | Entidades principais, ER, convenções de banco |
| 03 | [Tenant e RBAC](03-tenancy-e-rbac.md) | Modelo de tenant, isolamento, roles, matriz de permissões |
| 04 | [Integração Proxmox](04-integracao-proxmox.md) | Provider, client, token, tasks, sincronização, erros |
| 05 | [API v1](05-api.md) | Convenções, erros, inventário de endpoints |
| 06 | [Autenticação](06-autenticacao.md) | Login, refresh, sessões, OIDC futuro |
| 07 | [Tempo real, console e SSH](07-realtime-console-ssh.md) | WebSocket, console VGA, terminal, SSH |
| 08 | [Segurança](08-seguranca.md) | Ameaças, controles, checklist por fase |
| 09 | [Estrutura do repositório](09-estrutura-do-repositorio.md) | Backend, frontend, deploy, terraform |
| — | [Roadmap](../roadmap.md) | Fases e critérios de saída |
