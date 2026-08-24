#!/usr/bin/env bash
set -euo pipefail

# Load router secrets/config if present (optional under launchd).
if [[ -f "$HOME/.codex/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.codex/.env"
  set +a
fi

# launchd starts us with a minimal PATH that lacks nvm/homebrew node.
# Resolve a real node binary robustly before exec.
resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  # Newest nvm-installed node, then common homebrew locations.
  for candidate in \
    "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [[ -z "${NODE_BIN:-}" ]]; then
  echo "run-codex-model-router: could not locate a node binary" >&2
  exit 127
fi

router="$HOME/.codex/hooks/codex-model-router.mjs"
if [[ -L "$router" ]]; then router="$(readlink "$router")"; fi

exec "$NODE_BIN" "$router"
