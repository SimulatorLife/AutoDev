#!/usr/bin/env bash

set -euo pipefail

input="$(cat)"
log_file="${HOME}/.codex/hooks/hooks.log"

active_model="$(
  printf '%s' "$input" |
    HOOK_LOG_FILE="$log_file" node -e '
      const fs = require("node:fs");

      try {
        const input = JSON.parse(fs.readFileSync(0, "utf8"));

        fs.appendFileSync(
          process.env.HOOK_LOG_FILE,
          `${JSON.stringify({
            time: new Date().toISOString(),
            event: input.hook_event_name,
            model: input.model,
            session: input.session_id,
            turn: input.turn_id ?? null
          })}\n`
        );

        process.stdout.write(
          typeof input.model === "string" ? input.model : ""
        );
      } catch {
        process.stdout.write("");
      }
    '
)"

# Every spawned role is a leaf worker. Do not inject root orchestration
# instructions that would encourage a child to create another delegation
# layer. Native roles use the autodev/<role> aliases; external roles use their
# concrete provider model names.
case "$active_model" in
  autodev/*|MiniMax-*|sonnet|opus|haiku|claude-*)
    exit 0
    ;;
esac

cat <<'EOF'
{
  "systemMessage": "UserPromptSubmit hook fired: injecting root delegation policy",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "ROOT DELEGATION REQUIREMENT:\n\nFor this turn, use subagents for all useful non-trivial work. Before doing\nsubstantial investigation or implementation directly, identify independent\nwork that can be delegated and spawn the appropriate configured subagents.\n\nFor a typical non-trivial task:\n- Spawn one or more explorer agents early for investigation and context gathering.\n- Run independent investigations in parallel where useful.\n- Delegate bounded implementation work to workers when scopes are independent.\n- Use a validator for significant changes or conclusions.\n\nAct primarily as the coordinator and integrator. Do not avoid delegation\nmerely because you could perform the work yourself.\n\nSkip subagents only when this turn is genuinely trivial or atomic and there\nis no useful investigation, parallel work, implementation, or validation\nthat can be delegated."
  }
}
EOF
