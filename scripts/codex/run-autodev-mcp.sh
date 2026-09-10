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
# lsp-mcp-server launches the configured language server by executable name.
# Keep that child lookup inside AutoDev's pinned dependency tree instead of
# relying on the parent process's PATH (Antigravity and launchd often provide a
# minimal PATH).
export PATH="$repo_root/node_modules/.bin:${HOME:-.}/.local/bin:${PATH:-}"
tool="${1:-}"
case "$tool" in
  lsp)
    binary="$repo_root/node_modules/.bin/lsp-mcp-server"
    args=()
    ;;
  playwright)
    binary="$repo_root/node_modules/.bin/playwright-mcp"
    args=()
    ;;
  cocoindex-code)
    # Agent shells are intentionally forbidden from invoking the ccc CLI.
    # Resolve the backend here, outside the model shell permission boundary.
    binary="${AUTODEV_COCOINDEX_BIN:-${HOME:-}/.local/bin/ccc}"
    if [[ ! -x "$binary" ]]; then binary="$(command -v ccc || true)"; fi
    args=(mcp)
    ;;
  *) echo "unsupported AutoDev MCP: ${tool:-<missing>}" >&2; exit 2 ;;
esac
[[ -x "$binary" ]] || { echo "AutoDev MCP binary is missing: $binary" >&2; exit 1; }
exec "$binary" "${args[@]}"
