#!/usr/bin/env bash
# Security checklist of docs/architecture/08-seguranca.md (item 4), runnable locally/CI.
#
# Policy: fail on any HIGH/CRITICAL finding that has a fix available. Findings without
# a published fix (e.g. Debian "affected"/"fix_deferred") are reported, not failed:
# they are cleared by rebuilding once the distro ships the fix.
#
#   ./scripts/security-scan.sh            # images must be built (docker compose build)
set -uo pipefail
cd "$(dirname "$0")/.."

TRIVY_IMAGE=${TRIVY_IMAGE:-aquasec/trivy:latest}
IMAGES=(cloud-manager-backend:dev cloud-manager-frontend:latest)
failed=()

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
check() { local name=$1; shift; if "$@"; then echo "ok"; else failed+=("$name"); fi; }

step "pip-audit (backend dependencies)"
check pip-audit backend/.venv/bin/pip-audit --skip-editable --progress-spinner off

step "bandit (backend code)"
check bandit backend/.venv/bin/bandit -q -r backend/app

step "npm audit (frontend runtime dependencies)"
check npm-audit npm --prefix frontend audit --omit=dev --audit-level=high

trivy() {
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v cm-trivy-cache:/root/.cache \
    "$TRIVY_IMAGE" image --quiet --severity HIGH,CRITICAL "$@"
}
for image in "${IMAGES[@]}"; do
  step "trivy $image (HIGH/CRITICAL with a fix -> fail)"
  check "trivy:$image" trivy --ignore-unfixed --exit-code 1 "$image"
  unfixed=$(trivy --format json "$image" 2>/dev/null \
    | jq '[.Results[]?.Vulnerabilities[]? | select(.Status != "fixed")] | length')
  echo "sem correção publicada (reportado, não bloqueia): ${unfixed:-?}"
done

if ((${#failed[@]})); then
  printf '\n\033[31mFALHOU: %s\033[0m\n' "${failed[*]}"
  exit 1
fi
printf '\n\033[32mOK: nenhum achado alto/crítico com correção disponível\033[0m\n'
