#!/usr/bin/env bash
set -euo pipefail

# Thin OS/process boundary: keep the active workspace cwd and hand MCP
# selection to the gateway client.
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
# is materialized into CODEX_HOME. Every client reaches AutoDev's workspace MCP
# servers through the shared gateway: this starts the gateway client, which
# admits the launch directory as the workspace and relays to the role's gateway
# surface, so those backends only ever run inside the gateway.
#
# The playtest server is not a workspace server: it serves exactly one
# Playtesting run, whose trusted context (run, task, actor, analysis) the
# Runtime hands this process in its environment, under the run's own isolated
# CODEX_HOME. It runs here, bound to that run, and is never a gateway surface.
entrypoint="mcp/gateway-client.ts"
[[ "${1:-}" == "playtest" ]] && entrypoint="mcp/launcher.ts"
client="$repo_root/runtime/src/$entrypoint"
[[ -f "$client" ]] || client="$repo_root/src/$entrypoint"
[[ -f "$client" ]] || { echo "AutoDev MCP launcher: $entrypoint not found under $repo_root" >&2; exit 127; }
exec "$node_bin" "$client" "$@"
