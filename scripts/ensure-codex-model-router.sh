#!/usr/bin/env bash
# Process-dispatch shim. Router ensure policy lives in the typed platform owner.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
source_root="${AUTODEV_REPO_ROOT:-$script_dir/..}"
module="${AUTODEV_ROUTER_ENSURE_MODULE:-$codex_home/src/platform/router-ensure.ts}"
[[ -f "$module" ]] || module="$source_root/src/platform/router-ensure.ts"

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "ensure-codex-model-router: node not found" >&2; exit 127; }
exec "$node_bin" "$module"
