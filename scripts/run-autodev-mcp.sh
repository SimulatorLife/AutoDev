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
# The root is where this launcher lives, never a caller-supplied value: the
# installed copy under <home>/hooks runs the installed Runtime and its
# protected dependency closure, and no inherited AUTODEV_REPO_ROOT can point it
# at an editable checkout.
repo_root="$(cd -- "$(dirname -- "$target")/.." && pwd)"
node_bin=""
if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then
  node_bin="$AUTODEV_NODE_BIN"
else
  node_bin="$(command -v node || true)"
fi
if [[ -z "$node_bin" ]]; then
  pnpm_home="${PNPM_HOME:-}"
  if [[ -z "$pnpm_home" ]]; then
    case "$(uname -s)" in
      Darwin) pnpm_home="$HOME/Library/pnpm" ;;
      *) pnpm_home="$HOME/.local/share/pnpm" ;;
    esac
  fi
  [[ -x "$pnpm_home/bin/node" ]] && node_bin="$pnpm_home/bin/node"
fi
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
