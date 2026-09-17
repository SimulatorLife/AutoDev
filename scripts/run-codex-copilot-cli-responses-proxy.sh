#!/usr/bin/env bash
set -euo pipefail
hook_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$(dirname -- "$hook_dir")}"
resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node_bin="$(resolve_node)" || { echo "run-codex-copilot-proxy: node not found" >&2; exit 127; }
# The proxy is a typed AutoDev runtime module installed under CODEX_HOME. It is
# not an inline heredoc: keeping it as a source-owned module makes it lintable,
# testable, and reusable by the typed CLI/runtime path (mirrors the MiniMax
# adapter at src/providers/minimax.ts).
proxy_script="$codex_home/src/providers/copilot.ts"
if [[ ! -f "$proxy_script" ]]; then
  echo "Copilot proxy source is missing: $proxy_script" >&2
  echo "Run scripts/codex/install-codex-integration.sh to deploy it." >&2
  exit 1
fi
exec env COPILOT_PROXY_HOST="${CODEX_COPILOT_PROXY_HOST:-127.0.0.1}" COPILOT_PROXY_PORT="${CODEX_COPILOT_PROXY_PORT:-4003}" \
  "$node_bin" "$proxy_script"
