# ADR-0012 — Regiões, zonas e imagens lógicas

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
Os hypervisors são servidores Proxmox independentes em três países (Brasil, EUA,
Canadá), vários no mesmo datacenter (ex.: `hv07.sp02`, `hv08.sp02`). O usuário quer a
experiência da AWS: escolher **região** e **zona** ao criar uma instância, sem saber
qual servidor a recebe. Até aqui uma imagem era um template de **um** servidor, e era
a imagem que decidia onde a VM nascia.

## Decisão
- **Região** (`regions`): agrupamento geográfico/latência, ex. `br-sp`, `us-east`.
- **Zona** (`zones`): domínio de falha dentro de uma região, ex. `sp02-hv08`. Cada
  cluster/servidor pertence a no máximo uma zona (`provider_clusters.zone_id`); uma zona
  pode ter **vários** servidores. Servidor sem zona continua sincronizado e monitorado,
  mas não recebe instâncias novas.
- A zona de uma instância é a do servidor onde ela está (derivada, não copiada): se o
  admin reorganizar zonas, a instância acompanha o hardware.
- **Imagem lógica**: `images` vira o item do catálogo ("Debian 13"); os templates
  concretos ficam em `image_templates` (imagem × servidor → template). Disponibilidade
  de uma imagem numa zona = existe template dela em algum servidor da zona.
- **Placement**: `POST /instances` recebe `zone_id`; a plataforma escolhe, entre os
  servidores da zona que têm template da imagem e pool de destino, o de menor fração de
  RAM alocada. Falta de template na zona → 409 claro.
- Tenants veem regiões/zonas e nomes de imagem; nunca servidor, node, VMID ou template.

## Alternativas
- **Zona = servidor (1:1, sem tabela)**: mais simples hoje, mas impede crescer uma
  zona com mais servidores sem migração e mistura nome comercial com hostname.
- **Imagem continua por servidor**: o catálogo ficaria com "Debian 13 (hv07)",
  "Debian 13 (hv08)"… e o usuário escolheria o servidor indiretamente — o oposto do
  objetivo.

## Consequências
- Quotas e preço podem passar a variar por região (Fase 4) sem mudar o modelo.
- Redes (Fase 2b) serão por zona/região: IPs e bridges diferem entre datacenters.
- Migração entre zonas = recriar/copiar (não é live migration), como na AWS.
