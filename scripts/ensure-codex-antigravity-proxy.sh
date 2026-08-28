#!/usr/bin/env bash
set -euo pipefail

active_model="$(node -e '
  try {
    const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const model = typeof input.model === "string" ? input.model.trim().toLowerCase() : "";
    process.stdout.write(/^gemini-/.test(model) ? "1" : "0");
  } catch { process.stdout.write("0"); }
')"
[[ "$active_model" == "1" ]] || exit 0

settings="$HOME/.gemini/config/config.json"
[[ -f "$settings" ]] || { echo "Antigravity settings missing: $settings" >&2; exit 1; }
settings_ok="$(node -e '
  try {
    const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const userSettings = input.userSettings ?? {};
    process.stdout.write(userSettings.useAiCredits === false && userSettings.useG1Credits === false ? "1" : "0");
  } catch { process.stdout.write("0"); }
' < "$settings")"
[[ "$settings_ok" == "1" ]] || { echo "Antigravity AI Credit Overages must be Never (useAiCredits=false and useG1Credits=false)." >&2; exit 1; }
[[ -x "$HOME/.local/bin/agy" ]] || { echo "Antigravity CLI not installed at $HOME/.local/bin/agy." >&2; exit 1; }

domain="gui/$(id -u)"
proxy_label="com.codex.antigravity-proxy"
litellm_label="com.codex.antigravity-litellm"
proxy_probe="http://127.0.0.1:4002/health/liveliness"
litellm_probe="http://127.0.0.1:4001/health/liveliness"
proxy_plist="$HOME/Library/LaunchAgents/$proxy_label.plist"
litellm_plist="$HOME/Library/LaunchAgents/$litellm_label.plist"
proxy_launcher="$HOME/.codex/hooks/run-codex-antigravity-proxy.sh"
litellm_launcher="$HOME/.codex/hooks/run-codex-antigravity-litellm.sh"
if [[ -L "$proxy_launcher" ]]; then proxy_launcher="$(readlink "$proxy_launcher")"; fi
if [[ -L "$litellm_launcher" ]]; then litellm_launcher="$(readlink "$litellm_launcher")"; fi

wait_for_probe() {
  local probe="$1"
  for _ in {1..50}; do
    curl --silent --fail --max-time 1 "$probe" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

start_service() {
  local label="$1" plist="$2" probe="$3" launcher="$4"

  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    # A loaded launchd service owns this port. Restart it only when its probe
    # is unhealthy; never start a second unmanaged copy beside it.
    if wait_for_probe "$probe"; then return 0; fi
    launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
    wait_for_probe "$probe" && return 0
    echo "Antigravity launchd service $label did not become ready." >&2
    return 1
  fi

  # Prefer to bootstrap a missing service so launchd remains the supervisor.
  # This also handles a partially loaded installation (one provider service
  # present while its paired service is absent).
  if [[ -f "$plist" ]] && launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then
    wait_for_probe "$probe" && return 0
  fi

  # If launchd is unavailable (for example, from a sandboxed invocation), use
  # the direct fallback only when no healthy process already owns the port.
  if wait_for_probe "$probe"; then return 0; fi
  nohup /bin/bash "$launcher" \
    >"${TMPDIR:-/tmp}/codex-antigravity-${label}.log" 2>&1 </dev/null &
  wait_for_probe "$probe"
}

if ! start_service "$proxy_label" "$proxy_plist" "$proxy_probe" "$proxy_launcher" || \
   ! start_service "$litellm_label" "$litellm_plist" "$litellm_probe" "$litellm_launcher"; then
  echo "Antigravity Responses proxy failed to start." >&2
  exit 1
fi
