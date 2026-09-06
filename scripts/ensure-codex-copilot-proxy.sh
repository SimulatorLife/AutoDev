#!/usr/bin/env bash
set -euo pipefail

# Bring the Copilot Responses proxy up if it is not already serving.
#
# This used to `nohup` a detached copy unconditionally whenever the port was
# quiet, which left a process nothing owned: launchd did not supervise it, so it
# never came back after a crash, and no install ever replaced it -- it ran for
# days on code that had since been overwritten. The proxy is a launchd agent
# now, and this hook adopts that agent rather than starting a rival beside it.
# The direct path below survives only for a sandboxed invocation where launchctl
# is unreachable, and even then only when nothing healthy already owns the port.

host="${CODEX_COPILOT_PROXY_HOST:-127.0.0.1}"
port="${CODEX_COPILOT_PROXY_PORT:-4003}"
probe="http://${host}:${port}/health/liveliness"
domain="gui/$(id -u)"
label="com.codex.copilot-proxy"
plist="$HOME/Library/LaunchAgents/$label.plist"
launcher="$HOME/.codex/hooks/run-codex-copilot-cli-responses-proxy.sh"

probe_ok() { curl --silent --fail --max-time 1 "$probe" >/dev/null 2>&1; }

wait_for_probe() {
  for _ in {1..50}; do
    probe_ok && return 0
    sleep 0.1
  done
  return 1
}

probe_ok && exit 0

# Copilot is an optional fallback: a machine without the CLI is a supported
# configuration, so this reports and returns success rather than failing the
# install.
command -v "${COPILOT_BIN:-copilot}" >/dev/null 2>&1 || {
  echo "GitHub Copilot CLI is unavailable; skipping Copilot fallback." >&2
  exit 0
}

if launchctl print "$domain/$label" >/dev/null 2>&1; then
  # A loaded launchd service owns this port; restart it rather than starting a
  # second unmanaged copy beside it.
  launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
  wait_for_probe && exit 0
elif [[ -f "$plist" ]] && launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then
  launchctl enable "$domain/$label" >/dev/null 2>&1 || true
  wait_for_probe && exit 0
fi

if ! probe_ok; then
  nohup /bin/bash "$launcher" >"${TMPDIR:-/tmp}/codex-copilot-proxy.log" 2>&1 </dev/null &
  wait_for_probe && exit 0
fi

echo "Copilot proxy did not become ready; router will skip this fallback." >&2
exit 0
