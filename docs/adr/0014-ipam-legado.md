# ADR-0014 — IPs: integração com o cadastro legado (MySQL `awf_ip_pool`)

**Status:** Aceito · **Data:** 2026-10-03

## Contexto
Os IPs públicos são controlados numa tabela MySQL/MariaDB (`awf_cloud.awf_ip_pool`)
usada por outros sistemas e pessoas. O Cloud Manager precisa saber quais estão livres
e quais estão de fato em uso, e passar a reservar/liberar IPs ao criar/excluir VMs.

## Decisão
- **O MySQL continua a fonte da verdade.** O worker (único com saída de rede) lê a
  tabela a cada `CM_IPAM_SYNC_INTERVAL_SECONDS` (120 s) para `ipam_addresses`; a API
  só lê essa cópia. Usuário MySQL com `SELECT, UPDATE` só nessa tabela; URL em
  `CM_IPAM_MYSQL_URL` (segredo, nunca logado).
- Cada IP é ligado a um servidor pelo `pve_node_owner` = nome do node no Proxmox.
- **Uso real** vem das placas de rede das VMs (config do Proxmox: MAC, bridge, VLAN e
  IP do cloud-init / do container), lidas no mesmo intervalo. Situações: livre, em uso,
  **VM sem este IP** (a VM do registro existe mas não tem o IP — típico de NAT/LB),
  **sem VM**, **conflito** (livre no cadastro mas em uso) e IPs públicos fora do
  cadastro. Evidência por IP vence a por MAC.
- O cadastro não guarda gateway/máscara/VLAN: **perfis de rede por servidor**
  (`ipam_networks`: faixa, gateway, VLAN, bridge), sugeridos a partir das VMs
  existentes e confirmados pelo admin. Endereços com `/31` dispensam perfil (gateway =
  o par do /31).
- **Criação de VM** (etapa 2): o formulário oferece os IPs livres do servidor; o job
  reserva no MySQL com `UPDATE ... WHERE id = ? AND assigned = 0` (dois sistemas não
  ganham o mesmo IP), aplica MAC pré-atribuído (MAC virtual de IP failover) e VLAN na
  placa, e libera o IP ao excluir a VM (só se ainda estiver com o hostname dela).
