# ADR-0010 — Identificadores

**Status:** Aceito · **Data:** 2026-10-02

## Decisão
- Todas as entidades usam **UUIDv7** gerado na aplicação (ordenável por tempo,
  amigável a índices B-tree, não enumerável).
- Identificadores do provider (`cluster_id`, `node`, `vmid`, `type`) ficam somente em
  `provider_ref` (JSONB) com índice único `(cluster_id, vmid)`.
- A API pública nunca aceita nem retorna `vmid`/`node` (exceto `/admin/*`).
- VMIDs para novas instâncias vêm de uma faixa reservada por cluster, alocados no banco.

## Consequências
- Recriar uma VM (rebuild) pode trocar o `vmid` sem mudar o `instance_id`.
- Adoção de VMs existentes preserva o `vmid` original fora da faixa.
