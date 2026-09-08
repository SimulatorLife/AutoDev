#!/usr/bin/env bash
set -euo pipefail

# Run AutoDev-owned MCP binaries from the AutoDev dependency tree while
# preserving the active workspace as the MCP process cwd. This prevents a
# target repository from needing to duplicate AutoDev's pinned MCP packages.
source_path="${BASH_SOURCE[0]}"
if [[ -L "$source_path" ]]; then
  source_path="$(readlink "$source_path")"
fi
repo_root="$(cd -- "$(dirname -- "$source_path")/../.." && pwd)"
tool="${1:-}"
case "$tool" in
  lsp) binary="$repo_root/node_modules/.bin/lsp-mcp-server" ;;
  playwright) binary="$repo_root/node_modules/.bin/playwright-mcp" ;;
  *) echo "unsupported AutoDev MCP: ${tool:-<missing>}" >&2; exit 2 ;;
esac
[[ -x "$binary" ]] || { echo "AutoDev MCP binary is missing: $binary" >&2; exit 1; }
exec "$binary"
