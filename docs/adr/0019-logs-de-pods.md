# ADR-0019 — Kubernetes: logs de pods, um pod ou o workload inteiro, lidos na hora

**Status:** Aceito · **Data:** 2026-10-16

## Contexto
O painel dos clusters ([ADR-0017](0017-kubernetes-observabilidade.md)) mostra os pods,
mas para entender um pod com problema ainda era preciso baixar o kubeconfig e rodar
`kubectl logs`. A operação quer ver os logs na própria tela: de um pod, e de todos os
pods de um workload juntos (como `kubectl logs -l` / `stern`), podendo isolar um deles.

## Decisão
- **Só administradores da plataforma** (`cluster:manage`), os mesmos que já baixam o
  kubeconfig. Usuários de tenant não veem logs por enquanto.
- **Lido na hora, nunca guardado.** A API lê do cluster a cada pedido e devolve; nada vai
  para `k8s_snapshots` nem para o banco (logs podem ter senhas). **Cada leitura é
  auditada** (`K8S_POD_LOGS`: cluster, namespace, workload, pods, container).
- **Continua só leitura no código.** O `K8sReader` ganha duas leituras com caminho
  montado por ele, com cada nome validado (DNS-1123) antes: os pods de um namespace e o
  `log` de um pod, com parâmetros numa lista fechada (`container`, `tailLines`,
  `sinceSeconds`, `previous`, `timestamps`); `follow` não está nela.
- **Workload → pods ao vivo**, não pelo snapshot (que pode ter um minuto e já ter pods
  trocados). O pod de um Deployment pertence a um ReplicaSet `<deployment>-<hash>`; o
  rótulo `pod-template-hash` devolve o Deployment. O snapshot passa a guardar, de cada
  pod, o workload e os nomes dos containers (para a tela).
- **Agregado**: cada pod lido em paralelo (5 por vez, como o `kubectl`) com
  `timestamps=true`, linhas intercaladas pelo horário e marcadas com o pod. As últimas
  N linhas no total estão sempre entre as últimas N de cada pod, então o corte é exato.
- **Limites**: até 20 pods por leitura (o excedente é avisado), até 5000 linhas, 2 MiB
  guardados por pod (as mais antigas saem primeiro, avisado), linhas de até 4000
  caracteres, códigos de cor ANSI removidos, tempo limite = `CM_K8S_POLL_TIMEOUT_SECONDS`.
  Erro de um pod (container ainda não subiu, sem execução anterior) vem com a mensagem
  do cluster e não impede os outros.
- **Execução anterior** (`previous`) disponível: é o que explica um CrashLoopBackOff.

## Consequências
- A **API** (e não só o worker) passa a precisar de rota até a porta 6443 dos clusters.
- Sem acompanhamento ao vivo (`-f`) nesta etapa: a tela lê sob demanda (botão
  Atualizar). O ao vivo entra depois pelo WebSocket com ticket de uso único (doc 07).
- Pedidos repetidos geram uma linha de auditoria cada; por isso a tela não atualiza
  sozinha.
