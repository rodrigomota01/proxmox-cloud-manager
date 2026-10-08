# ADR-0017 — Kubernetes: saúde e carga pela API de cada cluster, só leitura

**Status:** Aceito · **Data:** 2026-10-08

## Contexto
Depois do inventário dos clusters ([ADR-0016](0016-clusters-kubernetes.md)), a operação
quer um painel como o das VMs: saúde, carga, namespaces ("projetos"), workloads, pods,
services e ingresses de cada cluster, só para administradores da plataforma. Alguns
clusters (ex.: pluxee) não estão na tabela legada.

## Decisão
- **Credencial: o kubeconfig da tabela** (escolha do dono do ambiente), que é de admin
  do cluster. Por isso o só-leitura é garantido **no código**, não pela credencial:
  `K8sReader` só tem `get`, numa lista fechada de coleções (`ALLOWED_PATHS`); o cliente
  HTTP não é exposto; `Secrets` e `ConfigMaps` não estão na lista. Teste automatizado
  cobre as duas coisas. Trocar por uma ServiceAccount com papel `view` continua sendo
  o recomendado e não exige mudança de código (kubeconfig com `token`).
- **Coleta no worker**, num loop próprio (`CM_K8S_POLL_INTERVAL_SECONDS`, 60 s;
  `CM_K8S_POLL_TIMEOUT_SECONDS` por cluster; `CM_K8S_POLL_CONCURRENCY` em paralelo): um
  cluster lento não atrasa o sync do Proxmox nem os outros. Resultado em `k8s_snapshots`
  (um por cluster): resumo para listas e dashboard, detalhe para a tela do cluster.
  Cluster inacessível vira "sem conexão" e **mantém a última leitura boa** com a idade.
- **Rotas: Ingress e HTTPRoute (Gateway API)**, mostrados lado a lado com o tipo. A
  Gateway API é lida em `v1` ou, se não houver, `v1beta1`; ausente = só Ingress. HTTPS e
  endereço de um HTTPRoute vêm do listener do Gateway a que ele se liga; rota recusada
  pelo gateway (`Accepted`/`ResolvedRefs` = False) deixa o cluster em atenção.
- **O que se guarda**: nomes, estados, tamanhos, uso. Nunca variáveis de ambiente dos
  containers (podem ter senhas), nunca Secrets. Até 5000 pods por cluster (problemas
  primeiro); as contagens cobrem todos.
- **Carga**: uso real via metrics-server (`metrics.k8s.io`) quando existe; sem ele, o
  reservado pelos pods (requests), sempre rotulado como tal. Base = alocável dos nós.
- **Saúde**: crítico = `/readyz` não ok ou nó NotReady; atenção = pressão no nó ou
  memória > 90%, pods com problema (CrashLoopBackOff, ImagePull*, Failed, Pending
  > 5 min), workloads sem todas as réplicas; sem conexão = API não respondeu.
- **Clusters fora da tabela**: cadastro manual (`source='manual'`), com kubeconfig
  colado (YAML ou base64), selado como os demais; trocar e remover o cadastro são
  auditados. A sincronização da tabela nunca toca nos manuais; um nome já cadastrado à
  mão tem precedência sobre a tabela.

## Consequências
- O worker precisa de rota até a porta 6443 de cada cluster. Sem rota, o cluster aparece
  como "sem conexão" com o erro, sem afetar o resto.
- Sem histórico (só o estado atual); séries temporais por cluster/namespace entram se
  forem pedidas, junto com retenção.
- Ações (reiniciar, escalar, apagar pod) ficam fora: exigiriam escrita, confirmação e
  auditoria, num ADR próprio.
