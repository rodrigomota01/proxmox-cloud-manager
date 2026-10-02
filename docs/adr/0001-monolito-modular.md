# ADR-0001 — Monólito modular + worker

**Status:** Aceito · **Data:** 2026-10-02

## Contexto
Equipe pequena, domínio ainda em descoberta, necessidade de transações que cruzam
módulos (ex.: reservar quota + criar instância + gravar auditoria + criar job de forma
atômica). Requisito de "arquitetura modular" e de evoluir para Kubernetes/OpenShift.

## Decisão
Um backend FastAPI único, dividido em módulos de domínio com fronteiras verificadas por
`import-linter`, e um processo **worker** (mesma imagem, outro entrypoint) para jobs e
reconciliação. Frontend Next.js separado.

## Alternativas
- **Microsserviços por domínio** — transações distribuídas (saga) para tudo, custo
  operacional alto, sem ganho de escala real no volume esperado (centenas a poucos
  milhares de instâncias).
- **Monólito sem fronteiras** — rápido no começo, mas impede extrair console/SSH ou
  provider depois.

## Consequências
- Uma transação PostgreSQL resolve quota + job + auditoria.
- API e worker escalam horizontalmente de forma independente.
- Candidatos naturais a extração futura: `ssh-gateway` (rede), `console-proxy`
  (conexões longas), `reconciler` (por cluster).
