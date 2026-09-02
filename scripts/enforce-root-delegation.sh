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
# concrete provider model names. The autodev/orchestrator alias is the root
# itself (it degrades across providers via the model router), so it still
# receives the delegation policy and is matched before the leaf glob.
case "$active_model" in
  autodev/orchestrator)
    ;;
  autodev/*|MiniMax-*|sonnet|opus|haiku|claude-*)
    exit 0
    ;;
esac

# The injected policy is the same orchestrator prompt the provider bridges hand
# a non-Codex root turn, so the root agent gets one delegation policy no matter
# which provider serves it. The installed hook copy keeps the AutoDev `scripts/`
# subtree beneath it; a checkout has the prompts beside this file.
hook_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
prompt_file=""
for candidate in \
  "$hook_dir/scripts/codex/prompts/orchestrator.md" \
  "$hook_dir/codex/prompts/orchestrator.md"; do
  if [[ -f "$candidate" ]]; then
    prompt_file="$candidate"
    break
  fi
done
if [[ -z "$prompt_file" ]]; then
  echo "enforce-root-delegation: orchestrator prompt not found under $hook_dir" >&2
  exit 0
fi

HOOK_PROMPT_FILE="$prompt_file" node -e '
  const fs = require("node:fs");

  process.stdout.write(JSON.stringify({
    systemMessage: "UserPromptSubmit hook fired: injecting root delegation policy",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: fs.readFileSync(process.env.HOOK_PROMPT_FILE, "utf8").trim()
    }
  }));
'
