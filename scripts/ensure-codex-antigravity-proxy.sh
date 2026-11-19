#!/usr/bin/env bash
set -euo pipefail

# Thin process-dispatch shim. Antigravity lifecycle, model/settings validation,
# launchd ownership, readiness, and fallback decisions live in the typed
# platform module.
home="${HOME:-$USERPROFILE}"
codex_home="${CODEX_HOME:-$home/.codex}"
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
node_bin="$(resolve_node)" || { echo "ensure-codex-antigravity-proxy: node not found" >&2; exit 127; }
exec "$node_bin" "$codex_home/src/platform/antigravity-ensure.ts"
