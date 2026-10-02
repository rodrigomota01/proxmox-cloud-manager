# deploy/

| Pasta | Conteúdo | Fase |
|---|---|---|
| `docker/postgres/init/` | Cria roles `cm_owner` (migrations) e `cm_app` (runtime, sem BYPASSRLS) | 0 |
| `proxmox/` | Script/role do usuário técnico `cloudmgr@pve` + API token | 1 |
| `helm/` | Chart da plataforma | 6 |
| `openshift/` | Overlays (SCC restricted-v2, Routes) | 6 |
