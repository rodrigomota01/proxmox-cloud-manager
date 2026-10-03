# Identidade técnica no Proxmox

## Servidor novo: `setup-node.sh` (recomendado)

Prepara um servidor Proxmox independente de uma vez — pool, usuário, roles, token e
ACLs de privilégio mínimo (leitura/energia/criação **só no pool**, clone **só** nos
templates indicados, disco **só** no storage indicado, rede **só** na bridge indicada).
Detecta a versão do PVE (privilégios do guest agent mudam do 8 para o 9), não toca em
nenhuma VM existente e pode ser rodado de novo (não recria nada; o secret do token só
aparece na criação).

```bash
# no node, como root (leia o script antes: less setup-node.sh)
curl -fsSLO https://raw.githubusercontent.com/rodrigomota01/proxmox-cloud-manager/main/deploy/proxmox/setup-node.sh
STORAGE=<storage> BRIDGE=<bridge> TEMPLATES="<vmid> <vmid>" bash setup-node.sh
```

`STORAGE`: `pvesm status`. `BRIDGE` e se o template tem cloud-init: `qm config <vmid>`
(`net0: ...bridge=vmbr0`, `ide2: ...cloudinit`).

As seções abaixo documentam o passo a passo manual equivalente (usado no primeiro lab).

Referência de privilégios em
[04-integracao-proxmox.md](../../docs/architecture/04-integracao-proxmox.md#identidade-técnica-e-permissões-no-proxmox).
Validado em PVE 8.4.19 (node único).

## Fase 1 — leitura + power, restrito a um pool

O token só enxerga e controla os guests do pool `cm-lab`. Guests fora do pool ficam
invisíveis para a plataforma. Nenhum comando abaixo reinicia serviços ou altera guests
existentes; tudo é desfeito com `pveum user delete cloudmgr@pve && pveum role delete CloudManager`.

> Use aspas simples em `'cloudmgr@pve!cm'`: em aspas duplas, bash e zsh interativos
> fazem expansão de histórico do `!`.

```bash
pvesh create /pools --poolid cm-lab --comment "Cloud Manager - testes"
# mover guests descartáveis para o pool (ou clonar com --pool cm-lab)
pvesh set /pools/cm-lab --vms <VMID>[,<VMID>...]

pveum user add cloudmgr@pve --comment "Cloud Manager service account"
pveum role add CloudManager --privs "VM.Audit,VM.PowerMgmt,VM.Console,VM.Monitor,Pool.Audit,Datastore.Audit,Sys.Audit"
pveum user token add cloudmgr@pve cm --privsep 1 --comment "cloud-manager"   # secret aparece uma vez

pveum acl modify /pool/cm-lab --users  cloudmgr@pve      --roles CloudManager
pveum acl modify /pool/cm-lab --tokens 'cloudmgr@pve!cm' --roles CloudManager
pveum acl modify /nodes       --users  cloudmgr@pve      --roles CloudManager
pveum acl modify /nodes       --tokens 'cloudmgr@pve!cm' --roles CloudManager
```

- `VM.Monitor` é necessário no PVE 8 para ler IP via guest agent; no PVE 9 ele foi
  substituído por `VM.GuestAgent.*`.
- Privilégios de criação (`VM.Allocate`, `VM.Clone`, `VM.Config.*`,
  `Datastore.AllocateSpace`) entram na Fase 2, junto com ACL no template e no storage.

## Fase 2a — criar e excluir VMs a partir de um template

Roles separados por alvo, cada um com o mínimo. O token **clona** o template mas não o
altera nem apaga; cria/configura/apaga VMs só **dentro do pool**; usa só o storage e a
bridge necessários. Ajuste `9998`, `storage-vz` e `vmbr0` ao seu ambiente
(`qm config <template>`).

```bash
pveum role add CMTemplate --privs "VM.Audit,VM.Clone"
pveum role add CMStorage  --privs "Datastore.Audit,Datastore.AllocateSpace"
pveum role add CMNetwork  --privs "SDN.Use"
pveum role modify CloudManager --append 1 --privs "VM.Allocate,VM.Clone,VM.Config.CPU,VM.Config.Memory,VM.Config.Disk,VM.Config.Network,VM.Config.Cloudinit,VM.Config.Options"

pveum acl modify /vms/9998                     --users cloudmgr@pve      --roles CMTemplate
pveum acl modify /vms/9998                     --tokens 'cloudmgr@pve!cm' --roles CMTemplate
pveum acl modify /storage/storage-vz           --users cloudmgr@pve      --roles CMStorage
pveum acl modify /storage/storage-vz           --tokens 'cloudmgr@pve!cm' --roles CMStorage
pveum acl modify /sdn/zones/localnetwork/vmbr0 --users cloudmgr@pve      --roles CMNetwork
pveum acl modify /sdn/zones/localnetwork/vmbr0 --tokens 'cloudmgr@pve!cm' --roles CMNetwork

pveum user token permissions cloudmgr@pve cm   # conferência
```

Na plataforma: defina o **pool de destino** do cluster (ex.: `cm-lab`) e registre o
template em *Admin → Imagens*. O template precisa de drive de cloud-init; chaves, senha e
IP dele **não** são herdados pelas VMs criadas.

## Verificação

```bash
read -s PVE_SECRET
curl -s -H 'Authorization: PVEAPIToken=cloudmgr@pve!cm='"$PVE_SECRET" \
  'https://<host>:8006/api2/json/cluster/resources?type=vm' | python3 -m json.tool
```

Deve listar apenas os guests do pool.

## Teste automatizado contra o lab

Critério de saída da Fase 1. Os testes ficam pulados sem as variáveis:

```bash
cd backend
export CM_LAB_PVE_URL=https://<host>:8006 CM_LAB_PVE_TOKEN_ID='cloudmgr@pve!cm'
read -s CM_LAB_PVE_SECRET && export CM_LAB_PVE_SECRET
# opcional: liga e desliga um guest descartável do pool
export CM_LAB_POWER_VMID=10001
.venv/bin/pytest -m lab -v -s
```

Verifica conexão/versão, que **todo** guest visível pertence ao pool (privilégio mínimo)
e, com `CM_LAB_POWER_VMID`, um ciclo start → stop (recusa guests fora do pool).

## Cadastro pela API

```bash
# token de um usuário com PLATFORM_ADMIN/SUPER_ADMIN
curl -s -X POST localhost/api/v1/admin/clusters -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"lab","api_url":"https://<host>:8006"}'
curl -s -X PUT localhost/api/v1/admin/clusters/<id>/credentials -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"token_id":"cloudmgr@pve!cm","secret":"'"$PVE_SECRET"'"}'
curl -s -X POST localhost/api/v1/admin/clusters/<id>/test -H "Authorization: Bearer $TOKEN"
```

Storage só aparece no inventário com `Datastore.Audit` no storage
(`pveum acl modify /storage/<nome> ...`); com a ACL só no pool, a lista vem vazia.
