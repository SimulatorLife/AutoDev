#!/usr/bin/env bash
set -euo pipefail

proxy_url="http://${CODEX_COPILOT_PROXY_HOST:-127.0.0.1}:${CODEX_COPILOT_PROXY_PORT:-4003}"
if curl --silent --fail --max-time 1 "${proxy_url}/health/liveliness" >/dev/null 2>&1; then exit 0; fi
command -v "${COPILOT_BIN:-copilot}" >/dev/null 2>&1 || { echo "GitHub Copilot CLI is unavailable; skipping Copilot fallback." >&2; exit 0; }
launcher="$HOME/.codex/hooks/run-codex-copilot-cli-responses-proxy.sh"
nohup /bin/bash "$launcher" >"${TMPDIR:-/tmp}/codex-copilot-proxy.log" 2>&1 </dev/null &
for _ in {1..50}; do
  if curl --silent --fail --max-time 1 "${proxy_url}/health/liveliness" >/dev/null 2>&1; then exit 0; fi
  sleep 0.1
done
echo "Copilot proxy did not become ready; router will skip this fallback." >&2
exit 0
