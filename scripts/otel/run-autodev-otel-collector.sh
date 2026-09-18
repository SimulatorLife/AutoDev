#!/usr/bin/env bash
# Process-dispatch shim. Collector validation and foreground lifecycle live in
# the typed platform owner.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
source_root="$script_dir/../../"
module="${AUTODEV_OTEL_MODULE:-$codex_home/src/platform/otel-collector.ts}"
[[ -f "$module" ]] || module="$source_root/src/platform/otel-collector.ts"

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "run-autodev-otel-collector: node not found" >&2; exit 127; }
exec "$node_bin" "$module" run "$@"
