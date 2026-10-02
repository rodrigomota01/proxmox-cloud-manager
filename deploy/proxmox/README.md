# Identidade técnica no Proxmox

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

## Verificação

```bash
read -s PVE_SECRET
curl -s -H 'Authorization: PVEAPIToken=cloudmgr@pve!cm='"$PVE_SECRET" \
  'https://<host>:8006/api2/json/cluster/resources?type=vm' | python3 -m json.tool
```

Deve listar apenas os guests do pool.
