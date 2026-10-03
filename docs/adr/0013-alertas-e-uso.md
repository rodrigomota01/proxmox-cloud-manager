# ADR-0013 — Uso de disco/rede, alertas e notificações

**Status:** Aceito · **Data:** 2026-10-03

## Contexto
Admins e clientes querem ver o consumo atual (CPU, memória, disco, rede), as VMs que
mais consomem (visão geral e por cliente) e ser avisados de consumo alto por e-mail e
webhook, além da própria plataforma.

## Decisão
- **Rede**: o `/cluster/resources` traz contadores acumulados (`netin`/`netout`); a
  taxa é o delta entre dois syncs dividido pelo intervalo. Contador menor que o anterior
  = reboot → sem taxa nessa rodada. Tráfego de um hypervisor = soma das suas VMs.
- **Disco**: containers vêm do próprio inventário. VMs só pelo **QEMU guest agent**
  (`agent/get-fsinfo`), lido pelo worker a cada `CM_GUEST_DISK_INTERVAL_SECONDS`
  (300 s) só para VMs ligadas. `disk_usage` = o sistema de arquivos **mais cheio** (é
  o que acaba primeiro), não a média.
- **Permissão do agente**: no PVE 9 `VM.GuestAgent.Audit` é só leitura e vai para o
  papel de auditoria (`AUDIT_ALL`). No PVE 8 a única forma é `VM.Monitor`, que também
  permite `agent/exec` (comando como root no guest): **não** é concedida fora do pool
  gerenciado. VMs de clientes fora do pool ficam com "agente sem permissão" até o PVE 9.
- **Regras** (`alert_rules`): da plataforma (`tenant_id` NULL; hypervisor, storage ou
  VM) ou do cliente (só VMs dele). Disparo: valor > limite por `duration_seconds`;
  resolução abaixo de 95% do limite (histerese, evita oscilar a cada 15 s). Regras
  padrão criadas na migration (CPU/memória de host e VM, storage, disco de VM).
- **Avaliação** no worker, logo após cada sync, numa transação com advisory lock (um
  avaliador por vez) que também enfileira as notificações: estado do alerta e aviso
  nunca divergem.
- **Quem é avisado**: canais do dono da regra + canais do cliente dono do recurso.
  Regra padrão numa VM de cliente avisa a operação e o cliente; regra do cliente avisa
  só o cliente. Um job por canal: receptor fora do ar é refeito sozinho
  (`RetryLater`), sem duplicar nos outros.
- **Webhook** (superfície de SSRF, o worker tem egress): só https, sem redirect, sem
  credencial na URL, todo IP resolvido precisa ser público e a conexão vai **para o IP
  verificado** (SNI/certificado no nome original), sem segundo DNS. Corpo assinado com
  HMAC-SHA256 (`X-CM-Timestamp`, `X-CM-Signature`); o segredo é cifrado como as
  credenciais do Proxmox e exibido uma única vez.
- **Visibilidade**: o cliente vê alertas dos seus recursos respeitando projeto; nunca
  hypervisor/storage. Admin vê tudo, filtrável por cliente.

## Consequências
- Memória de VM é a visão do host (inclui cache do guest sem balloon): VMs podem
  aparecer perto de 100% sem estarem sob pressão. A regra padrão usa 95% por 15 min.
- Alertas usam a última observação: com o servidor offline, VMs ficam `unknown` e seus
  alertas são resolvidos (o servidor offline já aparece no status do hypervisor).
