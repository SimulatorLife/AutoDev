#!/usr/bin/env bash
set -euo pipefail
if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(/usr/bin/security find-generic-password -a "$USER" -s "com.codex.claude-bridge.oauth-token" -w 2>/dev/null || true)"
  export CLAUDE_CODE_OAUTH_TOKEN
fi
[[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] || { echo "Claude Code bridge requires a Keychain-backed Claude OAuth token." >&2; exit 1; }
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
node_bin="$(resolve_node)" || { echo "run-codex-claude-bridge: node not found" >&2; exit 127; }
codex_home="${CODEX_HOME:-$HOME/.codex}"
bridge_script="$codex_home/src/providers/claude.ts"
[[ -f "$bridge_script" ]] || { echo "Claude bridge source is missing: $bridge_script" >&2; exit 1; }
exec "$node_bin" "$bridge_script"
