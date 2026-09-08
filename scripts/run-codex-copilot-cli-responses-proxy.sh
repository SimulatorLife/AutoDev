#!/usr/bin/env bash
set -euo pipefail
hook_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "run-codex-copilot-proxy: node not found" >&2; exit 127; }
exec env COPILOT_PROXY_HOST="${CODEX_COPILOT_PROXY_HOST:-127.0.0.1}" COPILOT_PROXY_PORT="${CODEX_COPILOT_PROXY_PORT:-4003}" \
  "$node_bin" "$hook_dir/codex-copilot-cli-responses-proxy.mjs"
