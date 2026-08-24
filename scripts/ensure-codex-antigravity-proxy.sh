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

if curl --silent --fail --max-time 1 http://127.0.0.1:4001/health/liveliness >/dev/null 2>&1 && \
   curl --silent --fail --max-time 1 http://127.0.0.1:4002/health/liveliness >/dev/null 2>&1; then
  exit 0
fi

domain="gui/$(id -u)"
# The repository lives under Desktop, where launchd can be denied access by
# macOS privacy controls. Start both canonical versioned launchers directly
# from the Codex lifecycle process instead.
for label in com.codex.antigravity-proxy com.codex.antigravity-litellm; do
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
done
proxy_launcher="$HOME/.codex/hooks/run-codex-antigravity-proxy.sh"
litellm_launcher="$HOME/.codex/hooks/run-codex-antigravity-litellm.sh"
if [[ -L "$proxy_launcher" ]]; then proxy_launcher="$(readlink "$proxy_launcher")"; fi
if [[ -L "$litellm_launcher" ]]; then litellm_launcher="$(readlink "$litellm_launcher")"; fi
nohup /bin/bash "$proxy_launcher" \
  >"${TMPDIR:-/tmp}/codex-antigravity-proxy-4002.log" 2>&1 </dev/null &
nohup /bin/bash "$litellm_launcher" \
  >"${TMPDIR:-/tmp}/codex-antigravity-litellm-4001.log" 2>&1 </dev/null &
for _ in {1..50}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:4001/health/liveliness >/dev/null 2>&1 && \
     curl --silent --fail --max-time 1 http://127.0.0.1:4002/health/liveliness >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.1
done

echo "Antigravity Responses proxy failed to start." >&2
exit 1
