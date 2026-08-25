#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec env COPILOT_PROXY_HOST="${CODEX_COPILOT_PROXY_HOST:-127.0.0.1}" COPILOT_PROXY_PORT="${CODEX_COPILOT_PROXY_PORT:-4003}" \
  node "$repo_root/scripts/codex-copilot-cli-responses-proxy.mjs"
