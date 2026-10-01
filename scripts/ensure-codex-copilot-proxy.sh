#!/usr/bin/env bash
set -euo pipefail

# Process-dispatch shim. Copilot lifecycle and optional-CLI policy live in the
# typed platform owner.
codex_home="${CODEX_HOME:-$HOME/.codex}"
resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "ensure-codex-copilot-proxy: node not found" >&2; exit 127; }
exec "$node_bin" "$codex_home/src/platform/copilot-ensure.ts"
