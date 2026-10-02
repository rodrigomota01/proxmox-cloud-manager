# 04 — Integração com Proxmox

## Camadas

```
Domínio (compute, images, storage, network, inventory, access)
        │  usa somente tipos do domínio: InstanceSpec, PowerAction, ProviderRef…
        ▼
CloudProvider (interface)                 app/providers/base.py
        │  resolvido por cluster via ProviderRegistry
        ▼
ProxmoxProvider                           app/providers/proxmox/provider.py
  ├── ProxmoxClusterService   cluster.py   /cluster/status, /cluster/resources
  ├── ProxmoxNodeService      nodes.py     /nodes, /nodes/{n}/status
  ├── ProxmoxVMService        vms.py       /nodes/{n}/qemu/…
  ├── ProxmoxContainerService containers.py /nodes/{n}/lxc/…
  ├── ProxmoxStorageService   storage.py   /storage, /nodes/{n}/storage/…
  ├── ProxmoxNetworkService   network.py   /nodes/{n}/network, /cluster/sdn/…
  ├── ProxmoxTemplateService  templates.py clone/convert template
  ├── ProxmoxConsoleService   console.py   vncproxy, termproxy, vncwebsocket
  ├── ProxmoxTaskService      tasks.py     UPID polling
  └── mapper.py                            PVE dict  ⇄  tipos do domínio
        ▼
ProxmoxClient                             app/providers/proxmox/client.py
  httpx.AsyncClient, auth por API token, TLS pinado, retry/backoff,
  semáforo de concorrência por cluster, circuit breaker, métricas, logs
```

Somente `client.py` conhece URLs e headers. Somente `mapper.py` conhece nomes de campos
do PVE (`maxmem`, `cores`, `scsi0`, `ipconfig0`…). Os services traduzem intenção em
chamadas; o provider orquestra services e devolve tipos do domínio.

## Interface do provider (contrato do domínio)

```python
class CloudProvider(Protocol):
    kind: ClassVar[str]                                   # "proxmox"

    # inventário
    async def health(self) -> ProviderHealth: ...
    async def list_nodes(self) -> list[NodeInfo]: ...
    async def list_instances(self) -> list[InstanceObservation]: ...   # VM + LXC, 1 chamada
    async def get_instance(self, ref: ProviderRef) -> InstanceObservation: ...
    async def list_storage(self) -> list[StorageObservation]: ...
    async def list_networks(self) -> list[NetworkObservation]: ...
    async def list_images(self) -> list[ImageObservation]: ...

    # ciclo de vida (retornam OperationHandle = UPID encapsulado)
    async def create_instance(self, spec: InstanceSpec) -> OperationHandle: ...
    async def clone_instance(self, src: ProviderRef, spec: InstanceSpec) -> OperationHandle: ...
    async def power(self, ref: ProviderRef, action: PowerAction) -> OperationHandle: ...
    async def reconfigure(self, ref: ProviderRef, change: InstanceChange) -> OperationHandle | None: ...
    async def resize_volume(self, ref: ProviderRef, volume: str, new_size_gb: int) -> OperationHandle: ...
    async def delete_instance(self, ref: ProviderRef, purge: bool = True) -> OperationHandle: ...
    async def migrate(self, ref: ProviderRef, target_node: str, online: bool) -> OperationHandle: ...
    async def snapshot(self, ref: ProviderRef, name: str, include_ram: bool) -> OperationHandle: ...
    async def rollback(self, ref: ProviderRef, name: str) -> OperationHandle: ...

    # operações assíncronas
    async def wait(self, op: OperationHandle, on_progress: ProgressCb) -> OperationResult: ...

    # acesso
    async def open_console(self, ref: ProviderRef, kind: ConsoleKind) -> ConsoleEndpoint: ...
```

`PowerAction = start | stop | shutdown | reboot | suspend | resume`. Nada de `qemu`,
`lxc`, `UPID` ou `node` aparece nos nomes do contrato — `ProviderRef` é opaco para o
domínio (só o provider abre).

Para testes existe `FakeProvider` (em memória, determinístico) e um **mock HTTP da PVE
API** (`respx`) para testar o `ProxmoxProvider` sem cluster.

## Identidade técnica e permissões no Proxmox

Um usuário técnico por cluster, com **API token com privilege separation**:

```bash
# no cluster (uma vez)
pveum user add cloudmgr@pve --comment "Cloud Manager service account"
pveum role add CloudManager --privs "\
VM.Audit,VM.Allocate,VM.Clone,VM.PowerMgmt,VM.Console,VM.Migrate,VM.Snapshot,VM.Snapshot.Rollback,\
VM.Config.CPU,VM.Config.Memory,VM.Config.Disk,VM.Config.Network,VM.Config.Options,\
VM.Config.Cloudinit,VM.Config.HWType,VM.Config.CDROM,\
Datastore.Audit,Datastore.AllocateSpace,Datastore.AllocateTemplate,\
Pool.Audit,Pool.Allocate,Sys.Audit,SDN.Audit,SDN.Use"
pveum user token add cloudmgr@pve cm --privsep 1 --comment "cloud-manager"
pveum acl modify / --users  'cloudmgr@pve'    --roles CloudManager
pveum acl modify / --tokens 'cloudmgr@pve!cm' --roles CloudManager
```

- **Não** inclui `Sys.Modify`, `Sys.PowerMgmt`, `Permissions.Modify`, `Realm.*`,
  `User.Modify`, `Datastore.Allocate` (criar/remover storage) — o Cloud Manager não
  administra o hypervisor em si.
- Leitura de IP via guest agent: no PVE 8 exige `VM.Monitor`; no PVE 9 os privilégios
  de agente foram divididos (`VM.GuestAgent.*`). **Validar a lista com
  `pveum role list` na versão alvo** antes de aplicar — o seed do role fica versionado em
  `deploy/proxmox/` a partir da Fase 1.
- Endurecimento posterior: trocar a ACL em `/` por ACLs em `/vms`, `/pool/cm-*`,
  `/storage/<oferecidos>`, `/sdn/zones/<zona-tenants>`, `/nodes` (Sys.Audit).
- Token salvo cifrado em `provider_credentials` ([ADR-0007](../adr/0007-credenciais-proxmox.md)).
  Header usado: `Authorization: PVEAPIToken=cloudmgr@pve!cm=<secret>`.
  API tokens não precisam de CSRF token nem de ticket.
- TLS: CA própria do cluster ou **fingerprint SHA-256 pinado** por cluster.
  `verify=False` é proibido fora de `ENV=dev`.

## Convenções no lado do Proxmox

| Item | Convenção | Motivo |
|---|---|---|
| VMIDs | Faixa reservada por cluster (`settings.vmid_range`, ex.: 10000–19999), alocação no banco com lock + retry em conflito | `/cluster/nextid` tem corrida entre chamadas concorrentes; faixa evita colidir com VMs manuais |
| Nome no PVE | `cm-<shortid>` (o nome amigável fica no banco) | Nome do usuário pode ser inválido como hostname/duplicado |
| Pool | `cm-<tenant-slug>-<project-slug>` | Visão por tenant no PVE, base para ACL mais restrita |
| Tags | `cm-managed`, `cm-t-<tenantshort>` | Detectar o que é gerenciado mesmo sem o banco |
| Descrição | `managed-by: cloud-manager / instance: <uuid>` | Recuperação/adoção após perda do banco |
| Templates | VMs `template=1` na faixa 9000–9999 do cluster, referenciadas por `images.provider_ref` | Clone linked/full a partir delas |

## Tasks (UPID) e operações longas

Quase toda mutação no PVE devolve um `UPID` e roda em background no node.

```
POST /nodes/{node}/qemu/{vmid}/status/start   → "UPID:pve02:0002A1B3:…:qmstart:105:cloudmgr@pve!cm:"
GET  /nodes/{node}/tasks/{upid}/status         → {status: running|stopped, exitstatus: "OK"|"<erro>"}
GET  /nodes/{node}/tasks/{upid}/log?start=N    → linhas de log (progresso de clone/migrate)
```

- `ProxmoxTaskService.wait()` faz polling com backoff (0.5s → 5s, teto configurável por
  tipo de operação), publica progresso a partir do log e converte `exitstatus != "OK"` em
  `ProviderOperationError` com a mensagem do PVE.
- O `UPID` é persistido em `job_events` → se o worker morrer, outro worker retoma o
  polling do mesmo UPID (o job é idempotente a partir do último passo concluído).
- **Serialização por instância**: o worker pega `pg_advisory_xact_lock` por
  `instance_id` antes de mutar, evitando `VM is locked (clone/backup/…)`.

## Fluxos mapeados

| Operação da plataforma | Chamadas PVE (qemu; lxc é análogo) |
|---|---|
| Listar inventário | `GET /cluster/resources` (VM+LXC+node+storage em **uma** chamada) |
| Start/Stop/Shutdown/Reboot | `POST …/status/{start\|stop\|shutdown\|reboot}` |
| Suspend/Resume | `POST …/status/{suspend\|resume}` |
| Criar de imagem | `POST …/{template}/clone` (`newid`, `name`, `pool`, `full`, `storage`, `target`) → `PUT …/{vmid}/config` (`cores`, `memory`, `ciuser`, `sshkeys`, `ipconfig0`, `nameserver`, `tags`, `description`) → `PUT …/{vmid}/resize` → `status/start` |
| Resize CPU/RAM | `PUT …/config` (hotplug se habilitado; senão marca `pending_reboot`) |
| Resize disco | `PUT …/resize` (`size=+NG`) — **só cresce**; a UI não oferece redução |
| Snapshot / Rollback | `POST …/snapshot` · `POST …/snapshot/{name}/rollback` |
| Migrar | `POST …/migrate` (`target`, `online`) |
| IP da VM | `GET …/agent/network-get-interfaces` (requer qemu-guest-agent na imagem) |
| IP do LXC | `GET /nodes/{n}/lxc/{vmid}/interfaces` |
| Console VGA | `POST …/vncproxy` (`websocket=1`) → `GET …/vncwebsocket` |
| Terminal (LXC / serial) | `POST …/termproxy` → `GET …/vncwebsocket` |
| Excluir | `DELETE /nodes/{n}/qemu/{vmid}?purge=1&destroy-unreferenced-disks=1` |

## Sincronização e fonte de verdade

Detalhado em [ADR-0003](../adr/0003-fonte-de-verdade-e-sincronizacao.md). Resumo:

| Dado | Fonte de verdade |
|---|---|
| Existência física, estado de energia, node atual, uso de CPU/RAM, uptime | **Proxmox** |
| Dono (tenant/projeto), nome amigável, imagem de origem, quota, preço, tags da plataforma | **Banco do Cloud Manager** |
| Configuração (vCPU/RAM/discos) | **Intenção no banco**, observação no PVE; divergência gera `inventory_drift` |

O PVE **não emite eventos** de mudança de estado de guests (o sistema de notificações dele
cobre backup/fencing/replicação, não lifecycle de VM). Por isso:

- **Reconciliador** no worker: a cada 15s (configurável) faz `GET /cluster/resources` por
  cluster e compara com o banco (custo: 1 request por ciclo, independente do nº de VMs).
- Busca `config` completa só para guests cujo `maxcpu/maxmem/maxdisk/tags/name` mudou.
- Casos:
  - **Guest novo fora da plataforma** → `instances.managed = false` (descoberto). Aparece
    só para admins, que podem *adotar* para um projeto.
  - **Guest sumiu** → após 2 ciclos consecutivos: `state = deleted_externally`, quota
    liberada, evento + audit `INSTANCE_DELETED_EXTERNALLY`.
  - **Config divergente** → atualiza observação, registra drift; não reverte
    automaticamente no MVP.
  - **Node offline** → `nodes.status = offline`; instâncias desse node com
    `power_state = unknown`.
  - **Cluster inacessível** → circuit breaker aberto, UI mostra dados com
    `last_synced_at` e banner "dados podem estar desatualizados".

## Tratamento de erros

| Situação | Tratamento |
|---|---|
| Timeout / conexão recusada | Retry com backoff + jitter (só para GET e para POSTs idempotentes por UPID); abre circuit breaker após N falhas |
| 401/403 do PVE | `ProviderAuthError` → alerta para admin (token expirado/revogado), nunca exposto em detalhe ao tenant |
| 500 com `VM is locked` | Retry com backoff (contenção) |
| Task com `exitstatus != OK` | Job `failed`, `error_code = PROVIDER_TASK_FAILED`, mensagem sanitizada ao usuário, detalhe completo no log/admin |
| Erro de validação do PVE (400) | `ProviderValidationError` mapeado para 422 com campo traduzido para o domínio |

Erros chegam ao cliente como `application/problem+json` com `request_id` (ver
[05](05-api.md)).
