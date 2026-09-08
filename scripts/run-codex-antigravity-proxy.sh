#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "run-codex-antigravity-proxy: node not found" >&2; exit 127; }
codex_home="${CODEX_HOME:-$HOME/.codex}"
exec "$node_bin" "$codex_home/hooks/codex-antigravity-cli-responses-proxy.mjs"
