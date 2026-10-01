#!/usr/bin/env bash
set -euo pipefail

# Thin process-dispatch shim. Antigravity lifecycle, model/settings validation,
# launchd ownership, readiness, and fallback decisions live in the typed
# platform module.
home="${HOME:-$USERPROFILE}"
codex_home="${CODEX_HOME:-$home/.codex}"
resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$home"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "ensure-codex-antigravity-proxy: node not found" >&2; exit 127; }
exec "$node_bin" "$codex_home/src/platform/antigravity-ensure.ts"
