/**
Provider-neutral hook payload normalization across Codex, Claude Code,
Antigravity (`agy`), GitHub Copilot CLI, and MiniMax Code (`mcode`).
*/

import { isRecord } from "@simulatorlife/autodev-core";
import { MCODE_NATIVE_TOOL_NAMES } from "@simulatorlife/autodev-runtime/shared/tool-names";

export interface NormalizedHookToolCall {
  readonly rawToolName: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}

export interface NormalizedHookContext {
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly role: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly cwd: string | null;
}

const TOOL_NAME_KEYS = ["tool_name", "toolName", "name"] as const;
const ARGUMENT_KEYS = [
  "tool_input",
  "toolInput",
  "tool_args",
  "toolArgs",
  "arguments",
  "args",
  "input",
  "params"
] as const;
const SESSION_ID_KEYS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId"
] as const;
const TURN_ID_KEYS = ["turn_id", "turnId"] as const;
const ROLE_KEYS = ["agent_type", "agentType", "agentName", "role"] as const;
const CWD_KEYS = [
  "cwd",
  "working_directory",
  "workingDirectory",
  "workspace_cwd",
  "repository_cwd"
] as const;

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function pickHookString(
  record: unknown,
  keys: readonly string[]
): string | null {
  if (!isRecord(record)) return null;
  for (const key of keys) {
    const value = stringOrNull(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function parseJsonObjectIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function pickToolArguments(source: Record<string, unknown>): unknown {
  for (const key of ARGUMENT_KEYS) {
    if (source[key] !== undefined && source[key] !== null) {
      return parseJsonObjectIfString(source[key]);
    }
  }
  return null;
}

/**
Unwrap Antigravity's `call_mcp_tool` wrapper into canonical `mcp__<server>__<tool>`
and its inner arguments so downstream hooks inspect the target MCP call uniformly.
*/
function unwrapCallMcpTool(
  rawToolName: string,
  toolInput: unknown
): NormalizedHookToolCall {
  if (rawToolName.toLowerCase() !== "call_mcp_tool" || !isRecord(toolInput)) {
    return { rawToolName, toolName: rawToolName, toolInput };
  }
  const server =
    stringOrNull(toolInput.ServerName) ?? stringOrNull(toolInput.serverName);
  const innerTool =
    stringOrNull(toolInput.ToolName) ?? stringOrNull(toolInput.toolName);
  if (server && innerTool) {
    let innerArguments: unknown = {};
    if (toolInput.Arguments !== undefined) {
      innerArguments = parseJsonObjectIfString(toolInput.Arguments);
    } else if (toolInput.arguments !== undefined) {
      innerArguments = parseJsonObjectIfString(toolInput.arguments);
    }
    return {
      rawToolName,
      toolName: `mcp__${server}__${innerTool}`,
      toolInput: innerArguments
    };
  }
  return { rawToolName, toolName: rawToolName, toolInput };
}

export function parseHookPayload(
  rawInput: string
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawInput);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
Translate MiniMax Code's own tool names into the canonical AutoDev names the
hook implementations read. MiniMax Code names its file tools `read`, `write`
and `edit`; every other provider either uses the canonical names or has no
native file tools, so the translation is scoped to MiniMax Code.
*/
function canonicalToolName(
  toolName: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (environment.AUTODEV_PROVIDER?.trim() !== "mcode") return toolName;
  return MCODE_NATIVE_TOOL_NAMES[toolName.toLowerCase()] ?? toolName;
}

/**
Extract the tool name and tool arguments from any supported hook payload:
- Codex / Claude / Copilot flat `{ tool_name|toolName, tool_input|toolArgs }`
- Antigravity nested `{ toolCall: { name, arguments } }` (and `tool_call`)
- Antigravity `call_mcp_tool` wrapper -> canonical `mcp__<server>__<tool>`
*/
export function extractHookToolCall(
  payload: unknown
): NormalizedHookToolCall | null {
  if (!isRecord(payload)) return null;
  const nestedCall = isRecord(payload.toolCall)
    ? payload.toolCall
    : isRecord(payload.tool_call)
      ? payload.tool_call
      : null;

  const rawToolName =
    (nestedCall ? pickHookString(nestedCall, TOOL_NAME_KEYS) : null) ??
    pickHookString(payload, TOOL_NAME_KEYS);
  if (!rawToolName) return null;

  const toolInput =
    (nestedCall ? pickToolArguments(nestedCall) : null) ??
    pickToolArguments(payload) ??
    {};

  return unwrapCallMcpTool(canonicalToolName(rawToolName), toolInput);
}

/**
Extract session/turn/role/model/provider/cwd metadata from a hook payload and env.
*/
export function extractHookContext(
  payload: unknown,
  environment: NodeJS.ProcessEnv = process.env
): NormalizedHookContext {
  const record = isRecord(payload) ? payload : {};
  const metadata = isRecord(record.metadata) ? record.metadata : null;
  const sessionId =
    stringOrNull(environment.AUTODEV_SESSION_ID) ??
    pickHookString(record, SESSION_ID_KEYS) ??
    (metadata ? pickHookString(metadata, SESSION_ID_KEYS) : null) ??
    stringOrNull(record["x-codex-session-id"]);
  const turnId =
    stringOrNull(environment.AUTODEV_TURN_ID) ??
    pickHookString(record, TURN_ID_KEYS) ??
    (metadata ? pickHookString(metadata, TURN_ID_KEYS) : null);
  const role =
    stringOrNull(environment.AUTODEV_AGENT_ROLE) ??
    pickHookString(record, ROLE_KEYS) ??
    (metadata ? pickHookString(metadata, ROLE_KEYS) : null);
  const model =
    stringOrNull(environment.AUTODEV_MODEL) ??
    stringOrNull(record.model) ??
    (metadata ? stringOrNull(metadata.model) : null);
  const provider =
    stringOrNull(environment.AUTODEV_PROVIDER) ??
    stringOrNull(record.provider) ??
    (metadata ? stringOrNull(metadata.provider) : null);
  const cwd =
    pickHookString(record, CWD_KEYS) ??
    (metadata ? pickHookString(metadata, CWD_KEYS) : null);

  return { sessionId, turnId, role, model, provider, cwd };
}

export function formatPreToolUseDenyResponse(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  });
}
