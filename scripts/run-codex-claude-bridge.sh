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
exec /usr/bin/python3 "$HOME/.codex/hooks/codex-claude-cli-responses-proxy.py"
