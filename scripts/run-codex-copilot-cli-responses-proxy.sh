#!/usr/bin/env bash
set -euo pipefail
hook_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$(dirname -- "$hook_dir")}"
if [[ -z "${CODEX_ROUTER_COPILOT_API_KEY:-}" && -f "$codex_home/.env" ]]; then
  CODEX_ROUTER_COPILOT_API_KEY="$(awk -F= '$1 == "CODEX_ROUTER_COPILOT_API_KEY" { value = substr($0, index($0, "=") + 1) } END { print value }' "$codex_home/.env")"
  if [[ -n "$CODEX_ROUTER_COPILOT_API_KEY" ]]; then
    export CODEX_ROUTER_COPILOT_API_KEY
  fi
fi
if [[ -z "${CODEX_ROUTER_COPILOT_API_KEY:-}" ]]; then
  echo "Copilot bridge auth key is missing from $codex_home/.env; rerun the AutoDev installer." >&2
  exit 78
fi
resolve_node() {
  # LaunchAgents carry the installer's selected binary; direct starts use pnpm's Node shim.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then
    printf '%s\n' "$AUTODEV_NODE_BIN"
    return 0
  fi
  local pnpm_home="${PNPM_HOME:-$HOME/Library/pnpm}"
  if [[ -x "$pnpm_home/bin/node" ]]; then
    printf '%s\n' "$pnpm_home/bin/node"
    return 0
  fi
  return 1
}
node_bin="$(resolve_node)" || { echo "run-codex-copilot-proxy: node not found" >&2; exit 127; }
# The proxy is a typed AutoDev runtime module installed under CODEX_HOME. It is
# not an inline heredoc: keeping it as a source-owned module makes it lintable,
# testable, and reusable by the typed CLI/runtime path (mirrors the MiniMax
# adapter at runtime/src/providers/minimax.ts).
proxy_script="$codex_home/src/providers/copilot.ts"
if [[ ! -f "$proxy_script" ]]; then
  echo "Copilot proxy source is missing: $proxy_script" >&2
  echo "Run scripts/install.sh to deploy it." >&2
  exit 1
fi
exec env COPILOT_PROXY_HOST="${CODEX_COPILOT_PROXY_HOST:-127.0.0.1}" COPILOT_PROXY_PORT="${CODEX_COPILOT_PROXY_PORT:-4003}" \
  "$node_bin" "$proxy_script"
