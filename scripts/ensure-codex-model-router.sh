#!/usr/bin/env bash
set -euo pipefail

router_url="http://${CODEX_MODEL_ROUTER_HOST:-127.0.0.1}:${CODEX_MODEL_ROUTER_PORT:-4100}"
if curl --silent --fail --max-time 1 "${router_url}/health/liveliness" >/dev/null 2>&1; then
  exit 0
fi

launcher="$HOME/.codex/hooks/run-codex-model-router.sh"
if [[ -L "$launcher" ]]; then launcher="$(readlink "$launcher")"; fi
nohup /bin/bash "$launcher" >"${TMPDIR:-/tmp}/codex-model-router.log" 2>&1 </dev/null &
for _ in {1..50}; do
  if curl --silent --fail --max-time 1 "${router_url}/health/liveliness" >/dev/null 2>&1; then exit 0; fi
  sleep 0.1
done
echo "Codex model router failed to start. Log: ${TMPDIR:-/tmp}/codex-model-router.log" >&2
exit 1
