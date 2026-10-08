# ADR-0016 — Clusters Kubernetes: cópia da tabela legada, vencimento e kubeconfig selado

**Status:** Aceito · **Data:** 2026-10-07

## Contexto
Os clusters Kubernetes dos clientes estão cadastrados em `awf_cloud.kubernetes_clusters`
(mesmo MySQL do cadastro de IPs, [ADR-0014](0014-ipam-legado.md)). A operação precisa
acompanhar o vencimento dos certificados e ter o kubeconfig à mão. É informação da
plataforma: clientes não podem ver.

A tabela tem **uma linha por nó** (`client` = nome do cluster, `host`, `role`); o
kubeconfig (base64) e `certs_expiration_date` ficam, em geral, só na linha do
control-plane. O kubeconfig traz certificado e chave de cliente (acesso de admin).

## Decisão
- **Só leitura.** Usuário MySQL com `SELECT` nessa tabela; nada é escrito nela. O
  worker copia a cada `CM_IPAM_SYNC_INTERVAL_SECONDS` (120 s), logo após o IPAM e
  independente dele (falha num não para o outro), para `k8s_clusters`, uma linha
  por cluster com a lista de nós. Cluster que some da origem sai da cópia local.
- **Vencimento = o mais próximo** entre a data da tabela e o `notAfter` do
  certificado de cliente lido do kubeconfig. A tabela já divergiu do certificado
  (2099 para um certificado vencido); a tela mostra as duas datas e marca a
  diferença. Status: vencido, ≤ 7 dias, ≤ 30 dias, em dia, sem data.
- **Kubeconfig selado** com a KEK da plataforma (envelope encryption, como os tokens
  do Proxmox, [ADR-0007](0007-credenciais-proxmox.md)), AAD = id do cluster; selado de
  novo só quando muda (hash). Sem `CM_KEK`, os metadados aparecem e o kubeconfig não é
  guardado. Erros de leitura dizem o problema, nunca o conteúdo.
- **Só admin da plataforma** (`cluster:manage`): rotas em `/admin/kubernetes/*` e
  RLS na tabela que só libera escopo de plataforma (nem uma rota de tenant com bug
  enxerga). Download do kubeconfig com confirmação, `Cache-Control: no-store` e
  auditoria (`K8S_KUBECONFIG_DOWNLOAD`).
- **Vínculo com um tenant** (adendo, 2026-10-08): o admin vincula um cluster a um
  cliente (`k8s_clusters.tenant_id`, auditado como `K8S_CLUSTER_TENANT`). Os membros
  do cliente (`k8s:view`, que todo papel de tenant/projeto tem) veem o cluster em
  `/kubernetes/*`, só leitura. As tabelas continuam só-plataforma: o tenant lê pelas
  views `k8s_tenant_clusters` e `k8s_tenant_snapshots` (dono `cm_owner`, filtradas por
  `app.tenant_ids`, sem nenhuma coluna de credencial, `cm_app` só com `SELECT`). Não há
  rota de kubeconfig para o tenant.

## Consequências
- `host` é um id de outra tabela legada sem permissão de leitura: os nós aparecem por
  papel, não por nome. Ler os nomes exige outro `GRANT SELECT`.
- Aviso de vencimento por e-mail/webhook ainda não existe; o dashboard da plataforma
  lista os clusters vencidos ou vencendo em 30 dias.
