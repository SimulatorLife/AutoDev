#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { logPreToolUseDenial } from "./hook-log.ts";
import {
  extractHookContext,
  extractHookToolCall,
  formatPreToolUseDenyResponse,
  parseHookPayload
} from "./hook-payload.ts";

export const REDIRECTION_MESSAGE = `Direct CLI execution of 'ccc' is blocked by policy.
Do NOT run 'ccc' commands in bash or terminal.
Instead:
1. Use the 'cocoindex-code' MCP server tool: \`tools.mcp__cocoindex_code__search\` (or \`cocoindex-code/search\` in standard MCP).
2. The MCP search tool automatically maintains and updates the index before querying (\`refresh_index: true\` by default) — you do not need to run 'ccc index'.
3. For details on tool parameters and semantic search capabilities, consult the 'ccc' skill.`;

const CCC_TOKEN = /(?:^|[\s/;|&`('"=])ccc(?:\s|$|['";|&`)])/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=(?:[^\s"'\\]+|"[^"]*"|'[^']*')\s*/;
const COMMAND_WRAPPER =
  /^(?:sudo|exec|nohup|time|xargs|env|eval|command|builtin)\s+(\S.*)$/;
const FIRST_WORD = /^(\S+)/;

/**
 * The shell's own separators, as the characters that end one command.
 *
 * A separator only ends a command where the shell would read one: inside a
 * quoted string, a heredoc body or a command substitution it is text. The
 * split used to ignore that, so an `rg` pattern like
 * `'CodeGraph|CocoIndex|ccc|LSP MCP'` was read as three commands -- `rg
 * -n -i 'CodeGraph`, `CocoIndex` and `ccc` -- and the third was blocked as a
 * `ccc` invocation. A search for the word `ccc` was the one search the policy
 * forbade.
 */
const SEGMENT_SEPARATORS = new Set([";", "\n", "|", "&", "(", ")"]);

/**
 * Mask the body of every heredoc with spaces.
 *
 * A heredoc body is data, not commands: `cat <<'EOF' ... ccc ... EOF` runs
 * `cat` and nothing else. Masking it keeps the body's separators and words out
 * of the segment scan, so a body that mentions `ccc` cannot be read as an
 * invocation.
 */
export function maskHeredocBodies(cmd: string): string {
  const masked = cmd.split("");
  let quote: string | null = null;
  let index = 0;
  while (index < cmd.length) {
    const ch = cmd[index]!;
    if (quote) {
      if (ch === "\\" && quote !== "'") index += 1;
      else if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch !== "<" || cmd[index + 1] !== "<") {
      index += 1;
      continue;
    }
    // `<<<` is a here-string: its body is the next word, not a block.
    if (cmd[index + 2] === "<") {
      index += 3;
      continue;
    }
    let cursor = index + 2;
    if (cmd[cursor] === "-") cursor += 1;
    while (cmd[cursor] === " " || cmd[cursor] === "\t") cursor += 1;
    let delimiter = "";
    const quoteChar = cmd[cursor];
    if (quoteChar === '"' || quoteChar === "'") {
      cursor += 1;
      while (cursor < cmd.length && cmd[cursor] !== quoteChar) {
        delimiter += cmd[cursor];
        cursor += 1;
      }
      cursor += 1;
    } else {
      while (cursor < cmd.length && !/[\s;&|()]/.test(cmd[cursor]!)) {
        delimiter += cmd[cursor];
        cursor += 1;
      }
    }
    if (!delimiter) {
      index += 2;
      continue;
    }
    // The body runs from the end of the opening line to the delimiter line.
    const bodyStart = cmd.indexOf("\n", cursor);
    if (bodyStart === -1) {
      index = cursor;
      continue;
    }
    let bodyEnd = cmd.length;
    let lineStart = bodyStart + 1;
    while (lineStart <= cmd.length) {
      const lineEnd = cmd.indexOf("\n", lineStart);
      const line = cmd.slice(lineStart, lineEnd === -1 ? cmd.length : lineEnd);
      if (line.trim() === delimiter) {
        bodyEnd = lineStart;
        break;
      }
      if (lineEnd === -1) break;
      lineStart = lineEnd + 1;
    }
    for (let position = bodyStart + 1; position < bodyEnd; position += 1) {
      if (masked[position] !== "\n") masked[position] = " ";
    }
    index = bodyEnd;
  }
  return masked.join("");
}

/**
 * Split a shell command into the commands the shell would run separately.
 *
 * The separators are the shell's own, read outside quotes and outside command
 * substitutions: a `|` inside a quoted pattern is a character of the pattern,
 * not a pipe between two commands.
 */
export function splitShellSegments(cmd: string): string[] {
  const masked = maskHeredocBodies(cmd);
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  let index = 0;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
  };

  while (index < masked.length) {
    const ch = masked[index]!;
    if (escaped) {
      current += ch;
      escaped = false;
      index += 1;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      index += 1;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      index += 1;
      continue;
    }
    if (ch === "$" && masked[index + 1] === "(") {
      substitutionDepth += 1;
      current += "$(";
      index += 2;
      continue;
    }
    if (substitutionDepth > 0) {
      if (ch === ")") substitutionDepth -= 1;
      current += ch;
      index += 1;
      continue;
    }
    if (SEGMENT_SEPARATORS.has(ch)) {
      push();
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  push();
  return segments;
}

/** Strip leading `NAME=value` environment assignments from a command segment. */
function withoutEnvAssignments(segment: string): string {
  let rest = segment;
  for (
    let assignment = ENV_ASSIGNMENT.exec(rest);
    assignment;
    assignment = ENV_ASSIGNMENT.exec(rest)
  )
    rest = rest.slice(assignment[0].length);
  return rest;
}

/** The command word of a segment, without the quotes that may wrap it. */
function commandWord(segment: string): string {
  const match = FIRST_WORD.exec(segment);
  if (!match) return "";
  return match[1]!.replace(/^["']|["']$/g, "");
}

export function isCccInvocation(cmd: string): boolean {
  if (!cmd || typeof cmd !== "string") return false;
  if (!CCC_TOKEN.test(cmd)) return false;

  for (const segment of splitShellSegments(cmd)) {
    let candidate = withoutEnvAssignments(segment.trim());
    const wrapped = COMMAND_WRAPPER.exec(candidate);
    if (wrapped) candidate = wrapped[1]!.trim();
    const base = commandWord(candidate).split("/").pop() ?? "";
    if (base === "ccc") return true;
  }
  return false;
}

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function extractCommandString(payload: JsonObject): string {
  const call = extractHookToolCall(payload);
  const toolName = (call?.toolName ?? "")
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
  const commandTools = new Set([
    "exec_command",
    "execcommand",
    "execute_command",
    "bash",
    "terminal",
    "run_command"
  ]);
  if (!commandTools.has(toolName)) return "";

  const rawArgs = call?.toolInput;
  if (typeof rawArgs === "string") return rawArgs;
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    const obj = rawArgs as JsonObject;
    for (const key of ["cmd", "command", "exec", "input"]) {
      const val = obj[key];
      if (typeof val === "string") return val;
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const nested = (val as JsonObject).cmd ?? (val as JsonObject).command;
        if (typeof nested === "string") return nested;
      }
    }
  }
  return "";
}

export function evaluatePreToolUse(rawInput: string): {
  blocked: boolean;
  reason?: string;
} {
  const parsed = parseHookPayload(rawInput) as JsonObject | null;
  if (!parsed) return { blocked: false };

  const cmd = extractCommandString(parsed);
  if (cmd && isCccInvocation(cmd)) {
    return { blocked: true, reason: REDIRECTION_MESSAGE };
  }
  return { blocked: false };
}

export function runBlockCccCli(raw = readFileSync(0, "utf8")): number {
  const result = evaluatePreToolUse(raw);
  if (result.blocked) {
    const reason = result.reason ?? REDIRECTION_MESSAGE;
    const parsed = parseHookPayload(raw) as JsonObject | null;
    if (parsed) {
      const cmd = extractCommandString(parsed);
      const call = extractHookToolCall(parsed);
      const context = extractHookContext(parsed);
      logPreToolUseDenial({
        hook: "block-ccc-cli",
        policy: "block-ccc-cli",
        origin: context.origin,
        role: context.role,
        model: context.model,
        session: context.sessionId,
        turn: context.turnId,
        tool: call?.toolName ?? null,
        reason,
        toolInput: cmd ? { cmd } : undefined
      });
    }
    writeErrorLine(reason);
    process.stdout.write(`${formatPreToolUseDenyResponse(reason)}\n`);
    return 2;
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = runBlockCccCli();
  } catch {
    process.exitCode = 0;
  }
}
