#!/usr/bin/env bash
set -euo pipefail

set -a
source "$HOME/.codex/.env"
set +a

exec /Users/henrykirk/.local/bin/litellm \
  --config "$HOME/.config/litellm/antigravity.yaml" \
  --host 127.0.0.1 \
  --port 4001
