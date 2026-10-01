#!/usr/bin/env bash
set -euo pipefail

# Process-dispatch shim. Model matching, OAuth validation, launchd ownership,
# readiness, and fallback policy live in the typed platform owner.
if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi

codex_home="${CODEX_HOME:-$HOME/.codex}"
resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "ensure-codex-claude-bridge: node not found" >&2; exit 127; }
exec "$node_bin" "$codex_home/src/platform/claude-ensure.ts"
