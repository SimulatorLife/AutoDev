#!/usr/bin/env bash
# Process-dispatch shim. Root delegation policy lives in the typed hook owner.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
source_root="${AUTODEV_REPO_ROOT:-$script_dir/..}"
module="${AUTODEV_ROOT_DELEGATION_MODULE:-$codex_home/src/hooks/root-delegation.ts}"
[[ -f "$module" ]] || module="$source_root/src/hooks/root-delegation.ts"

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "enforce-root-delegation: node not found" >&2; exit 127; }
exec "$node_bin" "$module"
