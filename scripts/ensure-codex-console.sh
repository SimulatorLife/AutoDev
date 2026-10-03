#!/usr/bin/env bash
# ensure-codex-console.sh — Process-dispatch shim for the Console LaunchAgent.
#
# All readiness, restart, ownership, and fallback policy lives in the typed
# Runtime platform owner (runtime/src/platform/console-ensure.ts); this shell
# layer only resolves a Node binary and exec()s the typed ensure module.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
source_root="${AUTODEV_REPO_ROOT:-$script_dir/..}"
module="${AUTODEV_CONSOLE_ENSURE_MODULE:-$codex_home/src/platform/console-ensure.ts}"
[[ -f "$module" ]] || module="$source_root/runtime/src/platform/console-ensure.ts"

resolve_node() {
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then
    printf '%s\n' "$AUTODEV_NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

node_bin="$(resolve_node)" || { echo "ensure-codex-console: node not found" >&2; exit 127; }
[[ -f "$module" ]] || { echo "ensure-codex-console: console-ensure module not found: $module" >&2; exit 1; }
exec "$node_bin" "$module"
