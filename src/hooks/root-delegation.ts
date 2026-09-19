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
  const prompt = readFileSync(promptFile, "utf8").trim();
  const skill = existsSync(skillFile)
    ? `\n\n## Canonical orchestration skill\n\n${readFileSync(skillFile, "utf8").trim()}`
    : "\n\nCanonical orchestration skill is unavailable; report that capability failure instead of silently substituting a workflow.";
  const codeSearch = existsSync(codeSearchFile)
    ? `\n\n${readFileSync(codeSearchFile, "utf8").trim()}`
    : "\n\nShared codebase navigation prompt is unavailable; report that capability failure instead of silently substituting a workflow.";
  const recoveryContext = recovery
    ? `\n\n## Current-parent recovery preflight\nExecute this preflight before retrying a thread-limit/admission failure. It reads only the current parent task spawn history, waits for each child, and closes terminal handles; it never closes foreign or running children.\n\n\`\`\`js\n${recovery}\`\`\``
    : "\n\nCurrent-parent recovery preflight is unavailable because the hook did not receive a parent session id or could not load the recovery helper. Do not infer child ids from global task listings.";
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
