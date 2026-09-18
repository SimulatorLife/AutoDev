#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "run-codex-antigravity-proxy: node not found" >&2; exit 127; }
codex_home="${CODEX_HOME:-$HOME/.codex}"
# The proxy is a typed AutoDev runtime module installed under CODEX_HOME. It is
# not a hook script: keeping it as a source-owned module makes it lintable,
# testable, and reusable by the typed CLI/runtime path (mirrors the MiniMax and
# Copilot adapters under src/providers/).
proxy_script="$codex_home/src/providers/antigravity.ts"
if [[ ! -f "$proxy_script" ]]; then
  echo "Antigravity proxy source is missing: $proxy_script" >&2
  echo "Run scripts/install.sh to deploy it." >&2
  exit 1
fi
exec "$node_bin" "$proxy_script"
