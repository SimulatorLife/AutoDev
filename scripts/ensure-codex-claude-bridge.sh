#!/usr/bin/env bash
set -euo pipefail

is_claude_model="$(node -e '
  try {
    const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const model = typeof input.model === "string" ? input.model.trim().toLowerCase() : "";
    process.stdout.write(/^(sonnet|opus|haiku|claude-[a-z0-9][a-z0-9.-]*)$/.test(model) ? "1" : "0");
  } catch { process.stdout.write("0"); }
')"
[[ "$is_claude_model" == "1" ]] || exit 0

if [[ -f "${CODEX_ENV_FILE:-$HOME/.codex/.env}" ]]; then
  set -a
  source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"
  set +a
fi

claude_oauth_token="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [[ -z "$claude_oauth_token" ]]; then
  claude_oauth_token="$(/usr/bin/security find-generic-password -a "$USER" -s "com.codex.claude-bridge.oauth-token" -w 2>/dev/null || true)"
fi

if curl --silent --fail --max-time 1 http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1; then
  exit 0
fi
[[ -n "$claude_oauth_token" ]] || { echo "Claude Code bridge requires a Keychain-backed Claude OAuth token." >&2; exit 1; }

domain="gui/$(id -u)"
label="com.codex.claude-bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"
launcher="$HOME/.codex/hooks/run-codex-claude-bridge.sh"
run_dir="${CODEX_HOME:-$HOME/.codex}/run"
mkdir -p "$run_dir"
chmod 0700 "$run_dir"
log="$run_dir/codex-claude-bridge.fallback.log"

if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
elif [[ -f "$plist" ]] && launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then
  launchctl enable "$domain/$label" >/dev/null 2>&1 || true
fi
for _ in {1..50}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1; then exit 0; fi
  sleep 0.1
done
# launchctl may be unavailable inside a sandbox. Only then use a private,
# explicitly logged fallback process; never boot out a healthy supervisor.
if ! launchctl print "$domain/$label" >/dev/null 2>&1 && [[ ! -f "$plist" ]]; then
  nohup /bin/bash "$launcher" >"$log" 2>&1 </dev/null &
  for _ in {1..50}; do
    curl --silent --fail --max-time 1 http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1 && exit 0
    sleep 0.1
  done
fi
echo "Claude Code bridge failed to start." >&2
exit 1
