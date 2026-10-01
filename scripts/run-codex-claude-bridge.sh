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
  # launchd passes the native Node the installer resolved; PATH order alone
  # can pick an Intel build that Rosetta translates on every cold start.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then printf '%s\n' "$AUTODEV_NODE_BIN"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "run-codex-claude-bridge: node not found" >&2; exit 127; }
codex_home="${CODEX_HOME:-$HOME/.codex}"
bridge_script="$codex_home/src/providers/claude.ts"
[[ -f "$bridge_script" ]] || { echo "Claude bridge source is missing: $bridge_script" >&2; exit 1; }
exec "$node_bin" "$bridge_script"
