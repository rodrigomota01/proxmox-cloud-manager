# ADR-0018 — Criação de clusters Kubernetes: kubeadm em VMs da plataforma, instalação pelo guest agent

**Status:** Aceito · **Data:** 2026-10-12

## Contexto
Hoje a plataforma só **observa** clusters Kubernetes. Eles vêm da tabela legada ou são
cadastrados à mão com um kubeconfig ([ADR-0016](0016-clusters-kubernetes.md)), e a
leitura é sempre só leitura ([ADR-0017](0017-kubernetes-observabilidade.md)). O objetivo
agora é **criar** clusters: provisionar as VMs, instalar o Kubernetes com kubeadm e
entregar o cluster pronto para publicar aplicações. Dois caminhos:

- **O cliente cria.** O cluster já nasce vinculado a ele.
- **Um admin cria.** O cluster pode nascer sem cliente e ser vinculado a um depois.

O pacote de entrega definido é este:
- **Cilium** como CNI e também como implementação do Gateway API (Gateway e HTTPRoute);
- **MetalLB**, para dar IP aos Services LoadBalancer, inclusive o do Gateway;
- **cert-manager**;
- **local-path-provisioner**, como StorageClass padrão.

Os nós são organizados em **pools flexíveis**: grupos de workers com tamanhos diferentes.

O código atual impõe estas restrições:
- **Comandos dentro da VM.** Não existe nenhum mecanismo hoje. O guest agent só é usado
  para leitura (`get-fsinfo`, `network-get-interfaces`). Não há SSH no worker. O
  Proxmox não aceita enviar snippets de cloud-init (`cicustom`) pela API.
- **Dono das VMs.** Toda VM gerenciada precisa de `tenant_id` e `project_id`
  (`managed_has_owner`). Uma instância **não troca de dono** depois de criada; só a
  adoção de VMs descobertas define dono.
- **Vínculo cluster–VMs.** `k8s_clusters` não tem vínculo com instâncias nem estado
  de ciclo de vida.
- **Kubeconfig do cliente.** Hoje só o admin baixa o kubeconfig.

## Decisão

### Modelo
- **`k8s_clusters.source = 'managed'`** para clusters criados pela plataforma, com
  novos campos:
  - `state` (`provisioning`, `active`, `updating`, `error`, `deleting`);
  - `project_id` (o projeto que possui as VMs);
  - `kubernetes_version`;
  - `spec` JSONB com CIDRs de pods e services, endpoint da API e versões dos
    componentes instalados.

  A coleta do ADR-0017 continua igual: um cluster gerenciado é só mais um cluster com
  kubeconfig selado.
- **`k8s_node_pools`**: `cluster_id`, `name`, `role` (`control-plane` ou `worker`),
  `count`, `vcpus`, `memory_mb`, `disk_gb`, `image_id`, `labels`, `taints`. O pool de
  control plane tem tamanho **1 ou 3** (3 = HA). Pools de worker podem ser vários, de
  tamanhos diferentes, com 0 a N nós cada.
- **`instances.k8s_cluster_id` e `instances.k8s_pool_id`**: os nós são instâncias
  comuns, com quota, custo, métricas, disco e IP como qualquer VM. Na lista de
  instâncias elas aparecem marcadas como nó de cluster. **Não podem ser desligadas nem
  excluídas uma a uma**: essas ações passam pelo cluster ou pelo pool.

### Quem cria e de quem é
- **O cliente cria** com a nova permissão `k8s:create` no projeto. O cluster nasce com
  `tenant_id` e `project_id` do cliente, e a quota é verificada **para todos os nós de
  uma vez** antes de qualquer VM ser criada.
- **Um admin cria** com `cluster:manage` e escolhe um cliente e um projeto de destino,
  ou **nenhum**. Sem cliente, as VMs ficam num **cliente interno da plataforma**
  (criado pela migration, invisível aos clientes), porque toda VM gerenciada precisa de
  dono.
- **Vincular depois é uma transferência**: o cluster e todas as VMs dele passam ao
  projeto do cliente, numa única transação. O passo a passo é:
  1. verificar a quota do destino;
  2. trocar o dono das instâncias;
  3. fechar o custo no dono antigo e começar a contar no novo.

  A troca de dono de instância **só existe para nós de cluster**; o restante da
  plataforma continua sem mudança de dono. A rota atual `PUT .../tenant` continua
  valendo para clusters não gerenciados (tabela e manual).

### Instalação: pelo guest agent
- **Os comandos rodam pelo QEMU guest agent** (`agent/exec`, `agent/exec-status`,
  `agent/file-write`), nunca por SSH:
  - não depende de o worker alcançar a rede das VMs;
  - não precisa de chave SSH da plataforma nas VMs;
  - só funciona dentro do pool gerenciado, que é onde o token tem esse direito.

  Privilégios necessários:
  - **PVE 8:** `VM.Monitor`, que o role `CloudManager` já tem no pool;
  - **PVE 9:** `VM.GuestAgent.Unrestricted` (exec) e `VM.GuestAgent.FileWrite`, a acrescentar ao `setup-node.sh`, também
    só no pool.

  O template precisa ter o guest agent ativo. A plataforma passa a guardar
  `has_guest_agent` no `ImageTemplate` e só aceita, para nós de cluster, imagens
  marcadas como **imagem Kubernetes**.
- **Os scripts são da plataforma**, versionados no repositório, idempotentes (podem
  rodar de novo sem efeito colateral) e com saída limitada:
  - nenhum comando vem do usuário;
  - segredos (token de join, chave de certificados) vão por `file-write` num arquivo
    com modo 0600, apagado no fim;
  - segredos nunca aparecem em argumento, log ou evento do job.
- **Imagem Kubernetes preparada**: containerd, kubeadm, kubelet e kubectl numa versão
  fixa, swap desligado, módulos e sysctl configurados, helm. O script de preparação
  confere tudo isso e só instala o que faltar. Assim o template acelera a criação, mas
  não é obrigatório. **A versão do Kubernetes é fixa por imagem**: cada imagem
  Kubernetes declara a sua (por exemplo "Debian 13 · Kubernetes 1.34"), e escolher a
  imagem é escolher a versão. O pacote de componentes vem de um catálogo da
  plataforma, com versões fixas em `app/k8s/bundle.py`.

### Sequência (job `k8s.create`, retomável, com compensação)
1. **Planejamento.** Valida pools, quota agregada e endereços. Na rede, os nós precisam
   estar no mesmo segmento L2 (exigência do MetalLB em L2 e do VIP). Endereços
   reservados no IPAM ([ADR-0014](0014-ipam-legado.md)), ou digitados quando o
   servidor não tem IPAM:
   - 1 por nó;
   - 1 VIP da API quando há 3 control planes;
   - **1 IP público para o MetalLB**, como na infraestrutura atual. Ele fica com o
     Service do Gateway compartilhado, e todas as aplicações entram por esse IP,
     separadas por hostname nas `HTTPRoute`s.
2. **VMs.** Cria as instâncias reaproveitando o `instance.create` (jobs filhos) e
   espera todas ficarem `active` e o guest agent responder (`agent/ping`).
3. **Preparação de todos os nós**, em paralelo.
4. **`kubeadm init`** no primeiro control plane, com `controlPlaneEndpoint` = VIP
   (kube-vip, se HA) ou IP do nó, `skipPhases: addon/kube-proxy` (o Cilium substitui o
   kube-proxy) e `--upload-certs`.
5. **Join** dos demais control planes e workers, com token e chave de certificados
   gerados no passo 4 e validade curta.
6. **Componentes**, instalados com helm no primeiro control plane:
   - CRDs do Gateway API;
   - Cilium com `kubeProxyReplacement` e `gatewayAPI.enabled`;
   - MetalLB com um `IPAddressPool` contendo o IP público do passo 1 e um
     `L2Advertisement`. Com um único IP, outros Services `LoadBalancer` só o recebem
     compartilhando (`metallb.io/allow-shared-ip`) em portas diferentes; o caminho
     normal para publicar é a `HTTPRoute`;
   - cert-manager com suporte a Gateway API e um `ClusterIssuer` Let's Encrypt
     (`letsencrypt`, ACME HTTP-01 pelo Gateway compartilhado) com o e-mail
     `support@atena.io`. O endereço é configurável (`CM_K8S_ACME_EMAIL`), e o emissor
     de staging também é criado, para testes;
   - local-path-provisioner como StorageClass padrão;
   - um `Gateway` compartilhado (`GatewayClass cilium`, ouvindo na porta 80, e na 443
     quando houver certificado) num namespace da plataforma. O usuário publica
     aplicações criando `HTTPRoute`s apontando para ele.
7. **Labels e taints** dos pools; espera todos os nós ficarem `Ready`.
8. **Credenciais.** Lê o `admin.conf` e sela como hoje. Na fase 1 a coleta do
   ADR-0017 usa esse kubeconfig, com a mesma garantia de só leitura de hoje (a lista
   de rotas permitidas no código). A ServiceAccount somente leitura (`view`) para a
   coleta fica para a fase 2.

Se uma etapa falha, o job pode ser retomado do ponto em que parou, como o
`instance.create`. Se a falha for definitiva, o cluster vai para `error` com o motivo e
as VMs ficam disponíveis para diagnóstico. **Excluir** o cluster destrói as VMs e
libera os IPs, inclusive o VIP e o IP do MetalLB, depois de confirmar o nome.

### Operação depois de criado
- **Escalar um pool de worker:**
  - para cima: cria VMs, prepara e faz join;
  - para baixo: `cordon`/`drain` pelo control plane, `kubectl delete node`, destrói a
    VM.
- **Criar e excluir pools** de worker. O pool de control plane não muda de tamanho
  depois de criado; ir de 1 para 3 fica para outro ADR.
- **Kubeconfig para o cliente:** nova permissão `k8s:admin`, dada a `TENANT_ADMIN` e
  `PROJECT_ADMIN`. É o mesmo download do admin, com confirmação, auditoria e
  `no-store`, liberado só para clusters do próprio cliente. As views de tenant
  continuam sem coluna de credencial: a rota de tenant lê o kubeconfig pelo serviço,
  com escopo de plataforma, depois de autorizar.
- **Upgrade de versão do Kubernetes** fica para um ADR próprio (`kubeadm upgrade` nó a
  nó).

### Custos
Os nós são cobrados como VMs, pelo modelo do [ADR-0015](0015-custos-e-precos.md). Não
há cobrança específica por cluster nesta fase.

## Alternativas
- **SSH a partir do worker**: exige rota do worker até cada rede de cliente e uma
  chave da plataforma em todas as VMs. Pelo guest agent não tem nenhum dos dois.
- **cloud-init com `cicustom`**: o Proxmox não aceita enviar snippets pela API; seria
  preciso gravar no sistema de arquivos do storage, fora do modelo de menor privilégio.
  Também não resolve os passos que dependem de outros nós (join).
- **Cluster API (CAPMOX) ou Talos**: menos código próprio, mas exige um cluster de
  gerenciamento e outra stack para operar, e foge do kubeadm pedido.
- **Ingress (nginx) em vez de Gateway API**: o Gateway API é o padrão atual e o Cilium
  já o implementa, então não entra mais um componente.
- **Cluster admin sem dono**: violaria `managed_has_owner`; o cliente interno da
  plataforma mantém a regra.

## Consequências
- **Exec pelo guest agent é poderoso.** Fica restrito ao pool gerenciado, a scripts da
  plataforma e ao worker, e cada exec é registrado (comando lógico, nó, código de
  saída), sem o conteúdo de segredos.
- **Templates Kubernetes precisam de manutenção:** versão do Kubernetes, containerd e
  agente.
- **Nova regra de dono de instância** para nós de cluster, com efeito em quota e custo
  na transferência.
- **O tempo de criação é de minutos.** A tela mostra o progresso por etapa, e o
  progresso do job já existe.
- **IPs extras por cluster** passam a ser reservados no IPAM: o IP público do MetalLB e, com
  3 control planes, o VIP da API.

## Fases
1. Modelo, permissões, exec pelo guest agent no provider, scripts, `k8s.create` e
   `k8s.delete` com **1 control plane + 1 pool de worker**, e todos os componentes.
   Criação pelo admin e pelo cliente. Kubeconfig do cliente.
2. 3 control planes com kube-vip; vários pools de worker; escalar e excluir pools.
3. Cluster criado pelo admin sem cliente e transferência para um cliente.
4. Upgrade de versão (ADR próprio).

## Implementação da fase 1 (2026-10-13)
- Scripts em `backend/app/k8s/scripts/` e versões em `backend/app/k8s/bundle.py`
  (Gateway API 1.6.1, Cilium 1.20.2, MetalLB 0.16.1, cert-manager 1.21.2, local-path
  0.0.37). O job avança por fases com `Reschedule` (reagenda sem gastar tentativa) e
  retoma comandos pelo pid gravado no evento.
- Template `debian13-k8s-1.37` (Kubernetes 1.37.1) gerado no suhr com `prepare-node.sh`.
- Endereços: IPAM (um por nó + o do load balancer, todos na mesma rede) ou digitados;
  bridge/VLAN só pela rota de admin.

## Pontos definidos depois da proposta (2026-10-12)
- **Versão do Kubernetes:** fixa por imagem.
- **cert-manager:** `ClusterIssuer` Let's Encrypt com `support@atena.io`.
- **MetalLB:** 1 IP público por cluster, como na infraestrutura atual.
