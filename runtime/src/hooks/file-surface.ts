#!/usr/bin/env node

/**
 * Codex's native file tools, refused where Codex runs them.
 *
 * AutoDev has one file-interaction surface: the `filesystem` MCP server
 * (`@modelcontextprotocol/server-filesystem`), offered to every provider the
 * same way and confined to the workspace. A provider-native file tool next to
 * it would be a second surface with its own confinement, its own failure
 * modes and its own trace, so every provider runs without its own.
 *
 * For Codex, AutoDev's model catalogs leave out `apply_patch_tool_type`, which
 * keeps `apply_patch` out of the request. Two tools stay that a catalog cannot
 * remove: `view_image`, which Codex 0.171 offers whatever `[tools]` or the
 * input modalities say, and `apply_patch` on a model whose catalog AutoDev does
 * not render (Codex's own bundled OpenAI catalog). Codex runs a `PreToolUse`
 * hook for both, so this hook refuses them and names the tool to use instead;
 * the model reads the refusal as the call's output and makes the call again
 * through `filesystem`.
 */

import { readFileSync } from "node:fs";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { MCP_SERVER_FILESYSTEM } from "@simulatorlife/autodev-runtime/shared/tool-names";

import { logPreToolUseDenial } from "./hook-log.ts";
import {
  extractHookContext,
  extractHookToolCall,
  formatPreToolUseDenyResponse,
  parseHookPayload
} from "./hook-payload.ts";

/** The `filesystem` tool each native file tool is replaced by. */
const REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  [
    "apply_patch",
    "`edit_file` (line-based edits with a diff preview) or `write_file` (new or rewritten files)"
  ],
  ["view_image", "`read_media_file`"],
  ["write_to_file", "`write_file`"],
  ["replace_file_content", "`edit_file`"],
  ["multi_replace_file_content", "`edit_file`"]
]);

function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/gu, "_");
}

export interface FileSurfaceDecision {
  readonly denied: boolean;
  readonly reason: string | null;
}

/** Whether a `PreToolUse` payload is a native file tool, and why it is refused. */
export function evaluateFileSurfaceHook(rawInput: string): FileSurfaceDecision {
  const payload = parseHookPayload(rawInput);
  if (!payload) return { denied: false, reason: null };
  const call = extractHookToolCall(payload);
  if (!call) return { denied: false, reason: null };
  const replacement = REPLACEMENTS.get(normalizeToolName(call.toolName));
  if (replacement === undefined) return { denied: false, reason: null };
  return {
    denied: true,
    reason: `\`${call.toolName}\` is disabled: every file read and edit goes through the \`${MCP_SERVER_FILESYSTEM}\` MCP server. Use its ${replacement} tool instead.`
  };
}

export function runFileSurfaceHook(raw = readFileSync(0, "utf8")): number {
  const decision = evaluateFileSurfaceHook(raw);
  if (!decision.denied || decision.reason === null) return 0;
  const payload = parseHookPayload(raw);
  const call = payload ? extractHookToolCall(payload) : null;
  const context = extractHookContext(payload);
  logPreToolUseDenial({
    hook: "file-surface",
    policy: "file-surface",
    role: context.role ?? "root",
    model: context.model,
    session: context.sessionId,
    turn: context.turnId,
    tool: call?.toolName ?? null,
    reason: decision.reason
  });
  process.stdout.write(`${formatPreToolUseDenyResponse(decision.reason)}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = runFileSurfaceHook();
  } catch (error) {
    writeErrorLine(
      `The file-surface hook could not run: ${errorMessage(error)}`
    );
    process.exitCode = 0;
  }
}
