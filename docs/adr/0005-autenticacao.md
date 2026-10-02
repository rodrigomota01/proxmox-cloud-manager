# ADR-0005 — Autenticação

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
Precisa de login local agora e SSO (Keycloak, Entra ID, Okta, Google, LDAP) depois,
sem reescrever o resto. Requisitos: refresh, revogação, brute force, auditoria, MFA
preparado.

## Decisão
- Módulo `auth` isolado entrega um `Principal` ao resto do sistema.
- **Access token JWT EdDSA, 10 min, em memória no browser**; sem roles/tenants dentro
  (resolvidos por request com cache curto → revogação de acesso rápida).
- **Refresh token opaco, rotativo, com detecção de reuso**, em cookie
  `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`, hash no banco.
- Senhas com argon2id; rate limit por IP e por conta; lock progressivo.
- SSO futuro via **OIDC** (Authorization Code + PKCE). LDAP via Keycloak federation.
  Após SSO a plataforma emite os mesmos tokens próprios.

## Alternativas
- **Keycloak desde o dia 1** — resolve muito, mas adiciona um componente pesado ao MVP
  e ainda exigiria a mesma camada de autorização própria. Fica como IdP plug-in na Fase 6.
- **Sessão server-side com cookie em todas as rotas** — simples, mas exige CSRF em toda
  mutação e acopla WebSocket/CLI futura ao cookie.
- **JWT longo em localStorage** — vulnerável a XSS e sem revogação.

## Consequências
- Refresh silencioso no frontend ao expirar o access token (e ao recarregar a página).
- A API valida JWT localmente (rápido) e checa revogação de sessão no Redis.
- Uma futura CLI/automação usará *personal access tokens* (escopo e expiração), não
  senha.
