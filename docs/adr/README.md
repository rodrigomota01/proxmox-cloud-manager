# Architecture Decision Records

Formato: contexto → decisão → alternativas → consequências. ADR aceito não é editado;
mudança de decisão gera um novo ADR que marca o anterior como *Substituído*.

| # | Decisão | Status |
|---|---|---|
| [0001](0001-monolito-modular.md) | Monólito modular + worker, não microsserviços | Aceito |
| [0002](0002-provider-abstraction.md) | Abstração `CloudProvider`; Proxmox como primeiro provider | Aceito |
| [0003](0003-fonte-de-verdade-e-sincronizacao.md) | Fonte de verdade dividida + reconciliação por polling | Aceito |
| [0004](0004-isolamento-de-tenant.md) | Tenant = Organization; isolamento em camadas com RLS | Aceito |
| [0005](0005-autenticacao.md) | Auth própria (JWT curto + refresh rotativo), pronta para OIDC | Aceito |
| [0006](0006-jobs-em-postgres.md) | Fila de jobs em PostgreSQL; Redis só para efêmeros | Aceito |
| [0007](0007-credenciais-proxmox.md) | API token com privsep + envelope encryption | Aceito |
| [0008](0008-console-proxy.md) | Console e terminal via proxy WebSocket no backend | Aceito |
| [0009](0009-ssh-certificados-efemeros.md) | SSH no browser com certificados efêmeros | Aceito |
| [0010](0010-identificadores.md) | UUIDv7 interno; IDs do provider só em `provider_ref` | Aceito |
| [0011](0011-stack-e-borda.md) | FastAPI + SQLAlchemy async + Next.js, mesma origem via Traefik | Aceito |
| [0012](0012-regioes-e-zonas.md) | Regiões e zonas; imagem lógica com templates por servidor; placement na zona | Aceito |
| [0013](0013-alertas-e-uso.md) | Uso de disco (guest agent) e rede; alertas, avisos por e-mail e webhook assinado | Aceito |
