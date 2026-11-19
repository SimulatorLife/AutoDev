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
  # LaunchAgents carry the installer's selected binary; direct starts use pnpm's Node shim.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then
    printf '%s\n' "$AUTODEV_NODE_BIN"
    return 0
  fi
  local pnpm_home="${PNPM_HOME:-$HOME/Library/pnpm}"
  if [[ -x "$pnpm_home/bin/node" ]]; then
    printf '%s\n' "$pnpm_home/bin/node"
    return 0
  fi
  return 1
}
node_bin="$(resolve_node)" || { echo "ensure-codex-minimax-proxy: node not found" >&2; exit 127; }

if [[ "${1:-}" == "--daemon" ]]; then
  exec "$node_bin" "$codex_home/src/providers/minimax.ts"
fi
exec "$node_bin" "$codex_home/src/platform/minimax-ensure.ts"
