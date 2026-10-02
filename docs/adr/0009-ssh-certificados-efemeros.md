# ADR-0009 — SSH no browser com certificados efêmeros

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
Terminal SSH no browser exige que o backend se autentique na instância. Guardar chave
privada ou senha do usuário é proibido.

## Decisão
- O gateway (AsyncSSH) gera um **par Ed25519 efêmero por sessão**, em memória, e o
  assina com a **CA SSH de usuário da plataforma** (Vault SSH secrets engine em produção;
  chave local cifrada em dev) com TTL de 5 min, `principal` = login, `key_id` = usuário +
  sessão, `source-address` = IP do gateway.
- Imagens do catálogo confiam na CA (`TrustedUserCAKeys` via cloud-init) — parte do
  contrato de imagem.
- Alternativa de autenticação por senha digitada no próprio terminal (nunca armazenada).

## Alternativas
- **Usuário envia chave privada** — inaceitável.
- **Chave privada da plataforma de longa duração em todas as VMs** — uma chave vazada
  abre todas as VMs.
- **Só console serial** — funciona sem rede, mas experiência pior; mantido como fallback.

## Consequências
- Exige rota de rede do gateway até as redes dos tenants (decisão de topologia na Fase 3).
- Imagens importadas sem a CA só têm SSH por senha/chave do próprio usuário.
- Revogação natural: certificados expiram em minutos.
