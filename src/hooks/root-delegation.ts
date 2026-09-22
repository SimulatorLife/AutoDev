#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeErrorLine } from "../shared/output.ts";
import { codexHome, repositoryRoot } from "./command-utils.ts";

type HookInput = {
  model?: unknown;
  session_id?: unknown;
  hook_event_name?: unknown;
  turn_id?: unknown;
};
type SpawnTools = { buildRecoveryScript(parentId: string): string };

const NON_ROOT_MODEL =
  /^(autodev\/|MiniMax-|sonnet$|opus$|haiku$|claude-|gemini-|copilot)/;

function parseInput(raw: string): HookInput {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object"
      ? (value as HookInput)
      : {};
  } catch {
    return {};
  }
}

function runtimeSourceRoot(): string {
  const installed = codexHome();
  return existsSync(path.join(installed, "src", "agents", "spawn-tools.ts"))
    ? installed
    : repositoryRoot();
}

function logInput(input: HookInput): void {
  try {
    const logFile = path.join(codexHome(), "hooks", "hooks.log");
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({
        time: new Date().toISOString(),
        event: input.hook_event_name,
        model: input.model,
        session: input.session_id,
        turn: input.turn_id ?? null
      })}\n`
    );
  } catch {
    // Hook logging is best effort; policy evaluation remains fail-closed below.
  }
}

async function recoveryScript(parentId: string): Promise<string> {
  try {
    const modulePath = path.join(
      runtimeSourceRoot(),
      "src",
      "agents",
      "spawn-tools.ts"
    );
    const tools = (await import(
      pathToFileURL(modulePath).href
    )) as unknown as SpawnTools;
    return tools.buildRecoveryScript(parentId);
  } catch {
    return "";
  }
}

export async function runRootDelegation(
  raw = readFileSync(0, "utf8")
): Promise<number> {
  const input = parseInput(raw);
  logInput(input);
  const model = typeof input.model === "string" ? input.model : "";
  if (model !== "autodev/orchestrator" && NON_ROOT_MODEL.test(model)) return 0;

  const root = runtimeSourceRoot();
  const promptFile = path.join(root, "agents", "prompts", "orchestrator.md");
  const skillFile = path.join(
    root,
    ".rulesync",
    "skills",
    "orchestration",
    "SKILL.md"
  );
  const codeSearchFile = path.join(root, "agents", "prompts", "code-search.md");
  if (!existsSync(promptFile)) {
    writeErrorLine(
      `root-delegation: orchestrator prompt not found at ${promptFile}`
    );
    return 0;
  }

  const parentId =
    typeof input.session_id === "string" && input.session_id.trim()
      ? input.session_id.trim()
      : null;
  const recovery = parentId ? await recoveryScript(parentId) : "";
/**
 * Format the parent-side recovery preflight in a form that is unambiguous
 * regardless of whether the orchestrator turn runs in Codex code mode (one
 * `exec` tool that takes raw JavaScript) or native function-call mode (named
 * tools the model invokes directly). A previous version injected only a
 * JavaScript snippet (`buildRecoveryScript` is a code-mode script); the model
 * could not find a native function named `multi_agent_v1__spawn_agent` in its
 * declared tool list and concluded the orchestration surface was unavailable.
 * The natural-language summary below is runtime-agnostic; the optional JS
 * block, when present, is labelled as code-mode-only.
 */
function buildRecoveryContext(recovery: string): string {
  const header =
    "\n\n## Current-parent recovery preflight\n" +
    "If a thread-limit or admission failure leaves orphaned child threads " +
    "under your session, recover before retrying. The recovery reads your " +
    "spawn history, waits for every child, and closes only the ones that " +
    "are terminal; foreign and still-running children are never touched.\n\n" +
    "If you have a `mcp__codex_app__read_thread` tool, call it with " +
    "`{ threadId: <your session id>, turnLimit: 10, includeOutputs: false, " +
    "maxOutputCharsPerItem: 2000 }` to get the recent items. For every " +
    "`collabAgentToolCall` whose `senderThreadId` matches your session id, " +
    "collect the `receiverThreadIds`. Wait on each id with " +
    "`multi_agent_v1__wait_agent({ targets: [<id>], timeout_ms: 30000 })` " +
    "and close the terminal ones with " +
    "`multi_agent_v1__close_agent({ target: <id> })`. Do not infer child ids " +
    "from global task listings, telemetry, or any source other than your " +
    "own session's spawn history.\n";
  const codeBlock = recovery
    ? "\nIf your runtime exposes a single `exec` tool that runs raw JavaScript " +
      "(Codex code mode), the same steps are pre-bundled below as a " +
      "reference script -- adapt the invocations to the surface your tools " +
      "actually expose; do not assume the script runs as written.\n\n" +
      "```js\n" +
      recovery +
      "\n```\n"
    : "\nThe pre-bundled code-mode script was unavailable for this turn " +
      "(the hook did not receive a parent session id or could not load the " +
      "recovery helper). Use the natural-language steps above instead.\n";
  return header + codeBlock;
}

  const prompt = readFileSync(promptFile, "utf8").trim();
  const skill = existsSync(skillFile)
    ? `\n\n## Canonical orchestration skill\n\n${readFileSync(skillFile, "utf8").trim()}`
    : "\n\nCanonical orchestration skill is unavailable; report that capability failure instead of silently substituting a workflow.";
  const codeSearch = existsSync(codeSearchFile)
    ? `\n\n${readFileSync(codeSearchFile, "utf8").trim()}`
    : "\n\nShared codebase navigation prompt is unavailable; report that capability failure instead of silently substituting a workflow.";
  const recoveryContext = buildRecoveryContext(recovery);
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        "UserPromptSubmit hook fired: injecting root delegation policy",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: prompt + skill + codeSearch + recoveryContext
      }
    })
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRootDelegation();
}
