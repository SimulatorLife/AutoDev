#!/usr/bin/env bash
# Ensure the persistent MiniMax Responses compatibility proxy is available.
# This script is safe to call repeatedly from Codex lifecycle hooks.

set -euo pipefail

hook_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# launchd and other background hooks do not inherit interactive-shell
# credentials. Load the local credential file without printing its contents.
if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi

daemon_mode=0
if [[ "${1:-}" == "--daemon" ]]; then
  daemon_mode=1
fi

# Codex command hooks receive the active session/subagent model via stdin.
# Do nothing unless this invocation is using the MiniMax model.
minimax_model="${CODEX_MINIMAX_MODEL:-MiniMax-M3}"

active_model="$(
  node -e '
    const fs = require("node:fs");

    try {
      const input = JSON.parse(fs.readFileSync(0, "utf8"));
      const model = typeof input.model === "string" ? input.model : "";
      process.stdout.write(model);
    } catch {
      process.stdout.write("");
    }
  '
)"

if [[ "$daemon_mode" != 1 && "$active_model" != "$minimax_model" ]]; then
  exit 0
fi

proxy_host="${CODEX_MINIMAX_PROXY_HOST:-127.0.0.1}"
proxy_port="${CODEX_MINIMAX_PROXY_PORT:-18765}"
proxy_url="http://${proxy_host}:${proxy_port}"
proxy_log="${CODEX_MINIMAX_PROXY_LOG:-${TMPDIR:-/tmp}/codex-minimax-proxy-${proxy_port}.log}"
proxy_pid_file="${CODEX_MINIMAX_PROXY_PID_FILE:-${TMPDIR:-/tmp}/codex-minimax-proxy-${proxy_port}.pid}"
upstream_base_url="${CODEX_MINIMAX_UPSTREAM_URL:-https://api.minimax.io}"

proxy_is_ready() {
  curl --silent --fail --max-time 1 "${proxy_url}/health" >/dev/null 2>&1
}

if proxy_is_ready; then
  exit 0
fi

if [[ "$daemon_mode" != 1 ]]; then
  launch_domain="gui/$(id -u)"
  launch_label="com.codex.minimax-proxy"
  # The repository lives under Desktop, where launchd can be denied access by
  # macOS privacy controls. Start the canonical versioned script directly from
  # the Codex lifecycle process instead.
  launchctl bootout "$launch_domain/$launch_label" >/dev/null 2>&1 || true
  direct_launcher="$HOME/.codex/hooks/ensure-codex-minimax-proxy.sh"
  if [[ -L "$direct_launcher" ]]; then direct_launcher="$(readlink "$direct_launcher")"; fi
  /bin/bash "$direct_launcher" --daemon
  for _ in {1..50}; do
    if proxy_is_ready; then
      exit 0
    fi
    sleep 0.1
  done

  echo "MiniMax compatibility proxy failed to start." >&2
  echo "Proxy log: $proxy_log" >&2
  cat "$proxy_log" >&2 2>/dev/null || true
  exit 1
fi

mkdir -p "$(dirname -- "$proxy_log")" "$(dirname -- "$proxy_pid_file")"

# The proxy itself is a tracked AutoDev source next to this hook (the installer
# copies both into the hooks directory), not an inline heredoc: keeping it a
# real file is what makes it lintable, testable, and visibly owned here.
proxy_script="$hook_dir/codex-minimax-responses-proxy.mjs"
if [[ ! -f "$proxy_script" ]]; then
  echo "MiniMax proxy source is missing: $proxy_script" >&2
  echo "Run scripts/codex/install-codex-integration.sh to deploy it." >&2
  exit 1
fi

MINIMAX_PROXY_HOST="$proxy_host" \
MINIMAX_PROXY_PORT="$proxy_port" \
MINIMAX_PROXY_UPSTREAM_BASE_URL="$upstream_base_url" \
nohup node "$proxy_script" \
  >"$proxy_log" 2>&1 \
  </dev/null &
proxy_pid=$!
printf '%s\n' "$proxy_pid" >"$proxy_pid_file"

if [[ "$daemon_mode" == 1 ]]; then
  wait "$proxy_pid"
  exit $?
fi

for _ in {1..50}; do
  if proxy_is_ready; then
    exit 0
  fi
  sleep 0.1
done

echo "MiniMax compatibility proxy failed to start." >&2
echo "Proxy log: $proxy_log" >&2
cat "$proxy_log" >&2 2>/dev/null || true
exit 1
