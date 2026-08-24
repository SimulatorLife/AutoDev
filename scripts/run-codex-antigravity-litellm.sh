#!/usr/bin/env bash
set -euo pipefail

set -a
source "$HOME/.codex/.env"
set +a

config="$HOME/.config/litellm/antigravity.yaml"
if [[ -L "$config" ]]; then config="$(readlink "$config")"; fi
exec /Users/henrykirk/.local/bin/litellm \
  --config "$config" \
  --host 127.0.0.1 \
  --port 4001
