# ADR-0007 — Credenciais do Proxmox

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
A plataforma precisa de uma identidade técnica com acesso amplo ao cluster. Usar
`root@pam` ou senha é inaceitável; o segredo nunca pode chegar ao browser.

## Decisão
- Usuário `cloudmgr@pve` + **API token com privilege separation** e role
  `CloudManager` com privilégios mínimos (lista em
  [04-integracao-proxmox](../architecture/04-integracao-proxmox.md)).
- Armazenamento com **envelope encryption**: DEK AES-256-GCM por credencial, DEK cifrada
  pela KEK. KEK em Vault Transit (prod) ou secret de ambiente (dev), atrás de
  `SecretsBackend`.
- Endpoint de credencial é write-only; resposta mostra só `token_id` e `rotated_at`.
- TLS para o PVE verificado por CA ou fingerprint pinado por cluster.
- Um registro de cluster/credencial por cluster → multi-cluster desde o schema.

## Alternativas
- **Ticket por usuário final (login no PVE por usuário)** — exigiria espelhar usuários e
  ACLs no PVE para cada tenant; acopla o RBAC da plataforma ao do PVE.
- **Token em variável de ambiente** — aceitável para dev, mas não suporta múltiplos
  clusters cadastrados pela UI nem rotação sem redeploy.

## Consequências
- Comprometimento da API = acesso ao que o token permite → privilégios mínimos,
  egress restrito, auditoria e rotação periódica documentada.
- O PVE registra todas as ações como `cloudmgr@pve!cm`; a correlação com o usuário real
  está na auditoria da plataforma (e no campo `description`/task log quando possível).
