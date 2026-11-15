#!/bin/sh
set -eu

# Thin OS/process boundary for AutoDev hooks. Hook hosts such as Antigravity,
# Claude Code, Copilot, and Codex often execute hooks under a minimal PATH
# (/usr/bin:/bin) that omits Homebrew, nvm, volta, or fnm Node installations.

if [ "$#" -lt 1 ]; then
  echo "AutoDev hook launcher: expected hook script path" >&2
  exit 64
fi

script_path="$1"
shift

codex_home="${CODEX_HOME:-$HOME/.codex}"
case "$script_path" in
  \~/.codex/*)
    script_path="$codex_home/${script_path#\~/.codex/}"
    ;;
  \~/*)
    script_path="$HOME/${script_path#\~/}"
    ;;
esac

supports_native_ts() {
  [ -n "$1" ] &&
    [ -x "$1" ] &&
    "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null
}

node_bin=""
if [ -n "${AUTODEV_NODE_BIN:-}" ] && [ -x "${AUTODEV_NODE_BIN}" ]; then
  node_bin="$AUTODEV_NODE_BIN"
fi

if [ -z "$node_bin" ]; then
  path_node="$(command -v node 2>/dev/null || true)"
  for candidate in \
    "$path_node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node"/v2[4-9].*/bin/node \
    "$HOME/.nvm/versions/node"/v[3-9][0-9].*/bin/node \
    "$HOME/.fnm/node-versions"/*/installation/bin/node \
    "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node; do
    if supports_native_ts "$candidate"; then
      node_bin="$candidate"
      break
    fi
  done
fi

if [ -z "$node_bin" ]; then
  path_node="$(command -v node 2>/dev/null || true)"
  for candidate in \
    "$path_node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      node_bin="$candidate"
      break
    fi
  done
fi

if [ -z "$node_bin" ]; then
  echo "AutoDev hook launcher: node binary not found (PATH=$PATH)" >&2
  exit 127
fi

exec "$node_bin" "$script_path" "$@"
