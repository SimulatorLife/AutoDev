#!/usr/bin/env bash
set -euo pipefail

# Thin OS/process boundary: keep the active workspace cwd and hand MCP
# selection and execution to the typed launcher.
target="${BASH_SOURCE[0]}"
while [[ -L "$target" ]]; do
  target_dir="$(cd -- "$(dirname -- "$target")" && pwd)"
  target="$(readlink "$target")"
  [[ "$target" = /* ]] || target="$target_dir/$target"
done
repo_root="${AUTODEV_REPO_ROOT:-$(cd -- "$(dirname -- "$target")/.." && pwd)}"
node_bin="${AUTODEV_NODE_BIN:-$(command -v node || true)}"
[[ -x "$node_bin" ]] || { echo "AutoDev MCP launcher: node not found" >&2; exit 127; }
# The Runtime lives at <root>/runtime/src in a checkout and at <root>/src once it
# is materialized into CODEX_HOME, so the root alone does not say which layout
# it is. The launcher module has to be looked up in both, the way the router
# hook looks up the server script; pointing only at the checkout layout makes
# the MCP server exit on startup instead of serving its tools.
launcher="$repo_root/runtime/src/mcp/launcher.ts"
[[ -f "$launcher" ]] || launcher="$repo_root/src/mcp/launcher.ts"
[[ -f "$launcher" ]] || { echo "AutoDev MCP launcher: launcher module not found under $repo_root" >&2; exit 127; }
exec env AUTODEV_REPO_ROOT="$repo_root" "$node_bin" "$launcher" "$@"
