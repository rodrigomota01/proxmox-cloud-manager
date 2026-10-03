#!/usr/bin/env bash
# End-to-end check of Phase 1 through the running stack (docker compose up) against a
# real Proxmox: cluster + credentials -> sync job -> adopt -> start/stop as tenant jobs.
#
#   ./scripts/e2e-lab.sh
#
# Needs: a platform admin (python -m app.cli create-admin), curl, jq.
# Prompts for the admin password and the Proxmox token secret (never echoed or stored).
set -euo pipefail

API=${API:-http://localhost/api/v1}
ADMIN_EMAIL=${ADMIN_EMAIL:?set ADMIN_EMAIL (a SUPER_ADMIN/PLATFORM_ADMIN user)}
PVE_URL=${PVE_URL:-https://hv08.sp02.atena.io:8006}
PVE_TOKEN_ID=${PVE_TOKEN_ID:-cloudmgr@pve!cm}
VMID=${VMID:-10001}
TENANT=${TENANT:-lab}
PROJECT=${PROJECT:-default}

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

read -rsp "Senha de $ADMIN_EMAIL: " ADMIN_PASSWORD; echo
read -rsp "Secret do token $PVE_TOKEN_ID: " PVE_SECRET; echo

# call METHOD PATH [JSON] -> prints the body; aborts on HTTP >= 400
call() {
  local method=$1 path=$2 body=${3:-} out code
  out=$(mktemp)
  local args=(-s -o "$out" -w '%{http_code}' -X "$method" "$API$path"
              -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
  [[ -n ${TENANT_ID:-} ]] && args+=(-H "X-Tenant-Id: $TENANT_ID")
  [[ -n $body ]] && args+=(-d "$body")
  code=$(curl "${args[@]}")
  if [[ $code -ge 400 ]]; then
    cat "$out" >&2; rm -f "$out"; fail "$method $path -> HTTP $code"
  fi
  cat "$out"; rm -f "$out"
}

# wait_job PATH -> polls until the job leaves pending/running, prints it
wait_job() {
  local job status
  for _ in $(seq 120); do
    job=$(call GET "$1")
    status=$(jq -r .status <<<"$job")
    [[ $status != pending && $status != running ]] && { echo "$job"; return; }
    sleep 1
  done
  fail "job $1 did not finish in 120s"
}

step "login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" \
  | jq -r '.access_token // empty')
[[ -n $TOKEN ]] || fail "login falhou (o admin existe? python -m app.cli create-admin)"
echo ok

step "cluster"
CLUSTER_ID=$(call GET /admin/clusters | jq -r '.[] | select(.name=="lab") | .id')
if [[ -z $CLUSTER_ID ]]; then
  CLUSTER_ID=$(call POST /admin/clusters "$(jq -n --arg u "$PVE_URL" '{name:"lab",api_url:$u}')" | jq -r .id)
fi
call PUT "/admin/clusters/$CLUSTER_ID/credentials" \
  "$(jq -n --arg t "$PVE_TOKEN_ID" --arg s "$PVE_SECRET" '{token_id:$t,secret:$s}')" >/dev/null
unset PVE_SECRET
TEST=$(call POST "/admin/clusters/$CLUSTER_ID/test")
jq . <<<"$TEST"
[[ $(jq -r .ok <<<"$TEST") == true ]] || fail "teste de conexão (secret/URL/VPN?)"

step "sync (job)"
JOB=$(call POST "/admin/clusters/$CLUSTER_ID/sync" | jq -r .job.id)
wait_job "/admin/jobs/$JOB" | jq '{status, result, error_message}'

step "tenant '$TENANT' e projeto '$PROJECT'"
TENANT_ID=$(call GET /admin/tenants | jq -r --arg s "$TENANT" '.[] | select(.slug==$s) | .id')
[[ -n $TENANT_ID ]] || TENANT_ID=$(call POST /tenants "$(jq -n --arg s "$TENANT" '{slug:$s,name:$s}')" | jq -r .id)
PROJECT_ID=$(call GET /projects | jq -r --arg s "$PROJECT" '.items[] | select(.slug==$s) | .id')
[[ -n $PROJECT_ID ]] || PROJECT_ID=$(call POST /projects "$(jq -n --arg s "$PROJECT" '{slug:$s,name:$s}')" | jq -r .id)
echo "tenant=$TENANT_ID project=$PROJECT_ID"

step "adotar vmid $VMID"
INSTANCE=$(call GET /admin/instances | jq -c --argjson v "$VMID" '.[] | select(.vmid==$v)')
[[ -n $INSTANCE ]] || fail "vmid $VMID não está no inventário (pool/ACL?)"
INSTANCE_ID=$(jq -r .id <<<"$INSTANCE")
if [[ $(jq -r .managed <<<"$INSTANCE") != true ]]; then
  call POST "/admin/instances/$INSTANCE_ID/adopt" \
    "$(jq -n --arg t "$TENANT_ID" --arg p "$PROJECT_ID" '{tenant_id:$t,project_id:$p}')" >/dev/null
fi
call GET "/instances/$INSTANCE_ID" | jq '{name, kind, power_state, vcpus, memory_mb}'

for action in start stop; do
  step "$action (job do tenant)"
  JOB=$(call POST "/instances/$INSTANCE_ID/$action" | jq -r .job.id)
  RESULT=$(wait_job "/jobs/$JOB")
  jq '{status, result, error_code, error_message, events: [.events[].kind]}' <<<"$RESULT"
  [[ $(jq -r .status <<<"$RESULT") == succeeded ]] || fail "$action"
done

step "dashboard"
call GET /dashboard/summary | jq '{projects, instances, active_jobs}'
printf '\n\033[32mOK: fluxo da Fase 1 validado contra o Proxmox real\033[0m\n'
