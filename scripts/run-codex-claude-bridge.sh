#!/usr/bin/env bash
set -euo pipefail
set -a
source "$HOME/.codex/.env"
set +a
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(/usr/bin/security find-generic-password -a "$USER" -s "com.codex.claude-bridge.oauth-token" -w 2>/dev/null || true)"
fi
[[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] || { echo "Claude Code bridge requires a Keychain-backed Claude OAuth token." >&2; exit 1; }
exec /usr/bin/python3 "$HOME/.codex/hooks/codex-claude-cli-responses-proxy.py"
