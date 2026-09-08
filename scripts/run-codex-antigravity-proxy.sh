#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi

exec /usr/bin/env node "$HOME/.codex/hooks/codex-antigravity-cli-responses-proxy.mjs"
