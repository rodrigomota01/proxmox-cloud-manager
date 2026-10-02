# ADR-0004 — Modelo de tenant e isolamento

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
O requisito lista Tenant, Organization e Project. Isolamento entre tenants é
requisito crítico; um único `WHERE` esquecido não pode vazar dados.

## Decisão
1. **Tenant = Organization** (um conceito). Hierarquia: Platform → Tenant → Project →
   recursos. Sub-agrupamentos futuros viram hierarquia de projetos.
2. **Banco compartilhado, schema compartilhado, coluna `tenant_id`** em toda tabela
   tenant-scoped.
3. **Isolamento em camadas:** escopo obrigatório no repositório + **PostgreSQL RLS**
   (`SET LOCAL app.tenant_ids`) com role de app sem `BYPASSRLS` e que não é dono das
   tabelas + autorização sobre o recurso carregado + 404 para outro tenant.
4. Acesso cross-tenant de admins somente por `/admin/*` com `app.platform_scope=on`,
   sempre auditado.
5. Tenant ativo explícito por request (`X-Tenant-Id`).

## Alternativas
- **Schema por tenant** — migrations N vezes, pool de conexões complexo, consultas
  globais de admin difíceis. Bom para dezenas de tenants com requisito regulatório; não é
  o caso.
- **Banco por tenant** — idem, ainda mais caro.
- **Só filtro na aplicação** — uma regressão vaza dados; RLS é a rede de segurança.

## Consequências
- Toda conexão precisa do `SET LOCAL` dentro da transação → middleware/UoW garante;
  teste verifica que query sem contexto retorna zero linhas.
- Pequeno overhead de RLS (índices em `tenant_id` primeiro nas chaves compostas).
- Testes de isolamento são parte obrigatória do CI.
