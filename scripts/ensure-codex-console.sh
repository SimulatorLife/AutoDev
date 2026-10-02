#!/usr/bin/env bash
# ensure-codex-console.sh — Process-dispatch shim for the Console LaunchAgent.
#
# All readiness, restart, ownership, and fallback policy lives in the typed
# Runtime platform owner; this shell layer only resolves a node binary and
# exec()s the long-lived next start entrypoint. KeepAlive on the
# LaunchAgent already supervises the server itself, so we deliberately
# stay in the foreground (no extra ensure process in the supervision
# chain). launchd passes AUTODEV_NODE_BIN, CODEX_HOME, HOME,
# AUTODEV_REPO_ROOT, and AUTODEV_CONSOLE_PORT; the launcher inherits them.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
repo_root="${AUTODEV_REPO_ROOT:-$script_dir/..}"

resolve_node() {
  # launchd passes the native Node the installer resolved; PATH order alone
  # can pick an Intel build that Rosetta translates on every cold start.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then
    printf '%s\n' "$AUTODEV_NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
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

node_bin="$(resolve_node)" || {
  echo "ensure-codex-console: node not found" >&2
  exit 127
}

launcher="$codex_home/hooks/run-codex-console.sh"
if [[ ! -f "$launcher" ]]; then
  launcher="$repo_root/scripts/run-codex-console.sh"
fi
if [[ ! -f "$launcher" ]]; then
  echo "ensure-codex-console: launcher missing (looked in $codex_home/hooks and $repo_root/scripts)" >&2
  exit 1
fi

exec "$node_bin" "$launcher"
