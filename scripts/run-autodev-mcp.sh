#!/usr/bin/env bash
set -euo pipefail

# Thin OS/process boundary: keep the active workspace cwd and hand MCP
# selection and execution to the typed launcher.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${AUTODEV_NODE_BIN:-$(command -v node || true)}"
[[ -x "$node_bin" ]] || { echo "AutoDev MCP launcher: node not found" >&2; exit 127; }
exec "$node_bin" "$repo_root/src/mcp/launcher.ts" "$@"
