#!/usr/bin/env bash
set -euo pipefail

set -a
source "$HOME/.codex/.env"
set +a

proxy="$HOME/.codex/hooks/codex-antigravity-cli-responses-proxy.mjs"
if [[ -L "$proxy" ]]; then proxy="$(readlink "$proxy")"; fi
exec /usr/bin/env node "$proxy"
