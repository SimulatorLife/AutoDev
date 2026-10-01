#!/usr/bin/env bash
set -euo pipefail

# Process-dispatch shim. Model matching, launchd ownership, readiness, and
# fallback policy live in the typed platform owner. Launchd's --daemon path is
# deliberately a direct exec of the typed provider so launchd supervises the
# server itself rather than a short-lived ensure process.
if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi

codex_home="${CODEX_HOME:-$HOME/.codex}"
resolve_node() {
  # launchd passes the native Node the installer resolved; PATH order alone
  # can pick an Intel build that Rosetta translates on every cold start.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then printf '%s\n' "$AUTODEV_NODE_BIN"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "ensure-codex-minimax-proxy: node not found" >&2; exit 127; }

if [[ "${1:-}" == "--daemon" ]]; then
  exec "$node_bin" "$codex_home/src/providers/minimax.ts"
fi
exec "$node_bin" "$codex_home/src/platform/minimax-ensure.ts"
