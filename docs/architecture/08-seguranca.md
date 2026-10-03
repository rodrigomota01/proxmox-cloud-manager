# 08 — Modelo de segurança

## Ativos e fronteiras de confiança

| Ativo | Por que importa |
|---|---|
| API token do Proxmox | Controla todas as VMs do cluster. Vazamento = comprometimento de todos os tenants. |
| Isolamento entre tenants | Promessa central do produto. |
| Sessões de console/SSH | Acesso interativo ao guest. |
| Trilha de auditoria | Prova do que aconteceu. |
| Chave de assinatura JWT e CA SSH | Permitem forjar identidade/acesso. |

```
[Browser] ──TLS── [Traefik] ── [API/Worker] ──TLS pinado── [Proxmox API]
   não confiável     borda       confiável               rede de gerência
                                    │
                         [PostgreSQL] [Redis] [Vault/KMS]   rede interna
```

## Ameaças principais e controles

| Ameaça | Controle |
|---|---|
| Usuário do tenant A acessa recurso do tenant B (IDOR) | Escopo obrigatório no repositório + RLS + autorização sobre o recurso carregado + 404 + testes cross-tenant em CI |
| Cliente envia `vmid`/`node` arbitrário | API não aceita IDs do provider; `provider_ref` só vem do banco |
| Escalonamento de privilégio via role binding | Regras anti-escalonamento ([03](03-tenancy-e-rbac.md)); `platform:*` só em `/admin` |
| Vazamento do token PVE | Cifrado (envelope), descriptografado só em memória do worker/API, nunca logado, nunca em resposta; privilégios mínimos; rotação documentada |
| Brute force / credential stuffing | Rate limit IP+conta, lock progressivo, argon2id, mensagens genéricas, auditoria |
| Roubo de refresh token | HttpOnly+Secure+SameSite=Strict, rotação com detecção de reuso |
| XSS levando o access token | Token só em memória (não localStorage), CSP estrita, React escapando por padrão, sem `dangerouslySetInnerHTML` |
| CSRF | Bearer em todas as rotas de API; refresh com SameSite=Strict + header customizado + `Origin` |
| Sequestro de WebSocket | Ticket uso único 30s + checagem de `Origin` + revalidação periódica da sessão |
| SSRF via URL de cluster | Só `cluster:manage` cadastra cluster; validação de esquema/porta; egress da API restrito à rede de gerência |
| Injeção (SQL / comando) | SQLAlchemy parametrizado; nenhum `shell=True`; parâmetros do PVE validados por schema (ex.: nome `^[a-z0-9-]{1,63}$`) |
| Abuso de recursos | Quotas transacionais, rate limit por usuário/tenant, limites de sessões |
| Operador malicioso / erro humano | Auditoria append-only, confirmação em destrutivas, `platform_scope` auditado, MFA obrigatório para SUPER_ADMIN |
| Supply chain | Lockfiles, Dependabot/Renovate, `pip-audit` + `npm audit`, imagem base mínima, scan com Trivy, imagens assinadas (cosign) na Fase 6 |

## Controles transversais

**Transporte**
- TLS 1.2+ na borda (Traefik + cert-manager/Let's Encrypt em produção).
- HSTS, `Secure` cookies; HTTP só redireciona.
- API → PVE com TLS verificado (CAs do sistema ou CA própria do cluster).
- PostgreSQL e Redis com TLS quando fora do mesmo host/namespace.

**Em repouso**
- Segredos de aplicação (token PVE, futuros segredos OIDC): **envelope encryption** —
  DEK AES-256-GCM por segredo, DEK cifrada por KEK. KEK vem de Vault Transit (produção) ou
  de variável de ambiente/secret do K8s (dev). Implementação atrás de `SecretsBackend`.
- Disco do PostgreSQL cifrado pela infraestrutura (LUKS/ZFS native encryption/volume
  cifrado do provedor). Backups cifrados.
- Senhas: argon2id (`time_cost=3, memory_cost=64MiB, parallelism=4`, revisável).
- Tokens (refresh, reset, idempotência): só hash SHA-256 no banco.

**Borda HTTP**
- CORS: desabilitado em produção (mesma origem). Em dev, allowlist explícita.
- Headers: `Content-Security-Policy` (default-src 'self'; connect-src 'self' wss:),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `Frame-Options: DENY`, `Permissions-Policy` mínima.
- Limite de tamanho de body (1 MiB padrão), timeouts de request.
- Rate limiting no Redis (janela deslizante) por IP, usuário e rota sensível.

**Validação**
- Pydantic com `extra="forbid"` em todos os schemas de entrada.
- Allowlist para filtros/ordenação.
- Limites de domínio: vCPU, RAM, disco por flavor/quota; nomes com regex.

**Logs e auditoria**
- Logs JSON com `request_id`, `user_id`, `tenant_id`; **redação** de campos
  `password`, `token`, `secret`, `authorization`, `cookie`, `sshkeys`.
- `audit_logs` gravado na **mesma transação** da intenção (não perde evento se a
  request falhar depois) e resultado final gravado pelo worker.
- O role `cm_app` só tem `INSERT, SELECT` em `audit_logs`.

**Segredos de deploy**
- Nada de credencial no repositório. `.env` só local (no `.gitignore`); `.env.example`
  com valores falsos.
- Kubernetes/OpenShift: Secrets montados como arquivo + External Secrets/Vault na Fase 6.
- Containers rodam como non-root, read-only root filesystem, sem capabilities.

## Checklist de segurança por fase

Cada fase só fecha quando:

1. Testes de isolamento cross-tenant passam para todos os endpoints novos.
2. Testes de RBAC (permitido/negado) por role para cada endpoint novo.
3. Nenhum segredo em log (teste que captura logs e procura padrões).
4. `pip-audit`, `npm audit --omit=dev`, `bandit`, `trivy` sem achados altos —
   `scripts/security-scan.sh`. Política: falha em HIGH/CRITICAL **com correção
   disponível**; achados sem correção publicada pela distro (Debian
   `affected`/`fix_deferred`) são reportados e saem com o rebuild quando o fix sair.
   Imagens finais só com o necessário (sem npm/yarn/corepack no frontend; pacotes do
   Debian atualizados no build do backend). Reduzir os achados sem correção exige trocar
   a base do backend por distroless — avaliar junto com as imagens assinadas (Fase 6).
5. Novos endpoints listados no inventário de [05](05-api.md) com permissão.
