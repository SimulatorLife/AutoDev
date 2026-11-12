#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { codexHome, repositoryRoot } from "./command-utils.ts";

type HookInput = {
  model?: unknown;
  session_id?: unknown;
  hook_event_name?: unknown;
  turn_id?: unknown;
  transcript_path?: unknown;
};
/**
 * Transcript records that replace history with a summary: Codex rollouts write
 * a `compacted` record, Claude Code writes a `compact_boundary` system record.
 */
const COMPACTION_RECORDS = [
  '"type":"compacted"',
  '"subtype":"compact_boundary"'
];
/**
 * Transcript records that carry hook-injected context: Codex records it as a
 * developer message, Claude Code as a `hook_additional_context` attachment.
 * Tool output that merely quotes the bootstrap (a `cat` of the prompt file) is
 * not an injection and must not suppress one.
 */
const INJECTION_RECORDS = [
  '"role":"developer"',
  '"type":"hook_additional_context"'
];
const NON_ROOT_MODEL =
  /^(autodev\/|MiniMax-|sonnet$|opus$|haiku$|claude-|gemini-|copilot|opencli-)/;
const DEDUP_TTL_MS = 15 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 1024;
const LOCK_STALE_MS = 30 * 1000;

/**
 * The bootstrap stays in model context until the host (Codex or Claude Code)
 * compacts the history, which drops hook-injected context. Re-injecting it on every user prompt
 * re-sends ~2k tokens per prompt for the rest of the session, so inject only
 * when the current context window does not already carry it. Fails open: an
 * unreadable or missing transcript injects.
 */
export function bootstrapInCurrentWindow(
  transcriptPath: unknown,
  marker: string
): boolean {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath))
    return false;
  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    return false;
  }
  const encodedMarker = JSON.stringify(marker).slice(1, -1);
  let injected = false;
  for (const record of transcript.split("\n")) {
    const carriesBootstrap =
      record.includes(encodedMarker) &&
      INJECTION_RECORDS.some((kind) => record.includes(kind));
    // A compaction record starts a new window; it keeps the bootstrap only
    // when its replacement history retained the injected message.
    if (COMPACTION_RECORDS.some((boundary) => record.includes(boundary)))
      injected = carriesBootstrap;
    else if (carriesBootstrap) injected = true;
  }
  return injected;
}

function shouldInjectOnce(input: HookInput, model: string): boolean {
  const sessionId =
    typeof input.session_id === "string" ? input.session_id.trim() : "";
  const turnId = typeof input.turn_id === "string" ? input.turn_id.trim() : "";
  if (!sessionId || !turnId || !model) return true;

  const key = createHash("sha256")
    .update(JSON.stringify([sessionId, turnId, model]))
    .digest("hex");
  const hooksDir = path.join(codexHome(), "hooks");
  const stateFile = path.join(hooksDir, "root-delegation-state.json");
  const lockDir = path.join(hooksDir, "root-delegation-state.lock");
  try {
    mkdirSync(hooksDir, { recursive: true });
  } catch {
    return true;
  }

  // mkdir is the cross-process atomic claim. State holds only hashed turn keys
  // and timestamps; no prompt content, model input, or credentials are stored.
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  while (true) {
    if (Date.now() >= deadline) return true;
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return true;
      let lockAge: number;
      try {
        lockAge = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return true;
        Atomics.wait(waitArray, 0, 0, Math.min(10, remaining));
        continue;
      }
      if (lockAge > LOCK_STALE_MS) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return true;
          Atomics.wait(waitArray, 0, 0, Math.min(10, remaining));
        }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      Atomics.wait(waitArray, 0, 0, Math.min(10, remaining));
    }
  }

  try {
    const now = Date.now();
    let entries: Record<string, number> = {};
    try {
      const stored: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
      if (
        stored !== null &&
        typeof stored === "object" &&
        !Array.isArray(stored)
      ) {
        entries = Object.fromEntries(
          Object.entries(stored).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" &&
              Number.isFinite(entry[1]) &&
              now - entry[1] < DEDUP_TTL_MS
          )
        );
      }
    } catch {
      // Missing or corrupt state starts a fresh bounded window.
    }
    const duplicate = Object.hasOwn(entries, key);
    if (!duplicate) entries[key] = now;
    const boundedEntries = Object.fromEntries(
      Object.entries(entries)
        .sort((a, b) => b[1] - a[1])
        .slice(0, DEDUP_MAX_ENTRIES)
    );
    const temporary = `${stateFile}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(boundedEntries), { mode: 0o600 });
      renameSync(temporary, stateFile);
      return !duplicate;
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // State cleanup is best effort; always fail open and emit root policy.
      }
      return true;
    }
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // A stale lock expires; never let state cleanup suppress root policy.
    }
  }
}

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

/** Keep this exceptional-path reminder compact; the orchestration skill owns the full procedure. */
function buildRecoveryContext(parentId: string | null): string {
  if (!parentId) return "";
  return (
    "\n\n## Current-parent recovery preflight\n" +
    `Current parent session: ${parentId}. Only after a capacity/admission failure, ` +
    "follow the canonical orchestration recovery procedure against this parent's " +
    "own spawn history. Preserve running children and useful partial results; " +
    "close dead terminal handles or evict the oldest parked handles only when " +
    "capacity requires it. Never inspect or clean up foreign sessions.\n"
  );
}

export async function runRootDelegation(
  raw = readFileSync(0, "utf8")
): Promise<number> {
  const input = parseInput(raw);
  logInput(input);
  const model = typeof input.model === "string" ? input.model : "";
  if (model !== "autodev/orchestrator" && NON_ROOT_MODEL.test(model)) return 0;
  const root = repositoryRoot();
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
  const prompt = readFileSync(promptFile, "utf8").trim();
  const firstLineEnd = prompt.indexOf("\n");
  const marker = firstLineEnd === -1 ? prompt : prompt.slice(0, firstLineEnd);
  if (marker && bootstrapInCurrentWindow(input.transcript_path, marker))
    return 0;
  if (!shouldInjectOnce(input, model)) return 0;
  const skill = existsSync(skillFile)
    ? `\n\n## Canonical orchestration skill\n\nRead and follow the installed \`orchestration\` skill before substantial work. It is the sole authority for delegation, child lifecycle, recovery, workspace boundaries, and validation. Source: ${skillFile}. The hook points to the skill instead of copying its full body.`
    : `\n\nCanonical orchestration skill is unavailable at ${skillFile}; report that capability failure instead of silently substituting a workflow.`;
  const codeSearch = existsSync(codeSearchFile)
    ? `\n\n${readFileSync(codeSearchFile, "utf8").trim()}`
    : "\n\nShared codebase navigation prompt is unavailable; report that capability failure instead of silently substituting a workflow.";
  const recoveryContext = buildRecoveryContext(parentId);
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
