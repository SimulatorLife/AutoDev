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
exec env AUTODEV_REPO_ROOT="$repo_root" "$node_bin" "$repo_root/src/mcp/launcher.ts" "$@"
