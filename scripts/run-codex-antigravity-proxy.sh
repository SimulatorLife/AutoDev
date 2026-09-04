#!/usr/bin/env bash
set -euo pipefail

set -a
source "$HOME/.codex/.env"
set +a

exec /usr/bin/env node "$HOME/.codex/hooks/codex-antigravity-cli-responses-proxy.mjs"
