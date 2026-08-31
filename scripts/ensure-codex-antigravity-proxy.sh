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

# LiteLLM only reads antigravity.yaml at process start, so a healthy process
# can keep serving a stale deployed config after the file changes underneath
# it. Fingerprint the resolved config content so drift is detected even
# though the liveliness probe stays green, and track the local nohup PID so a
# direct-fallback restart only ever recycles a process this script started.
litellm_config="$HOME/.config/litellm/antigravity.yaml"
litellm_config_stamp="${CODEX_ANTIGRAVITY_LITELLM_CONFIG_STAMP:-$HOME/.codex/codex-antigravity-litellm-config.sha256}"
litellm_pid_file="${TMPDIR:-/tmp}/codex-antigravity-${litellm_label}.pid"

probe_ok() {
  curl --silent --fail --max-time 1 "$1" >/dev/null 2>&1
}

launchd_pid() {
  local label="$1"
  launchctl print "$domain/$label" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }'
}

wait_for_probe() {
  local probe="$1"
  for _ in {1..50}; do
    probe_ok "$probe" && return 0
    sleep 0.1
  done
  return 1
}

config_fingerprint() {
  local path="$litellm_config"
  if [[ -L "$path" ]]; then path="$(readlink "$path")"; fi
  [[ -f "$path" ]] || return 1
  shasum -a 256 "$path" | awk '{print $1}'
}

record_litellm_config_stamp() {
  local fingerprint
  fingerprint="$(config_fingerprint)" || return 0
  mkdir -p "$(dirname -- "$litellm_config_stamp")"
  printf '%s\n' "$fingerprint" >"$litellm_config_stamp"
}

# Stale means: the config is fingerprintable, a prior stamp exists, and the
# two differ. A missing config or a first-ever observation is "not stale" so
# first run and an unreadable config never force an unnecessary restart.
litellm_config_is_stale() {
  local current
  current="$(config_fingerprint)" || return 1
  [[ -s "$litellm_config_stamp" ]] || return 1
  local previous
  previous="$(<"$litellm_config_stamp")"
  [[ "$current" != "$previous" ]]
}

restart_direct_litellm_if_owned() {
  # Only recycle a process this script itself started with nohup; an
  # unmanaged process that happens to already own the port is left alone.
  local pid=""
  [[ -f "$litellm_pid_file" ]] && pid="$(<"$litellm_pid_file")"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f -- "$litellm_pid_file"
    echo "Antigravity LiteLLM config changed, but no locally supervised process is tracked to restart; leaving the current process running." >&2
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f -- "$litellm_pid_file"

  nohup /bin/bash "$litellm_launcher" \
    >"${TMPDIR:-/tmp}/codex-antigravity-${litellm_label}.log" 2>&1 </dev/null &
  printf '%s' "$!" >"$litellm_pid_file"
  wait_for_probe "$litellm_probe"
}

# Detect and repair a healthy-but-stale LiteLLM process before the generic
# start_service healthy-skip path below would otherwise leave it running.
sync_litellm_config_drift() {
  probe_ok "$litellm_probe" || return 0
  litellm_config_is_stale || return 0

  echo "Antigravity LiteLLM config changed since the running process started; restarting $litellm_label to pick it up." >&2
  if launchctl print "$domain/$litellm_label" >/dev/null 2>&1; then
    local previous_pid current_pid
    previous_pid="$(launchd_pid "$litellm_label")"
    launchctl kickstart -k "$domain/$litellm_label" >/dev/null 2>&1 || return 1
    for _ in {1..50}; do
      current_pid="$(launchd_pid "$litellm_label")"
      if probe_ok "$litellm_probe" && [[ -n "$current_pid" && "$current_pid" != "$previous_pid" ]]; then return 0; fi
      sleep 0.1
    done
    echo "Antigravity launchd service $litellm_label did not become ready after a config-drift restart." >&2
    return 1
  fi

  restart_direct_litellm_if_owned
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
  if [[ "$label" == "$litellm_label" ]]; then
    printf '%s' "$!" >"$litellm_pid_file"
  fi
  wait_for_probe "$probe"
}

if ! sync_litellm_config_drift; then
  echo "Antigravity Responses proxy failed to start." >&2
  exit 1
fi

if ! start_service "$proxy_label" "$proxy_plist" "$proxy_probe" "$proxy_launcher" || \
   ! start_service "$litellm_label" "$litellm_plist" "$litellm_probe" "$litellm_launcher"; then
  echo "Antigravity Responses proxy failed to start." >&2
  exit 1
fi

record_litellm_config_stamp
