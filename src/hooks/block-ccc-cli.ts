#!/usr/bin/env node

import { readFileSync } from 'node:fs';

export const REDIRECTION_MESSAGE = `Direct CLI execution of 'ccc' is blocked by policy.
Do NOT run 'ccc' commands in bash or terminal.
Instead:
1. Use the 'cocoindex-code' MCP server tool: \`tools.mcp__cocoindex_code__search\` (or \`cocoindex-code/search\` in standard MCP).
2. The MCP search tool automatically maintains and updates the index before querying (\`refresh_index: true\` by default) — you do not need to run 'ccc index'.
3. For details on tool parameters and semantic search capabilities, consult the 'ccc' skill.`;

export function isCccInvocation(cmd: string): boolean {
  if (!cmd || typeof cmd !== 'string') return false;
  if (!/(?:^|[\s\/;|\&`\(\'\"=])ccc(?:\s|$|[\'\";|&`\)])/.test(cmd)) return false;

  const segments = cmd.split(/(?:&&|\|\||[;\n|&`\(\)])/);
  for (let segment of segments) {
    segment = segment.trim();
    if (!segment) continue;
    segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s"'\\]+|"[^"]*"|'[^']*')\s*)+/, '');
    const match = segment.match(/^(?:sudo|exec|nohup|time|xargs|env|eval|command|builtin)\s+(.+)$/);
    if (match) segment = match[1]?.trim() ?? '';
    const firstWordMatch = segment.match(/^([^\s]+)/);
    if (firstWordMatch) {
      const token = firstWordMatch[1] ?? '';
      const base = token.split('/').pop()?.replace(/['"]/g, '');
      if (base === 'ccc') return true;
    }
  }
  return false;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function pickString(payload: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractCommandString(payload: JsonObject): string {
  const toolName = (pickString(payload, ['tool_name', 'toolName', 'name']) ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const commandTools = new Set(['exec_command', 'execcommand', 'execute_command', 'bash', 'terminal', 'run_command']);
  if (!commandTools.has(toolName)) return '';

  const rawArgs = payload.arguments ?? payload.args ?? payload.input ?? payload.params ?? payload.tool_input ?? payload.toolInput;
  if (typeof rawArgs === 'string') return rawArgs;
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    const obj = rawArgs as JsonObject;
    for (const key of ['cmd', 'command', 'exec', 'input']) {
      const val = obj[key];
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const nested = (val as JsonObject).cmd ?? (val as JsonObject).command;
        if (typeof nested === 'string') return nested;
      }
    }
  }
  return '';
}

export function evaluatePreToolUse(rawInput: string): { blocked: boolean; reason?: string } {
  let parsed: JsonObject;
  try {
    parsed = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { blocked: false };
  } catch {
    return { blocked: false };
  }

  const cmd = extractCommandString(parsed);
  if (cmd && isCccInvocation(cmd)) {
    return { blocked: true, reason: REDIRECTION_MESSAGE };
  }
  return { blocked: false };
}

export function runBlockCccCli(raw = readFileSync(0, 'utf8')): number {
  const result = evaluatePreToolUse(raw);
  if (result.blocked) {
    console.error(result.reason ?? REDIRECTION_MESSAGE);
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason ?? REDIRECTION_MESSAGE,
      },
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 2;
  }
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = runBlockCccCli();
  } catch {
    process.exitCode = 0;
  }
}
