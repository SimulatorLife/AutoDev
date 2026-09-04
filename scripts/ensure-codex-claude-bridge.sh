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

set -a
source "$HOME/.codex/.env"
set +a

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
# The repository lives under Desktop, where launchd can be denied access by
# macOS privacy controls. Start the canonical versioned launcher directly from
# the Codex lifecycle process instead.
launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
direct_launcher="$HOME/.codex/hooks/run-codex-claude-bridge.sh"
nohup /bin/bash "$direct_launcher" \
  >"${TMPDIR:-/tmp}/codex-claude-bridge.log" 2>&1 </dev/null &
for _ in {1..50}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1; then exit 0; fi
  sleep 0.1
done
echo "Claude Code bridge failed to start." >&2
exit 1
