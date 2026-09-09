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
  autodev/*|MiniMax-*|sonnet|opus|haiku|claude-*|gemini-*|copilot*)
    exit 0
    ;;
esac

# The injected policy is the same orchestrator prompt the provider bridges hand
# a non-Codex root turn, so the root agent gets one delegation policy no matter
# which provider serves it. The injected prompt also owns the terminal-child
# close/recovery protocol; this hook must not attempt a global cleanup because
# it cannot distinguish another parent tree's handles. The prompt conditionally
# uses owner-scoped enumeration when a runtime provides it. One relative path covers
# both layouts: this hook
# sits beside `codex/prompts/` in a checkout (`scripts/`) and again in the
# installed copy (`$CODEX_HOME/hooks/`).
hook_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
prompt_file="$hook_dir/codex/prompts/orchestrator.md"
skill_file="$hook_dir/codex/skills/orchestration/SKILL.md"
if [[ ! -f "$prompt_file" ]]; then
  echo "enforce-root-delegation: orchestrator prompt not found at $prompt_file" >&2
  exit 0
fi

printf '%s' "$input" | HOOK_PROMPT_FILE="$prompt_file" HOOK_SKILL_FILE="$skill_file" HOOK_ROOT_DIR="$hook_dir" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");

  (async () => {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { }
    const parentId = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id.trim() : null;
    let recovery = "";
    if (parentId) {
      try {
        const module = await import(pathToFileURL(path.join(process.env.HOOK_ROOT_DIR, "codex/lib/codex-spawn-tools.mjs")).href);
        recovery = module.buildRecoveryScript(parentId);
      } catch { }
    }
    const prompt = fs.readFileSync(process.env.HOOK_PROMPT_FILE, "utf8").trim();
    const skill = fs.existsSync(process.env.HOOK_SKILL_FILE)
      ? "\n\n## Canonical orchestration skill\n\n" + fs.readFileSync(process.env.HOOK_SKILL_FILE, "utf8").trim()
      : "\n\nCanonical orchestration skill is unavailable; report that capability failure instead of silently substituting a workflow.";
    const recoveryContext = recovery
      ? "\n\n## Current-parent recovery preflight\nExecute this preflight before retrying a thread-limit/admission failure. It reads only the current parent task spawn history, waits for each child, and closes terminal handles; it never closes foreign or running children.\n\n```js\n" + recovery + "```"
      : "\n\nCurrent-parent recovery preflight is unavailable because the hook did not receive a parent session id or could not load the recovery helper. Do not infer child ids from global task listings.";
    process.stdout.write(JSON.stringify({
      systemMessage: "UserPromptSubmit hook fired: injecting root delegation policy",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: prompt + skill + recoveryContext
      }
    }));
  })();
'
