#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-agent-monitor-demo}"
REGION="${REGION:-us-central1}"

CMD=(
  gcloud run deploy "${SERVICE_NAME}"
  --source "${UI_DIR}"
  --region "${REGION}"
  --allow-unauthenticated
)

echo "Deploy command:"
printf '  %q' "${CMD[@]}"
echo

if [[ "${1:-}" != "--yes" ]]; then
  echo "Dry run: pass --yes to execute."
  exit 0
fi

exec "${CMD[@]}"
