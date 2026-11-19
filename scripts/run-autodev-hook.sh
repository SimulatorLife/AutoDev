#!/bin/sh
set -eu

# Thin OS/process boundary for AutoDev hooks. Hook hosts such as Antigravity,
# Claude Code, Copilot, and Codex often execute hooks under a minimal PATH
# (/usr/bin:/bin) that omits pnpm-managed Node.

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
pnpm_home="${PNPM_HOME:-$HOME/Library/pnpm}"
for candidate in "${AUTODEV_NODE_BIN:-}" "$pnpm_home/bin/node"; do
  if supports_native_ts "$candidate"; then
    node_bin="$candidate"
    break
  fi
done

if [ -z "$node_bin" ]; then
  echo "AutoDev hook launcher: pnpm-managed Node 24+ not found (PNPM_HOME=$pnpm_home)" >&2
  exit 127
fi

exec "$node_bin" "$script_path" "$@"
