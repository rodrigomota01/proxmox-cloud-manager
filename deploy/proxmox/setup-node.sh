#!/usr/bin/env bash
# Prepares a standalone Proxmox VE server for the Cloud Manager: technical user, API token
# and least-privilege ACLs. Run ON THE NODE as root. Safe to re-run.
#
#   STORAGE=vz-folder BRIDGE=vmbr0 TEMPLATES="9998" bash setup-node.sh
#
#   POOL       pool the platform owns (default cm-lab). Guests outside it stay invisible.
#   STORAGE    storage where new disks go (Datastore.Audit + AllocateSpace there only)
#   BRIDGE     bridge the templates' NICs use (SDN.Use there only)
#   TEMPLATES  template VMIDs the platform may clone (read + clone only, never change)
#
# It never touches existing guests. The token secret is printed ONCE (on creation).
set -euo pipefail

POOL=${POOL:-cm-lab}
STORAGE=${STORAGE:?set STORAGE (pvesm status)}
BRIDGE=${BRIDGE:?set BRIDGE (bridge of the templates net0, e.g. vmbr0)}
TEMPLATES=${TEMPLATES:-}
PVE_USER=cloudmgr@pve
TOKEN_ID=cm
TOKEN="${PVE_USER}!${TOKEN_ID}"   # non-interactive bash: no history expansion here

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

command -v pveum >/dev/null || { echo "run this on a Proxmox VE node" >&2; exit 1; }
for vmid in $TEMPLATES; do
  qm config "$vmid" 2>/dev/null | grep -q '^template: 1' \
    || { echo "VMID $vmid is not a template on this node" >&2; exit 1; }
done
pvesm status --storage "$STORAGE" >/dev/null 2>&1 \
  || { echo "storage $STORAGE not found (pvesm status)" >&2; exit 1; }

say "PVE $(pveversion | cut -d/ -f2)"

# Privilege names differ between PVE 8 and 9 (guest agent). Keep only names this node
# knows: the built-in Administrator role holds every privilege of the installed version.
# (perl + JSON ship with every PVE node; python3 may not be installed)
known=$(pveum role list --output-format json | perl -MJSON -e '
  for my $r (@{ decode_json(join "", <STDIN>) }) {
    print $r->{privs} if $r->{roleid} eq "Administrator";
  }')
privs() {
  local out=() p
  for p in "$@"; do
    if [[ ",$known," == *",$p,"* ]]; then out+=("$p"); else echo "  (sem $p nesta versão)" >&2; fi
  done
  local IFS=,; echo "${out[*]}"
}

ROLE_PRIVS=$(privs VM.Audit VM.PowerMgmt VM.Console VM.Monitor VM.GuestAgent.Audit \
  Pool.Audit Datastore.Audit Sys.Audit \
  VM.Allocate VM.Clone VM.Config.CPU VM.Config.Memory VM.Config.Disk VM.Config.Network \
  VM.Config.Cloudinit VM.Config.Options)

role() {  # create, or reset an existing role to exactly these privileges
  pveum role add "$1" --privs "$2" 2>/dev/null || pveum role modify "$1" --privs "$2"
  echo "role $1: $2"
}
acl() {  # same role for the user and for its token (privilege separation)
  pveum acl modify "$1" --users "$PVE_USER" --roles "$2"
  pveum acl modify "$1" --tokens "$TOKEN" --roles "$2"
  echo "acl $1 -> $2"
}

say "pool $POOL"
pvesh get "/pools/$POOL" >/dev/null 2>&1 \
  || pvesh create /pools --poolid "$POOL" --comment "Cloud Manager"

say "usuário e roles"
if ! out=$(pveum user add "$PVE_USER" --comment "Cloud Manager service account" 2>&1); then
  [[ $out == *"already exists"* ]] || { echo "$out" >&2; exit 1; }
  echo "usuário $PVE_USER já existe"
fi
role CloudManager "$ROLE_PRIVS"
role CMNode "$(privs Sys.Audit)"
role CMTemplate "$(privs VM.Audit VM.Clone)"
role CMStorage "$(privs Datastore.Audit Datastore.AllocateSpace)"
role CMNetwork "$(privs SDN.Use)"

say "token"
if out=$(pveum user token add "$PVE_USER" "$TOKEN_ID" --privsep 1 --comment "cloud-manager" \
          --output-format json 2>&1); then
  echo "token $TOKEN criado. GUARDE O SECRET ABAIXO, ele não aparece de novo:"
  perl -MJSON -e 'print "\n  secret: ", decode_json($ARGV[0])->{value}, "\n\n"' "$out"
elif [[ $out == *"already exists"* ]]; then
  echo "token $TOKEN já existe (o secret não é exibido de novo; para trocar:"
  echo "  pveum user token remove $PVE_USER $TOKEN_ID  e rode este script outra vez)"
else
  echo "$out" >&2; exit 1
fi

say "ACLs (só onde precisa)"
acl "/pool/$POOL" CloudManager
acl /nodes CMNode
acl "/storage/$STORAGE" CMStorage
acl "/sdn/zones/localnetwork/$BRIDGE" CMNetwork
for vmid in $TEMPLATES; do acl "/vms/$vmid" CMTemplate; done

say "permissões efetivas do token"
pveum user token permissions "$PVE_USER" "$TOKEN_ID"
cat <<EOF

Pronto. Na plataforma: Clusters -> Novo cluster
  URL: https://$(hostname -f):8006   Pool de destino: $POOL
  Token ID: $TOKEN
Depois: Testar conexão, Sincronizar e registrar os templates em Imagens.
EOF
