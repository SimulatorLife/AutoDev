#!/usr/bin/env node

/**
 * One-shot evidence report for an AutoDev/Codex session or thread.
 *
 * Joins what is otherwise correlated by hand: the Codex rollout of every
 * thread in the session (root and subagents), each thread's tool calls and
 * tool failures, the router's requests for each thread, and -- unless
 * --offline -- what is live now: router agent counts against the threads
 * actually writing, running provider CLIs, and whether the running services
 * match the checkout. It reads local files and the loopback router only,
 * never prints credentials, and truncates every prompt/output excerpt.
 *
 *   node session-trace.ts <session-or-thread-id> [--items] [--events]
 *        [--failures] [--all-failures] [--efficiency] [--json]
 *        [--codex-home DIR] [--router-log FILE] [--offline]
 *   node session-trace.ts --recent [N]
 *   node session-trace.ts --scan-recent [N]
 *   node session-trace.ts --hooks [--since DAYS]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface JsonRecord {
  [key: string]: unknown;
}

/** A JSON value: an object, an array, a primitive, or null. */
type JsonValue = JsonRecord | JsonValue[] | string | number | boolean | null;

/** The session_meta record, as it appears at the head of every rollout JSONL. */
interface SessionMetaPayload {
  id?: string;
  session_id?: string;
  parent_thread_id?: string;
  thread_source?: string;
  agent_role?: string;
  agent_nickname?: string;
  model_provider?: string;
  cli_version?: string;
  cwd?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/** The turn_context record: carries the model the turn ran against. */
interface TurnContextPayload {
  model?: string;
  [key: string]: unknown;
}

/** A single content part attached to a `response_item` of type `message` / `reasoning`. */
interface ResponseContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** Discriminated union over the `response_item` variants the tracer cares about. */
type ResponseItemPayload =
  | {
      type: "message";
      role?: string;
      content?: ResponseContentPart[];
      [key: string]: unknown;
    }
  | {
      type: "reasoning";
      id?: string;
      summary?: JsonValue[];
      content?: ResponseContentPart[];
      [key: string]: unknown;
    }
  | {
      type: "custom_tool_call" | "function_call";
      name?: string;
      call_id?: string;
      id?: string;
      input?: JsonValue;
      arguments?: JsonValue;
      [key: string]: unknown;
    }
  | {
      type: "custom_tool_call_output" | "function_call_output";
      call_id?: string;
      output?: JsonValue;
      [key: string]: unknown;
    };

/** Discriminated union over the `event_msg` variants the tracer cares about. */
type EventMsgPayload =
  | { type: "task_started"; turn_id?: string; [key: string]: unknown }
  | {
      type: "task_complete";
      turn_id?: string;
      last_agent_message?: string;
      error?: JsonValue;
      [key: string]: unknown;
    }
  | {
      type: "turn_aborted";
      turn_id?: string;
      reason?: string;
      [key: string]: unknown;
    }
  | { type: string; [key: string]: unknown };

/** A rollout JSONL line, discriminated by its `type` field. */
type RolloutPayload =
  | { type: "session_meta"; payload?: SessionMetaPayload; timestamp?: string }
  | { type: "turn_context"; payload?: TurnContextPayload; timestamp?: string }
  | { type: "response_item"; payload?: ResponseItemPayload; timestamp?: string }
  | { type: "event_msg"; payload?: EventMsgPayload; timestamp?: string }
  | { type: string; payload?: JsonRecord; timestamp?: string };

/** The shape of the router /status `agents` block the live report exposes. */
interface RouterAgentStatus {
  schema?: string;
  canonicalLiveCount?: number;
  byState?: Record<string, number>;
  liveByKind?: Record<string, number>;
  liveByRole?: Record<string, number>;
  liveByOrigin?: Record<string, number>;
  liveByProvider?: Record<string, number>;
  liveByModel?: Record<string, number>;
  liveByWorkspace?: Record<string, number>;
  missingProvider?: number;
  missingModel?: number;
  slotVsAgent?: Record<string, number>;
  reconciledWithConcurrency?: boolean;
  [key: string]: unknown;
}

/** The router-event fields we project into the per-thread summary. */
interface RouterEventFields {
  requestId?: string;
  thread?: string;
  phase?: string;
  role?: string;
  requestedModel?: string;
  provider?: string;
  model?: string;
  outcome?: string;
  status?: number;
  failureClass?: string;
  reason?: string;
  spawnFailureReason?: string;
  denialReason?: string;
  elapsedMs?: number;
  toolCalls?: number;
  selection?: string;
  errorName?: string;
  errorCode?: string;
  [key: string]: unknown;
}

/** The router /status top-level body the live report reads. */
interface RouterStatusBody {
  agents?: RouterAgentStatus;
  startedAt?: string;
  providers?: Record<string, JsonRecord>;
  usage?: JsonRecord;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionMetaPayload(raw: unknown): SessionMetaPayload {
  if (!isRecord(raw)) return {};
  const meta: SessionMetaPayload = { ...raw };
  if (typeof raw.id === "string") meta.id = raw.id;
  if (typeof raw.session_id === "string") meta.session_id = raw.session_id;
  if (typeof raw.parent_thread_id === "string")
    meta.parent_thread_id = raw.parent_thread_id;
  if (typeof raw.thread_source === "string")
    meta.thread_source = raw.thread_source;
  if (typeof raw.agent_role === "string") meta.agent_role = raw.agent_role;
  if (typeof raw.agent_nickname === "string")
    meta.agent_nickname = raw.agent_nickname;
  if (typeof raw.model_provider === "string")
    meta.model_provider = raw.model_provider;
  if (typeof raw.cli_version === "string") meta.cli_version = raw.cli_version;
  if (typeof raw.cwd === "string") meta.cwd = raw.cwd;
  if (typeof raw.timestamp === "string") meta.timestamp = raw.timestamp;
  return meta;
}

function parseTurnContextPayload(raw: unknown): TurnContextPayload {
  if (!isRecord(raw)) return {};
  const context: TurnContextPayload = { ...raw };
  if (typeof raw.model === "string") context.model = raw.model;
  return context;
}

function parseContentParts(raw: unknown): ResponseContentPart[] | null {
  if (!Array.isArray(raw)) return null;
  const parts: ResponseContentPart[] = [];
  for (const item of raw) {
    if (isRecord(item)) {
      const part: ResponseContentPart = { ...item };
      if (typeof item.type === "string") part.type = item.type;
      if (typeof item.text === "string") part.text = item.text;
      parts.push(part);
    }
  }
  return parts;
}

function parseResponseItemPayload(raw: unknown): ResponseItemPayload | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "message": {
      const payload: ResponseItemPayload = {
        ...raw,
        type: "message"
      };
      if (typeof raw.role === "string") payload.role = raw.role;
      const content = parseContentParts(raw.content);
      if (content !== null) payload.content = content;
      return payload;
    }
    case "reasoning": {
      const payload: ResponseItemPayload = {
        ...raw,
        type: "reasoning"
      };
      if (typeof raw.id === "string") payload.id = raw.id;
      if (Array.isArray(raw.summary)) payload.summary = raw.summary;
      const content = parseContentParts(raw.content);
      if (content !== null) payload.content = content;
      return payload;
    }
    case "custom_tool_call":
    case "function_call": {
      const payload: ResponseItemPayload = {
        ...raw,
        type: raw.type
      };
      if (typeof raw.name === "string") payload.name = raw.name;
      if (typeof raw.call_id === "string") payload.call_id = raw.call_id;
      if (typeof raw.id === "string") payload.id = raw.id;
      return payload;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      const payload: ResponseItemPayload = {
        ...raw,
        type: raw.type
      };
      if (typeof raw.call_id === "string") payload.call_id = raw.call_id;
      return payload;
    }
    default: {
      return null;
    }
  }
}

function parseEventMsgPayload(raw: unknown): EventMsgPayload | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "task_started": {
      const payload: EventMsgPayload = {
        ...raw,
        type: "task_started"
      };
      if (typeof raw.turn_id === "string") payload.turn_id = raw.turn_id;
      return payload;
    }
    case "task_complete": {
      const payload: EventMsgPayload = {
        ...raw,
        type: "task_complete"
      };
      if (typeof raw.turn_id === "string") payload.turn_id = raw.turn_id;
      if (typeof raw.last_agent_message === "string")
        payload.last_agent_message = raw.last_agent_message;
      return payload;
    }
    case "turn_aborted": {
      const payload: EventMsgPayload = {
        ...raw,
        type: "turn_aborted"
      };
      if (typeof raw.turn_id === "string") payload.turn_id = raw.turn_id;
      if (typeof raw.reason === "string") payload.reason = raw.reason;
      return payload;
    }
    default: {
      return {
        ...raw,
        type: raw.type
      };
    }
  }
}

function isResponseItemPayload(
  payload: unknown
): payload is ResponseItemPayload {
  if (!isRecord(payload) || typeof payload.type !== "string") return false;
  return (
    payload.type === "message" ||
    payload.type === "reasoning" ||
    payload.type === "custom_tool_call" ||
    payload.type === "function_call" ||
    payload.type === "custom_tool_call_output" ||
    payload.type === "function_call_output"
  );
}

function isEventMsgPayload(payload: unknown): payload is EventMsgPayload {
  return isRecord(payload) && typeof payload.type === "string";
}

function withTimestamp<T extends { type: string }>(
  record: T,
  timestamp: string | undefined
): T | (T & { timestamp: string }) {
  return timestamp === undefined ? record : { ...record, timestamp };
}

function parseRolloutPayload(raw: unknown): RolloutPayload | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  const timestamp =
    typeof raw.timestamp === "string" ? raw.timestamp : undefined;
  switch (raw.type) {
    case "session_meta": {
      const payload = isRecord(raw.payload)
        ? parseSessionMetaPayload(raw.payload)
        : undefined;
      return withTimestamp(
        {
          type: "session_meta",
          ...(payload === undefined ? {} : { payload })
        },
        timestamp
      );
    }
    case "turn_context": {
      const payload = isRecord(raw.payload)
        ? parseTurnContextPayload(raw.payload)
        : undefined;
      return withTimestamp(
        {
          type: "turn_context",
          ...(payload === undefined ? {} : { payload })
        },
        timestamp
      );
    }
    case "response_item": {
      const payload = parseResponseItemPayload(raw.payload);
      return withTimestamp(
        {
          type: "response_item",
          ...(payload === null ? {} : { payload })
        },
        timestamp
      );
    }
    case "event_msg": {
      const payload = parseEventMsgPayload(raw.payload);
      return withTimestamp(
        {
          type: "event_msg",
          ...(payload === null ? {} : { payload })
        },
        timestamp
      );
    }
    default: {
      const payload = isRecord(raw.payload) ? raw.payload : undefined;
      return withTimestamp(
        {
          type: raw.type,
          ...(payload === undefined ? {} : { payload })
        },
        timestamp
      );
    }
  }
}

function parseRouterEvent(raw: unknown): RouterEventFields | null {
  if (!isRecord(raw)) return null;
  const result: RouterEventFields = {};
  if (typeof raw.requestId === "string") result.requestId = raw.requestId;
  if (typeof raw.thread === "string") result.thread = raw.thread;
  if (typeof raw.phase === "string") result.phase = raw.phase;
  if (typeof raw.role === "string") result.role = raw.role;
  if (typeof raw.requestedModel === "string")
    result.requestedModel = raw.requestedModel;
  if (typeof raw.provider === "string") result.provider = raw.provider;
  if (typeof raw.model === "string") result.model = raw.model;
  if (typeof raw.outcome === "string") result.outcome = raw.outcome;
  if (typeof raw.status === "number") result.status = raw.status;
  if (typeof raw.failureClass === "string")
    result.failureClass = raw.failureClass;
  if (typeof raw.reason === "string") result.reason = raw.reason;
  if (typeof raw.spawnFailureReason === "string")
    result.spawnFailureReason = raw.spawnFailureReason;
  if (typeof raw.denialReason === "string")
    result.denialReason = raw.denialReason;
  if (typeof raw.elapsedMs === "number") result.elapsedMs = raw.elapsedMs;
  if (typeof raw.toolCalls === "number") result.toolCalls = raw.toolCalls;
  if (typeof raw.selection === "string") result.selection = raw.selection;
  if (typeof raw.errorName === "string") result.errorName = raw.errorName;
  if (typeof raw.errorCode === "string") result.errorCode = raw.errorCode;
  return result;
}

function parseRouterAgentStatus(raw: unknown): RouterAgentStatus | null {
  if (!isRecord(raw)) return null;
  const result: RouterAgentStatus = {};
  if (typeof raw.canonicalLiveCount === "number") {
    result.canonicalLiveCount = raw.canonicalLiveCount;
  }
  if (isRecord(raw.byState)) {
    const byState: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.byState)) {
      if (typeof v === "number") byState[k] = v;
    }
    result.byState = byState;
  }
  if (isRecord(raw.liveByRole)) {
    const liveByRole: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.liveByRole)) {
      if (typeof v === "number") liveByRole[k] = v;
    }
    result.liveByRole = liveByRole;
  }
  return result;
}

function parseRouterStatus(raw: unknown): RouterStatusBody | null {
  if (!isRecord(raw)) return null;
  const result: RouterStatusBody = {};
  if (typeof raw.startedAt === "string") {
    result.startedAt = raw.startedAt;
  }
  if (isRecord(raw.agents)) {
    const agents = parseRouterAgentStatus(raw.agents);
    if (agents) result.agents = agents;
  }
  if (isRecord(raw.providers)) {
    const providers: Record<string, JsonRecord> = {};
    for (const [k, v] of Object.entries(raw.providers)) {
      if (isRecord(v)) providers[k] = v;
    }
    result.providers = providers;
  }
  if (isRecord(raw.usage)) {
    result.usage = raw.usage;
  }
  return result;
}

const COLLATOR = new Intl.Collator();
const TASK_OR_TURN_REGEX = /task_|turn_/;
const TIMESTAMP_REGEX = /"timestamp":"([^"]+)"/;
const ACTIVE_PROCESS_REGEX =
  /\/claude -p|\bagy\b.* -p|\bcopilot\b.* -p|codex-tools-shim|spawn-shim|lsp-mcp-server|typescript-language-server/;
const WHITESPACE_SPLIT_REGEX = /\s+/;
const SERVICE_PROCESS_REGEX =
  /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+\S*node\S*\s+(\S*(?:router\/server|providers\/\w+)\.ts)/;
const DIGITS_ONLY_REGEX = /^\d+$/;

export type ToolFailureCategory =
  | "pretooluse-hook"
  | "json-wrap-syntax"
  | "syntax-error"
  | "apply-patch"
  | "spawn-limit"
  | "delegation-unavailable"
  | "missing-tool"
  | "transport-closed"
  | "aborted"
  | "other";

export interface TraceOptions {
  id: string;
  codexHome: string;
  routerLog: string;
  items: boolean;
  events?: boolean;
  failures?: boolean;
  allFailures?: boolean;
  efficiency?: boolean;
  /** Skip everything that reads live state: processes, the router, deployed files. */
  offline: boolean;
  routerUrl?: string;
  repoRoot?: string | null;
}

export interface ToolFailure {
  at: string;
  tool: string;
  callId: string;
  detail: string;
  category?: ToolFailureCategory;
  input?: string;
}

export interface ThreadAnomalies {
  tagOnlyMessages: number;
  samples: string[];
}

export interface ThreadTokenUsage {
  observed: boolean;
  samples: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cacheHitPct: number | null;
  reasoningPct: number | null;
  peakInputTokens: number;
  cacheDrops: number;
}

export interface ThreadCompactionSummary {
  count: number;
  contextCompactedEvents: number;
  maxReplacementItems: number;
  maxReplacementBytes: number;
  maxReplacementImages: number;
  responseImageItems: number;
}

export interface ThreadPromptOverhead {
  initialDeveloperBytes: number;
  skillsCatalogBytes: number;
  skillsLoaded: number;
  skillsByRoot: Record<string, number>;
  skillsRead: string[];
  skillTelemetryReads: number | null;
}

export interface ThreadEfficiency {
  tokens: ThreadTokenUsage;
  compaction: ThreadCompactionSummary;
  prompt: ThreadPromptOverhead;
}

export interface ThreadTrace {
  id: string;
  sessionId: string | null;
  parentId: string | null;
  nickname: string | null;
  role: string | null;
  model: string | null;
  modelProvider: string | null;
  cliVersion: string | null;
  cwd: string | null;
  file: string;
  start: string | null;
  end: string | null;
  counts: Record<string, number>;
  turns: Array<{
    turnId: string;
    started: string | null;
    ended: string | null;
    outcome: string;
    detail: string | null;
  }>;
  gaps: Array<{ seconds: number; after: string; before: string; at: string }>;
  /** Calls by tool; MCP tools are keyed `mcp__<server>__<tool>`, wherever they were called from. */
  tools: Record<string, number>;
  toolFailures: ToolFailure[];
  anomalies?: ThreadAnomalies;
  efficiency?: ThreadEfficiency;
  investigation: Investigation;
  items?: Array<{ at: string; kind: string; detail: string }>;
}

/**
 * How much the thread investigated before it first changed a file, from
 * Codex's structured `item_completed` records. Every count stops at the first
 * FileChange item; a thread that never edited counts the whole thread.
 */
export interface Investigation {
  /** False when the rollout has no item_completed records: the counts are unknown, not zero. */
  observed: boolean;
  firstEditAt: string | null;
  /** Completed tool items: shell commands, MCP calls, agent calls, image views. */
  toolCalls: number;
  /** Total tokens used by the last token_count before the first edit; null when none reported usage. */
  tokens: number | null;
  filesRead: number;
  repeatedReads: number;
  searches: number;
  repeatedSearches: number;
  /** MCP calls to the codebase-context servers. */
  context: { ccc: number; cgc: number; lsp: number };
}

export interface RouterEventRow {
  at: string;
  requestId: string;
  thread: string | null;
  phase: string;
  role: string | null;
  requestedModel: string | null;
  provider: string | null;
  model: string | null;
  outcome: string | null;
  status: number | null;
  failureClass: string | null;
  reason?: string | null;
  spawnFailureReason: string | null;
  denialReason: string | null;
  elapsedMs: number | null;
  toolCalls: number | null;
  selection: string | null;
  errorName?: string | null;
  errorCode?: string | null;
}

export interface RouterSkippedEvent {
  at: string;
  requestId: string;
  provider: string | null;
  reason: string;
  elapsedMs: number | null;
}

export interface RouterSummary {
  thread: string;
  model: string | null;
  /** `thread`: every matched event names the thread. `model-window`: some are older events matched by model and time, so same-model threads may interleave. */
  matchedBy: "thread" | "model-window";
  requests: number;
  byProvider: Record<
    string,
    { requests: number; failures: number; elapsedMs: number; toolCalls: number }
  >;
  failures: Array<{
    at: string;
    requestId: string;
    provider: string | null;
    status: number | null;
    failureClass: string | null;
    spawnFailureReason?: string | null;
    elapsedMs: number | null;
  }>;
  /** Providers in request order, collapsed: a turn that hops providers shows more than one. */
  providerSequence: string[];
  skipped?: RouterSkippedEvent[];
  retries?: number;
  exhaustionWaits?: { count: number; totalMs: number };
  transportErrors?: number;
  events?: RouterEventRow[];
}

export interface HookDenialSummary {
  logFile: string;
  sinceDays: number;
  cutoff: string;
  totalLines: number;
  userPromptSubmits: number;
  preToolUseDenials: number;
  byPolicy: Record<string, number>;
  byRole: Record<string, number>;
  byReason: Array<{ reason: string; count: number }>;
  topCommands: Array<{ commandHead: string; policy: string; count: number }>;
}

export interface FleetSessionRow {
  id: string;
  started: string;
  lastWrite: string;
  cwd: string | null;
  threads: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheHitPct: number | null;
  cacheDrops: number;
  compactions: number;
  maxSkillsLoaded: number;
  toolFailures: number;
  preToolUseBlocks: number;
  topFailureCategory: ToolFailureCategory | null;
  routerRequests: number;
  routerFailures: number;
  routerSkipped: Record<string, number>;
  providers: Record<string, number>;
}

export interface FleetScanReport {
  limit: number;
  sessions: FleetSessionRow[];
  totals: {
    sessions: number;
    threads: number;
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheHitPct: number | null;
    cacheDrops: number;
    compactions: number;
    toolFailuresByCategory: Record<string, number>;
    preToolUseReasons: Array<{ reason: string; count: number }>;
    routerSkippedByReason: Array<{ key: string; count: number }>;
  };
}

export interface LiveReport {
  router: {
    reachable: boolean;
    canonicalLiveCount: number | null;
    byState: JsonRecord | null;
    liveByRole: JsonRecord | null;
    startedAt: string | null;
  };
  /** Recently written threads whose latest turn has not ended: the agents actually live. */
  openThreads: Array<{ id: string; modified: string }>;
  processes: string[];
  services: Array<{ pid: string; started: string; script: string }>;
  drift: { checked: number; differing: string[]; missing: string[] } | null;
}

export interface BridgeLogAlert {
  file: string;
  count: number;
  samples: string[];
}

export interface EfficiencyWorkspaceMcpSummary {
  workspace: string;
  exposed: Record<string, number>;
  used: Record<string, number>;
  topTools: Array<{ tool: string; ok: number; error: number }>;
}

export interface EfficiencySummary {
  disabledProviders: string[];
  nullRoleModels: string[];
  providerLastFailures?: Array<{
    provider: string;
    status: string | null;
    cooldownKind: string | null;
    lastFailureClass: string | null;
    lastFailureStatus: number | null;
  }>;
  workspaces?: EfficiencyWorkspaceMcpSummary[];
}

export interface TraceReport {
  threads: ThreadTrace[];
  router: RouterSummary[];
  logs: Array<{ file: string; modified: string; bytes: number }>;
  bridgeAlerts?: BridgeLogAlert[];
  live: LiveReport | null;
  efficiency?: EfficiencySummary;
}

const EXCERPT = 160;
const FAILURE_EXCERPT = 400;
const FAILURE_PREVIEW_INPUT_EXCERPT = 180;
const FAILURE_CAP_PER_CATEGORY = 2;
const CACHE_DROP_MIN_INPUT = 10_000;
const CACHE_DROP_THRESHOLD = 0.5;
const MS_PER_DAY = 86_400_000;
/** Codebase-context MCP servers, as the target state names them. */
const CONTEXT_SERVERS: Record<string, keyof Investigation["context"]> = {
  "cocoindex-code": "ccc",
  codegraphcontext: "cgc",
  lsp: "lsp"
};
/** item_completed kinds that are not tool calls. */
const NON_TOOL_ITEMS = new Set([
  "UserMessage",
  "AgentMessage",
  "Reasoning",
  "FileChange"
]);
const GAP_SECONDS = 60;
const WRITING_WINDOW_MS = 10 * 60 * 1000;
// Outputs that mean the call did not do its job. `Transport closed` is an MCP
// server process that died; `aborted` is Codex cutting the call short.
const TOOL_FAILURE =
  /Encountered error in tool execution|Delegation is unavailable|tool call failed|Transport closed|Command blocked by PreToolUse hook|Script failed|Script error|^aborted|No such tool|not found in ALL_TOOLS/im;
const BRIDGE_LOG_ALERT_REGEX =
  /spawn rejected|missing session header|invalid model selection|Delegation is unavailable|ERR_PACKAGE_PATH_NOT_EXPORTED|earlier message\(s\) left out/;
const TAG_ONLY_ASSISTANT_MESSAGE_REGEX =
  /^<([a-z][a-z0-9_-]*)>\s*<\/([a-z][a-z0-9_-]*)>$/iu;
const SKILLS_INSTRUCTIONS_REGEX =
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/u;
const SKILL_CATALOG_LINE_REGEX =
  /^- ([A-Za-z0-9_.-]+): [^\n]*\(file:[ \t]*(\S[^)\n]*\/SKILL\.md)\)[ \t]*$/gmu;
const SKILL_READ_FILE_REGEX = /([A-Za-z0-9_.-]+)\/SKILL\.md\b/gu;
const PRETOOLUSE_MARKER = "Command blocked by PreToolUse hook:";
const PRETOOLUSE_HINT_SUFFIX_REGEX =
  /[ \t]+(?:Work from|Use |Delegate |Call |Allowed:|Tip:)/u;
const BRIDGE_LOG_TAIL_BYTES = 64 * 1024;
const UNKNOWN_LABEL = "unknown";
const BYTES_PER_MIB = 1_048_576;

function excerpt(value: unknown, maxLen = EXCERPT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output))
    return output
      .map((part: unknown) =>
        typeof part === "string"
          ? part
          : isRecord(part) && typeof part.text === "string"
            ? part.text
            : ""
      )
      .join("\n");
  return JSON.stringify(output ?? "");
}

function readJsonl(file: string): RolloutPayload[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        const validated = parseRolloutPayload(parsed);
        return validated ? [validated] : [];
      } catch {
        return [];
      }
    });
}

/** The session_meta line, read without loading the whole rollout (they reach tens of MB). */
function firstLine(file: string): { payload?: SessionMetaPayload } | null {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(65_536);
    for (let total = 0; total < 4 * 1024 * 1024;) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      chunks.push(
        Buffer.from(buffer.subarray(0, newline === -1 ? read : newline))
      );
      if (newline !== -1) break;
      total += read;
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(parsed)) return null;
    const payload = isRecord(parsed.payload)
      ? parseSessionMetaPayload(parsed.payload)
      : undefined;
    return {
      ...(payload === undefined ? {} : { payload })
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      )
        files.push(filePath);
    }
  };
  if (existsSync(root)) visit(root);
  return files.sort();
}

/**
 * Where rollouts live. The Codex app archives a session by moving its rollout
 * out of `sessions/` and into `archived_sessions/`, so a session the user has
 * archived is still worth reading -- but a search of `sessions/` alone reports
 * "no rollout found" for exactly the sessions someone has finished with.
 */
export function rolloutRoots(codexHome: string): string[] {
  return [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions")
  ];
}

/**
 * Rollouts belonging to the id: the thread itself, plus -- whether the id names
 * a session or a thread -- every thread sharing its session. Newest files are
 * checked first because a debugged session is almost always recent.
 */
export function findSessionRollouts(
  sessionsRoot: string | string[],
  id: string
): string[] {
  const roots = Array.isArray(sessionsRoot) ? sessionsRoot : [sessionsRoot];
  const files = roots.flatMap((root) => rolloutFiles(root)).reverse();
  const direct = files.filter((file) => file.includes(id));
  const sessionIds = new Set<string>([id]);
  for (const file of direct) {
    const meta = firstLine(file)?.payload;
    if (typeof meta?.session_id === "string") sessionIds.add(meta.session_id);
  }
  const matched = new Set(direct);
  for (const file of files) {
    if (matched.has(file)) continue;
    const meta = firstLine(file)?.payload;
    if (
      meta &&
      ((typeof meta.session_id === "string" &&
        sessionIds.has(meta.session_id)) ||
        (typeof meta.parent_thread_id === "string" &&
          sessionIds.has(meta.parent_thread_id)))
    )
      matched.add(file);
  }
  return [...matched].sort();
}

export interface RecentSession {
  id: string;
  started: string;
  lastWrite: string;
  threads: number;
  cwd: string | null;
}

function addRecentSession(
  sessions: Map<string, RecentSession>,
  file: string,
  meta: SessionMetaPayload
): void {
  const sessionId =
    typeof meta.session_id === "string"
      ? meta.session_id
      : typeof meta.id === "string"
        ? meta.id
        : "";
  if (!sessionId) return;
  const modified = statSync(file).mtime.toISOString();
  const entry = sessions.get(sessionId) ?? {
    id: sessionId,
    started: typeof meta.timestamp === "string" ? meta.timestamp : "",
    lastWrite: modified,
    threads: 0,
    cwd: typeof meta.cwd === "string" ? meta.cwd : null
  };
  entry.threads += 1;
  if (modified > entry.lastWrite) entry.lastWrite = modified;
  if (meta.id === sessionId) {
    if (typeof meta.timestamp === "string") entry.started = meta.timestamp;
    if (typeof meta.cwd === "string") entry.cwd = meta.cwd;
  }
  sessions.set(sessionId, entry);
}

/** The newest root sessions across one or more rollout roots, for when the user names none. */
export function recentSessions(
  sessionsRoot: string | string[],
  limit: number
): RecentSession[] {
  const roots = Array.isArray(sessionsRoot) ? sessionsRoot : [sessionsRoot];
  const files = roots
    .flatMap((root) => rolloutFiles(root))
    .sort((a, b) => COLLATOR.compare(path.basename(b), path.basename(a)))
    .slice(0, 600);
  const sessions = new Map<string, RecentSession>();
  for (const file of files) {
    const meta = firstLine(file)?.payload;
    if (meta) addRecentSession(sessions, file, meta);
  }
  return [...sessions.values()]
    .sort((a, b) => COLLATOR.compare(b.lastWrite, a.lastWrite))
    .slice(0, limit);
}

function itemDetail(payload: ResponseItemPayload | JsonRecord): string {
  switch (payload.type) {
    case "message": {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content
        .map((part) =>
          typeof part === "string"
            ? part
            : isRecord(part) && typeof part.text === "string"
              ? part.text
              : ""
        )
        .join(" ");
      const role = typeof payload.role === "string" ? payload.role : "";
      return `${role}: ${excerpt(text)}`;
    }
    case "reasoning": {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = [...summary, ...content]
        .map((part) =>
          typeof part === "string"
            ? part
            : isRecord(part) && typeof part.text === "string"
              ? part.text
              : ""
        )
        .join(" ");
      const id = typeof payload.id === "string" ? payload.id : "-";
      return `id=${id} ${excerpt(text)}`;
    }
    case "custom_tool_call":
    case "function_call": {
      const name = typeof payload.name === "string" ? payload.name : "";
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const id = typeof payload.id === "string" ? payload.id : "-";
      return `${name} call=${callId} id=${id} ${excerpt(payload.input ?? payload.arguments)}`;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      return `call=${callId} ${excerpt(payload.output)}`;
    }
    default: {
      return excerpt(payload);
    }
  }
}

/** Tools a call reached: its own name, plus every `tools.<name>(` an `exec` script calls. */
function toolsOfCall(payload: ResponseItemPayload): string[] {
  if (payload.type !== "custom_tool_call" && payload.type !== "function_call") {
    return [];
  }
  const name = typeof payload.name === "string" ? payload.name : "?";
  if (
    payload.type === "custom_tool_call" &&
    name === "exec" &&
    typeof payload.input === "string"
  ) {
    const nested: string[] = [];
    for (const match of payload.input.matchAll(
      /tools\.([A-Za-z0-9_]+)\s*\(/g
    )) {
      if (match[1]) nested.push(match[1]);
    }
    return nested.length > 0 ? nested : ["exec"];
  }
  return [name];
}

interface TokenAccumulatorState {
  observed: boolean;
  samples: number;
  offsetIn: number;
  offsetCached: number;
  offsetOut: number;
  offsetReas: number;
  offsetTotal: number;
  prevRawIn: number | null;
  prevRawCached: number;
  prevRawOut: number;
  prevRawReas: number;
  prevRawTotal: number | null;
  peakInputTokens: number;
  prevLastInput: number;
  cacheDrops: number;
}

interface CompactionAccumulatorState {
  compactedRecords: number;
  contextCompactedEvents: number;
  maxReplacementItems: number;
  maxReplacementBytes: number;
  maxReplacementImages: number;
  responseImageItems: number;
}

interface PromptAccumulatorState {
  seenAgentOutput: boolean;
  initialDeveloperBytes: number;
  skillsCatalogBytes: number;
  loadedSkills: Set<string>;
  skillsByRoot: Record<string, number>;
  skillsRead: Set<string>;
}

interface ThreadTraceAccumulator {
  counts: Record<string, number>;
  turns: ThreadTrace["turns"];
  open: Map<string, ThreadTrace["turns"][number]>;
  items: NonNullable<ThreadTrace["items"]>;
  gaps: ThreadTrace["gaps"];
  tools: Record<string, number>;
  toolFailures: ToolFailure[];
  callTools: Map<string, string>;
  callInputs: Map<string, string>;
  tagOnlyMessages: number;
  tagOnlySamples: string[];
  previous: { at: string; label: string } | null;
  investigation: Investigation;
  tokenState: TokenAccumulatorState;
  compaction: CompactionAccumulatorState;
  prompt: PromptAccumulatorState;
  cwd: string;
  reads: Set<string>;
  searchKeys: Set<string>;
}

function recordGapAndItems(
  record: RolloutPayload,
  at: string | null,
  payload: ResponseItemPayload | EventMsgPayload | undefined,
  withItems: boolean,
  acc: ThreadTraceAccumulator
): void {
  const isResponse = record.type === "response_item";
  const isTurnishEvent =
    record.type === "event_msg" &&
    payload !== undefined &&
    TASK_OR_TURN_REGEX.test(payload.type);
  if (!isResponse && !isTurnishEvent) return;
  const label = traceItemLabel(payload, isResponse);
  recordTraceGap(at, label, acc);
  if (withItems && isResponse && at && payload)
    acc.items.push({ at, kind: payload.type, detail: itemDetail(payload) });
}

function traceItemLabel(
  payload: ResponseItemPayload | EventMsgPayload | undefined,
  isResponse: boolean
): string {
  if (!payload) return "";
  if (
    isResponse &&
    (payload.type === "custom_tool_call" || payload.type === "function_call")
  )
    return `${payload.type}(${typeof payload.name === "string" ? payload.name : ""})`;
  return payload.type;
}

function recordTraceGap(
  at: string | null,
  label: string,
  acc: ThreadTraceAccumulator
): void {
  if (!at) return;
  if (at && acc.previous && acc.open.size > 0) {
    const seconds = (Date.parse(at) - Date.parse(acc.previous.at)) / 1000;
    if (seconds >= GAP_SECONDS)
      acc.gaps.push({
        seconds: Math.round(seconds),
        after: acc.previous.label,
        before: label,
        at: acc.previous.at
      });
  }
  acc.previous = { at, label };
}

function callInputText(payload: ResponseItemPayload): string | null {
  if (payload.type !== "custom_tool_call" && payload.type !== "function_call")
    return null;
  const raw = payload.input ?? payload.arguments;
  if (raw === undefined || raw === null) return null;
  return excerpt(raw, FAILURE_EXCERPT);
}

function recordTagOnlyAssistantMessage(
  payload: ResponseItemPayload,
  acc: ThreadTraceAccumulator
): void {
  if (payload.type !== "message" || payload.role !== "assistant") return;
  const text = (payload.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
  const match = TAG_ONLY_ASSISTANT_MESSAGE_REGEX.exec(text);
  if (!match || match[1]?.toLowerCase() !== match[2]?.toLowerCase()) return;
  acc.tagOnlyMessages += 1;
  if (acc.tagOnlySamples.length < 3 && !acc.tagOnlySamples.includes(text)) {
    acc.tagOnlySamples.push(text);
  }
}

const SYNTAX_COLON_REGEX = /SyntaxError: Unexpected token ':'/i;

const FAILURE_CATEGORY_RULES: ReadonlyArray<
  readonly [ToolFailureCategory, RegExp]
> = [
  ["pretooluse-hook", /Command blocked by PreToolUse hook:/i],
  ["delegation-unavailable", /Delegation is unavailable/i],
  ["spawn-limit", /agent thread limit reached|collab spawn failed/i],
  ["apply-patch", /apply_patch verification failed/i],
  ["syntax-error", /SyntaxError:/i],
  ["missing-tool", /is not a function|No such tool|not found in ALL_TOOLS/i],
  ["transport-closed", /Transport closed/i],
  ["aborted", /^aborted/i]
];

function classifyToolFailure(
  detail: string,
  input: string | undefined
): ToolFailureCategory {
  if (SYNTAX_COLON_REGEX.test(detail)) {
    return input?.trimStart().startsWith("{")
      ? "json-wrap-syntax"
      : "syntax-error";
  }
  for (const [category, pattern] of FAILURE_CATEGORY_RULES) {
    if (pattern.test(detail)) return category;
  }
  return "other";
}

function recordToolCallOutput(
  at: string | null,
  payload: Extract<
    ResponseItemPayload,
    { type: "custom_tool_call_output" | "function_call_output" }
  >,
  acc: ThreadTraceAccumulator
): void {
  const text = outputText(payload.output);
  const failure = TOOL_FAILURE.exec(text);
  if (!failure) return;
  const callId = typeof payload.call_id === "string" ? payload.call_id : "";
  const input = callId ? acc.callInputs.get(callId) : undefined;
  const detail = excerpt(text.slice(Math.max(0, failure.index - 40)));
  acc.toolFailures.push({
    at: at ?? "",
    tool: (callId && acc.callTools.get(callId)) || "?",
    callId,
    detail,
    category: classifyToolFailure(detail, input),
    ...(input ? { input } : {})
  });
}

function rawCallArgumentText(
  payload: Extract<
    ResponseItemPayload,
    { type: "custom_tool_call" | "function_call" }
  >
): string {
  const raw = payload.input ?? payload.arguments;
  if (typeof raw === "string") return raw;
  return raw === undefined || raw === null ? "" : JSON.stringify(raw);
}

function recordPromptSkillReads(
  payload: Extract<
    ResponseItemPayload,
    { type: "custom_tool_call" | "function_call" }
  >,
  acc: ThreadTraceAccumulator
): void {
  const raw = rawCallArgumentText(payload);
  if (!raw.includes("SKILL.md")) return;
  for (const match of raw.matchAll(SKILL_READ_FILE_REGEX)) {
    if (match[1]) acc.prompt.skillsRead.add(match[1]);
  }
}

function countImageObjects(root: unknown): number {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (!isRecord(current)) continue;
    if (
      current.type === "input_image" ||
      ("image_url" in current &&
        current.image_url !== null &&
        current.image_url !== undefined)
    ) {
      count += 1;
    }
    for (const value of Object.values(current)) {
      if (typeof value === "object" && value !== null) stack.push(value);
    }
  }
  return count;
}

function normalizeSkillRoot(skillFilePath: string, cwd: string): string {
  const rootDir = path.dirname(path.dirname(skillFilePath));
  if (
    cwd !== "/" &&
    (rootDir === cwd || rootDir.startsWith(`${cwd}${path.sep}`))
  )
    return `<repo>${rootDir.slice(cwd.length)}`;
  const home = homedir();
  if (home && (rootDir === home || rootDir.startsWith(`${home}${path.sep}`)))
    return `~${rootDir.slice(home.length)}`;
  return rootDir;
}

function recordInitialDeveloperPrompt(
  payload: Extract<ResponseItemPayload, { type: "message" }>,
  acc: ThreadTraceAccumulator
): void {
  if (acc.prompt.seenAgentOutput || payload.role !== "developer") return;
  const text = (payload.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
  if (!text) return;
  acc.prompt.initialDeveloperBytes += Buffer.byteLength(text, "utf8");
  const skillsBlock = SKILLS_INSTRUCTIONS_REGEX.exec(text);
  if (skillsBlock) {
    acc.prompt.skillsCatalogBytes += Buffer.byteLength(skillsBlock[0], "utf8");
  }
  for (const match of text.matchAll(SKILL_CATALOG_LINE_REGEX)) {
    const name = match[1];
    const skillPath = match[2];
    if (!name || !skillPath || acc.prompt.loadedSkills.has(name)) continue;
    acc.prompt.loadedSkills.add(name);
    const root = normalizeSkillRoot(skillPath, acc.cwd);
    acc.prompt.skillsByRoot[root] = (acc.prompt.skillsByRoot[root] ?? 0) + 1;
  }
}

function recordToolUsage(
  record: RolloutPayload,
  at: string | null,
  payload: ResponseItemPayload | undefined,
  acc: ThreadTraceAccumulator
): void {
  if (record.type !== "response_item") return;
  if (record.payload && countImageObjects(record.payload) > 0) {
    acc.compaction.responseImageItems += 1;
  }
  if (!payload) return;
  if (payload.type === "message") {
    recordInitialDeveloperPrompt(payload, acc);
    if (payload.role === "assistant") acc.prompt.seenAgentOutput = true;
    recordTagOnlyAssistantMessage(payload, acc);
    return;
  }
  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    acc.prompt.seenAgentOutput = true;
    recordPromptSkillReads(payload, acc);
    const reached = toolsOfCall(payload);
    for (const tool of reached) acc.tools[tool] = (acc.tools[tool] ?? 0) + 1;
    if (typeof payload.call_id !== "string") return;
    acc.callTools.set(payload.call_id, reached.join("+"));
    const rawInput = callInputText(payload);
    if (rawInput) acc.callInputs.set(payload.call_id, rawInput);
    return;
  }
  if (
    payload.type === "custom_tool_call_output" ||
    payload.type === "function_call_output"
  ) {
    recordToolCallOutput(at, payload, acc);
  }
}

function recordReadInvestigation(
  cwd: string,
  sourcePath: string,
  acc: ThreadTraceAccumulator
): void {
  const file = path.resolve(cwd, sourcePath);
  if (acc.reads.has(file)) acc.investigation.repeatedReads += 1;
  acc.reads.add(file);
  acc.investigation.filesRead = acc.reads.size;
}

function recordSearchInvestigation(
  cwd: string,
  query: string,
  sourcePath: string,
  acc: ThreadTraceAccumulator
): void {
  const key = `${query}\0${path.resolve(cwd, sourcePath)}`;
  acc.investigation.searches += 1;
  if (acc.searchKeys.has(key)) acc.investigation.repeatedSearches += 1;
  acc.searchKeys.add(key);
}

function recordCommandInvestigation(
  item: JsonRecord,
  acc: ThreadTraceAccumulator
): void {
  const cwd = typeof item.cwd === "string" ? item.cwd : acc.cwd;
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    if (entry.type === "read" && typeof entry.path === "string") {
      recordReadInvestigation(cwd, entry.path, acc);
    } else if (entry.type === "search") {
      const query = typeof entry.query === "string" ? entry.query : "";
      const searchPath = typeof entry.path === "string" ? entry.path : ".";
      recordSearchInvestigation(cwd, query, searchPath, acc);
    }
  }
}

function recordInvestigation(
  record: RolloutPayload,
  at: string | null,
  payload: JsonRecord,
  acc: ThreadTraceAccumulator
): void {
  if (record.type !== "event_msg") return;
  const investigation = acc.investigation;
  if (investigation.firstEditAt !== null) return;
  if (payload.type === "token_count") {
    const info = isRecord(payload.info) ? payload.info : undefined;
    const usage = isRecord(info?.total_token_usage)
      ? info.total_token_usage
      : undefined;
    // A provider that reports no usage leaves every total at 0: unknown, not zero.
    if (typeof usage?.total_tokens === "number" && usage.total_tokens > 0)
      investigation.tokens = usage.total_tokens;
    return;
  }
  if (payload.type !== "item_completed") return;
  const item = isRecord(payload.item) ? payload.item : {};
  const kind = typeof item.type === "string" ? item.type : "";
  investigation.observed = true;
  if (kind === "FileChange") {
    investigation.firstEditAt = at ?? "";
    return;
  }
  if (NON_TOOL_ITEMS.has(kind)) return;
  investigation.toolCalls += 1;
  if (kind === "CommandExecution") recordCommandInvestigation(item, acc);
  else if (kind === "McpToolCall" && typeof item.server === "string") {
    const server = CONTEXT_SERVERS[item.server];
    if (server) investigation.context[server] += 1;
  }
}

function turnOutcome(payload: EventMsgPayload): string {
  if (payload.type === "turn_aborted")
    return `aborted:${typeof payload.reason === "string" ? payload.reason : "?"}`;
  return payload.error === undefined ? "completed" : "failed";
}

function turnDetail(payload: EventMsgPayload): string | null {
  if (payload.error !== undefined) {
    const message =
      isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : payload.error;
    return excerpt(message);
  }
  return typeof payload.last_agent_message === "string"
    ? excerpt(payload.last_agent_message)
    : null;
}

function recordStartedTurn(
  at: string | null,
  payload: EventMsgPayload,
  acc: ThreadTraceAccumulator
): void {
  if (payload.type !== "task_started") return;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
  const turn = {
    turnId,
    started: at,
    ended: null,
    outcome: "running",
    detail: null
  };
  acc.open.set(turnId, turn);
  acc.turns.push(turn);
}

function recordCompletedTurn(
  at: string | null,
  payload: EventMsgPayload,
  acc: ThreadTraceAccumulator
): void {
  if (payload.type !== "task_complete" && payload.type !== "turn_aborted")
    return;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
  const turn = acc.open.get(turnId);
  if (!turn) return;
  turn.ended = at;
  turn.outcome = turnOutcome(payload);
  turn.detail = turnDetail(payload);
  acc.open.delete(turnId);
}

function recordTurnEvent(
  record: RolloutPayload,
  at: string | null,
  payload: EventMsgPayload | undefined,
  acc: ThreadTraceAccumulator
): void {
  if (record.type !== "event_msg" || !payload) return;
  recordStartedTurn(at, payload, acc);
  recordCompletedTurn(at, payload, acc);
}

function traceMetadata(records: RolloutPayload[]): {
  meta: SessionMetaPayload;
  context: TurnContextPayload;
} {
  const meta = records.find(
    (record): record is Extract<RolloutPayload, { type: "session_meta" }> =>
      record.type === "session_meta"
  )?.payload;
  const context = records.find(
    (record): record is Extract<RolloutPayload, { type: "turn_context" }> =>
      record.type === "turn_context"
  )?.payload;
  return { meta: meta ?? {}, context: context ?? {} };
}

function finiteNonNegative(record: JsonRecord | null, key: string): number {
  if (!record) return 0;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function recordTokenEfficiency(
  payload: JsonRecord,
  acc: ThreadTraceAccumulator
): void {
  if (payload.type !== "token_count" || !isRecord(payload.info)) return;
  const total = isRecord(payload.info.total_token_usage)
    ? payload.info.total_token_usage
    : null;
  const rawTotal = finiteNonNegative(total, "total_tokens");
  if (rawTotal <= 0) return;

  const rawIn = finiteNonNegative(total, "input_tokens");
  const rawCached = finiteNonNegative(total, "cached_input_tokens");
  const rawOut = finiteNonNegative(total, "output_tokens");
  const rawReas = finiteNonNegative(total, "reasoning_output_tokens");
  const t = acc.tokenState;
  if (t.prevRawTotal === rawTotal && t.prevRawIn === rawIn) return;
  if (t.prevRawTotal !== null && rawTotal < t.prevRawTotal) {
    t.offsetIn += t.prevRawIn ?? 0;
    t.offsetCached += t.prevRawCached;
    t.offsetOut += t.prevRawOut;
    t.offsetReas += t.prevRawReas;
    t.offsetTotal += t.prevRawTotal;
    t.prevLastInput = 0;
  }
  t.prevRawIn = rawIn;
  t.prevRawCached = rawCached;
  t.prevRawOut = rawOut;
  t.prevRawReas = rawReas;
  t.prevRawTotal = rawTotal;
  t.observed = true;
  t.samples += 1;

  const last = isRecord(payload.info.last_token_usage)
    ? payload.info.last_token_usage
    : null;
  const lastIn = finiteNonNegative(last, "input_tokens");
  const lastCached = finiteNonNegative(last, "cached_input_tokens");
  if (lastIn > t.peakInputTokens) t.peakInputTokens = lastIn;
  if (
    t.prevLastInput >= CACHE_DROP_MIN_INPUT &&
    lastIn >= CACHE_DROP_MIN_INPUT &&
    lastCached < Math.min(t.prevLastInput, lastIn) * CACHE_DROP_THRESHOLD
  ) {
    t.cacheDrops += 1;
  }
  if (lastIn > 0) t.prevLastInput = lastIn;
}

function recordCompactionRecord(
  record: RolloutPayload,
  acc: ThreadTraceAccumulator
): void {
  if (record.type === "compacted") {
    acc.compaction.compactedRecords += 1;
    const rh =
      isRecord(record.payload) &&
      Array.isArray(record.payload.replacement_history)
        ? record.payload.replacement_history
        : null;
    if (!rh) return;
    const serializedBytes = Buffer.byteLength(JSON.stringify(rh), "utf8");
    const imageCount = countImageObjects(rh);
    acc.compaction.maxReplacementItems = Math.max(
      acc.compaction.maxReplacementItems,
      rh.length
    );
    acc.compaction.maxReplacementBytes = Math.max(
      acc.compaction.maxReplacementBytes,
      serializedBytes
    );
    acc.compaction.maxReplacementImages = Math.max(
      acc.compaction.maxReplacementImages,
      imageCount
    );
    return;
  }
  if (
    record.type === "event_msg" &&
    isRecord(record.payload) &&
    record.payload.type === "context_compacted"
  ) {
    acc.compaction.contextCompactedEvents += 1;
  }
}

function createTraceAccumulator(
  meta: SessionMetaPayload
): ThreadTraceAccumulator {
  return {
    counts: {},
    turns: [],
    open: new Map(),
    items: [],
    gaps: [],
    tools: {},
    toolFailures: [],
    callTools: new Map(),
    callInputs: new Map(),
    tagOnlyMessages: 0,
    tagOnlySamples: [],
    previous: null,
    investigation: {
      observed: false,
      firstEditAt: null,
      toolCalls: 0,
      tokens: null,
      filesRead: 0,
      repeatedReads: 0,
      searches: 0,
      repeatedSearches: 0,
      context: { ccc: 0, cgc: 0, lsp: 0 }
    },
    tokenState: {
      observed: false,
      samples: 0,
      offsetIn: 0,
      offsetCached: 0,
      offsetOut: 0,
      offsetReas: 0,
      offsetTotal: 0,
      prevRawIn: null,
      prevRawCached: 0,
      prevRawOut: 0,
      prevRawReas: 0,
      prevRawTotal: null,
      peakInputTokens: 0,
      prevLastInput: 0,
      cacheDrops: 0
    },
    compaction: {
      compactedRecords: 0,
      contextCompactedEvents: 0,
      maxReplacementItems: 0,
      maxReplacementBytes: 0,
      maxReplacementImages: 0,
      responseImageItems: 0
    },
    prompt: {
      seenAgentOutput: false,
      initialDeveloperBytes: 0,
      skillsCatalogBytes: 0,
      loadedSkills: new Set(),
      skillsByRoot: {},
      skillsRead: new Set()
    },
    cwd: typeof meta.cwd === "string" ? meta.cwd : "/",
    reads: new Set(),
    searchKeys: new Set()
  };
}

function incrementCount(acc: ThreadTraceAccumulator, key: string): void {
  acc.counts[key] = (acc.counts[key] ?? 0) + 1;
}

function accumulateTraceRecord(
  record: RolloutPayload,
  withItems: boolean,
  acc: ThreadTraceAccumulator
): void {
  const at = typeof record.timestamp === "string" ? record.timestamp : null;
  recordCompactionRecord(record, acc);
  if (record.type === "response_item") {
    const payload = isResponseItemPayload(record.payload)
      ? record.payload
      : undefined;
    incrementCount(acc, `response_item:${payload?.type ?? ""}`);
    recordGapAndItems(record, at, payload, withItems, acc);
    recordToolUsage(record, at, payload, acc);
    return;
  }
  if (record.type === "event_msg") {
    const payload = isEventMsgPayload(record.payload)
      ? record.payload
      : undefined;
    incrementCount(acc, `event_msg:${payload?.type ?? ""}`);
    recordGapAndItems(record, at, payload, withItems, acc);
    recordTurnEvent(record, at, payload, acc);
    if (payload) {
      recordTokenEfficiency(payload, acc);
      recordInvestigation(record, at, payload, acc);
    }
    return;
  }
  incrementCount(acc, record.type);
}

function inferCodexHomeFromRolloutPath(file: string): string | null {
  const resolved = path.resolve(file);
  const parts = resolved.split(path.sep);
  const rootIndex = parts.findIndex(
    (segment) => segment === "sessions" || segment === "archived_sessions"
  );
  if (rootIndex <= 0) return null;
  return parts.slice(0, rootIndex).join(path.sep) || path.sep;
}

function collectTelemetryTurnHashes(
  turns: JsonRecord,
  allowedTurnIds: Set<string> | null
): number {
  const hashes = new Set<string>();
  for (const [turnId, rawEntry] of Object.entries(turns)) {
    if (allowedTurnIds && !allowedTurnIds.has(turnId)) continue;
    if (!isRecord(rawEntry) || !Array.isArray(rawEntry.has)) continue;
    for (const hash of rawEntry.has) {
      if (typeof hash === "string" && hash.length > 0) hashes.add(hash);
    }
  }
  return hashes.size;
}

function readSkillTelemetryCount(
  codexHome: string | null,
  threadId: string,
  sessionId: string | null,
  turnIds: string[]
): number | null {
  if (!codexHome) return null;
  const dir = path.join(codexHome, "run", "skill-read-telemetry");
  const candidates: Array<{ file: string; filter: Set<string> | null }> = [
    { file: path.join(dir, `${threadId}.json`), filter: null }
  ];
  if (sessionId && sessionId !== threadId && turnIds.length > 0) {
    candidates.push({
      file: path.join(dir, `${sessionId}.json`),
      filter: new Set(turnIds)
    });
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate.file, "utf8"));
      if (!isRecord(parsed) || !isRecord(parsed.turns)) continue;
      return collectTelemetryTurnHashes(parsed.turns, candidate.filter);
    } catch {
      return null;
    }
  }
  return null;
}

function buildThreadEfficiency(
  acc: ThreadTraceAccumulator,
  codexHome: string | null,
  threadId: string,
  sessionId: string | null
): ThreadEfficiency {
  const t = acc.tokenState;
  const inputTokens = t.offsetIn + (t.prevRawIn ?? 0);
  const cachedInputTokens = t.offsetCached + t.prevRawCached;
  const outputTokens = t.offsetOut + t.prevRawOut;
  const reasoningOutputTokens = t.offsetReas + t.prevRawReas;
  const totalTokens = t.offsetTotal + (t.prevRawTotal ?? 0);
  const c = acc.compaction;
  const p = acc.prompt;
  return {
    tokens: {
      observed: t.observed,
      samples: t.samples,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
      cacheHitPct:
        inputTokens > 0
          ? round1((cachedInputTokens / inputTokens) * 100)
          : null,
      reasoningPct:
        outputTokens > 0
          ? round1((reasoningOutputTokens / outputTokens) * 100)
          : null,
      peakInputTokens: t.peakInputTokens,
      cacheDrops: t.cacheDrops
    },
    compaction: {
      count: Math.max(c.compactedRecords, c.contextCompactedEvents),
      contextCompactedEvents: c.contextCompactedEvents,
      maxReplacementItems: c.maxReplacementItems,
      maxReplacementBytes: c.maxReplacementBytes,
      maxReplacementImages: c.maxReplacementImages,
      responseImageItems: c.responseImageItems
    },
    prompt: {
      initialDeveloperBytes: p.initialDeveloperBytes,
      skillsCatalogBytes: p.skillsCatalogBytes,
      skillsLoaded: p.loadedSkills.size,
      skillsByRoot: p.skillsByRoot,
      skillsRead: [...p.skillsRead].sort(),
      skillTelemetryReads: readSkillTelemetryCount(
        codexHome,
        threadId,
        sessionId,
        acc.turns.map((turn) => turn.turnId).filter(Boolean)
      )
    }
  };
}

function timestampBounds(records: RolloutPayload[]): {
  start: string | null;
  end: string | null;
} {
  const stamps = records
    .map((record) => record.timestamp)
    .filter((value): value is string => typeof value === "string")
    .sort();
  return { start: stamps[0] ?? null, end: stamps.at(-1) ?? null };
}

function buildThreadTrace(
  file: string,
  records: RolloutPayload[],
  meta: SessionMetaPayload,
  context: TurnContextPayload,
  acc: ThreadTraceAccumulator,
  options: { withItems: boolean; codexHome?: string }
): ThreadTrace {
  const {
    counts,
    turns,
    gaps,
    tools,
    toolFailures,
    tagOnlyMessages,
    tagOnlySamples,
    items,
    investigation
  } = acc;
  const { start, end } = timestampBounds(records);
  const id = typeof meta.id === "string" ? meta.id : file;
  const sessionId =
    typeof meta.session_id === "string" ? meta.session_id : null;
  const resolvedHome = options.codexHome ?? inferCodexHomeFromRolloutPath(file);
  return {
    id,
    sessionId,
    parentId:
      typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : null,
    nickname:
      typeof meta.agent_nickname === "string" ? meta.agent_nickname : null,
    role:
      typeof meta.agent_role === "string"
        ? meta.agent_role
        : meta.thread_source === "subagent"
          ? null
          : "root",
    model: typeof context.model === "string" ? context.model : null,
    modelProvider:
      typeof meta.model_provider === "string" ? meta.model_provider : null,
    cliVersion: typeof meta.cli_version === "string" ? meta.cli_version : null,
    cwd: typeof meta.cwd === "string" ? meta.cwd : null,
    file,
    start,
    end,
    counts,
    turns,
    gaps: gaps.sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    tools,
    toolFailures,
    ...(tagOnlyMessages > 0
      ? {
          anomalies: {
            tagOnlyMessages,
            samples: tagOnlySamples
          }
        }
      : {}),
    efficiency: buildThreadEfficiency(acc, resolvedHome, id, sessionId),
    investigation,
    ...(options.withItems ? { items } : {})
  };
}

export function traceThread(
  file: string,
  withItems: boolean,
  codexHome?: string
): ThreadTrace {
  const records = readJsonl(file);
  const { meta, context } = traceMetadata(records);
  const acc = createTraceAccumulator(meta);
  for (const record of records) accumulateTraceRecord(record, withItems, acc);
  return buildThreadTrace(file, records, meta, context, acc, {
    withItems,
    ...(codexHome ? { codexHome } : {})
  });
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Every router event in a time window, read in one pass over the (large) log. */
function routerEventFromLine(
  line: string,
  start: string,
  end: string
): RouterEventRow | null {
  const stamp = TIMESTAMP_REGEX.exec(line)?.[1];
  if (
    !stamp ||
    stamp < start ||
    stamp > end ||
    !line.includes("autodev-router-event-v1")
  )
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = parseRouterEvent(parsed);
  if (!event) return null;
  return {
    at: stamp,
    requestId: strOrNull(event.requestId) ?? "",
    thread: strOrNull(event.thread),
    phase: strOrNull(event.phase) ?? "",
    role: strOrNull(event.role),
    requestedModel: strOrNull(event.requestedModel),
    provider: strOrNull(event.provider),
    model: strOrNull(event.model),
    outcome: strOrNull(event.outcome),
    status: numOrNull(event.status),
    failureClass: strOrNull(event.failureClass),
    ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
    spawnFailureReason: strOrNull(event.spawnFailureReason),
    denialReason: strOrNull(event.denialReason),
    elapsedMs: numOrNull(event.elapsedMs),
    toolCalls: numOrNull(event.toolCalls),
    selection: strOrNull(event.selection),
    ...(typeof event.errorName === "string"
      ? { errorName: event.errorName }
      : {}),
    ...(typeof event.errorCode === "string"
      ? { errorCode: event.errorCode }
      : {})
  };
}

/**
 * Every log that can hold the router's events, newest first.
 *
 * launchd rotates the router's stderr log: the live file becomes empty and
 * the events move to `.err.log.1`, then `.2`, and so on. Reading only the live
 * file therefore reads as "the router saw no request at all" for exactly the
 * sessions that are worth investigating.
 */
export function routerLogFiles(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  const dir = path.dirname(logFile);
  const base = path.basename(logFile);
  const files = [logFile];
  let index = 1;
  for (;;) {
    const rotated = path.join(dir, `${base}.${index}`);
    if (!existsSync(rotated)) break;
    files.push(rotated);
    index += 1;
  }
  return files;
}

export async function routerEvents(
  logFile: string,
  start: string,
  end: string
): Promise<RouterEventRow[]> {
  const rows: RouterEventRow[] = [];
  const files = routerLogFiles(logFile);
  /* eslint-disable no-await-in-loop -- The logs are read one after the other: a rotated log holds the earlier events, and the files are read in order so the rows come out in the order they happened. */
  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      const event = routerEventFromLine(line, start, end);
      if (event) rows.push(event);
    }
  }
  /* eslint-enable no-await-in-loop */
  rows.sort((a, b) => COLLATOR.compare(a.at, b.at));
  return rows;
}

interface RouterSummaryAccumulator {
  requests: Set<string>;
  providerSequence: string[];
  byProvider: RouterSummary["byProvider"];
  failures: RouterSummary["failures"];
  skipped: RouterSkippedEvent[];
  retries: number;
  exhaustionWaitCount: number;
  exhaustionWaitMs: number;
  transportErrors: number;
}

function recordRouterResult(
  row: RouterEventRow,
  acc: RouterSummaryAccumulator
): void {
  const entry = (acc.byProvider[row.provider ?? "?"] ??= {
    requests: 0,
    failures: 0,
    elapsedMs: 0,
    toolCalls: 0
  });
  entry.requests += 1;
  entry.elapsedMs += row.elapsedMs ?? 0;
  entry.toolCalls += row.toolCalls ?? 0;
  if (row.outcome === "failure") {
    entry.failures += 1;
    acc.failures.push({
      at: row.at,
      requestId: row.requestId,
      provider: row.provider,
      status: row.status,
      failureClass: row.failureClass ?? row.denialReason ?? null,
      elapsedMs: row.elapsedMs
    });
  }
}

function recordRouterEvent(
  row: RouterEventRow,
  acc: RouterSummaryAccumulator
): void {
  switch (row.phase) {
    case "selected": {
      acc.requests.add(row.requestId);
      const provider = row.provider ?? "?";
      if (acc.providerSequence.at(-1) !== provider)
        acc.providerSequence.push(provider);
      return;
    }
    case "spawn_failed": {
      acc.failures.push({
        at: row.at,
        requestId: row.requestId,
        provider: row.provider,
        status: row.status,
        failureClass:
          row.failureClass ?? row.spawnFailureReason ?? "spawn_failed",
        elapsedMs: row.elapsedMs,
        ...(row.spawnFailureReason
          ? { spawnFailureReason: row.spawnFailureReason }
          : {})
      });
      return;
    }
    case "skipped": {
      acc.skipped.push({
        at: row.at,
        requestId: row.requestId,
        provider: row.provider,
        reason:
          row.failureClass ?? row.reason ?? row.denialReason ?? UNKNOWN_LABEL,
        elapsedMs: row.elapsedMs
      });
      return;
    }
    case "retry": {
      acc.retries += 1;
      return;
    }
    case "exhaustion_wait": {
      acc.exhaustionWaitCount += 1;
      acc.exhaustionWaitMs += row.elapsedMs ?? 0;
      return;
    }
    case "transport_error": {
      acc.transportErrors += 1;
      return;
    }
    case "result": {
      recordRouterResult(row, acc);
      break;
    }
    default: {
      break;
    }
  }
}

/** One thread's requests, summarised. Events that name threads match exactly; older ones fall back to model and window. */
export function summarizeRouter(
  thread: ThreadTrace,
  rows: RouterEventRow[],
  withEvents: boolean
): RouterSummary {
  const start = thread.start ? shift(thread.start, -5) : "";
  const end = thread.end ? shift(thread.end, 60) : "￿";
  // Decided per event: a log spanning a router upgrade holds both kinds.
  const mine = rows.filter((row) =>
    row.thread === null
      ? row.requestId.length > 0 &&
        row.at >= start &&
        row.at <= end &&
        (!thread.model ||
          !row.requestedModel ||
          row.requestedModel === thread.model)
      : row.thread === thread.id
  );
  const guessed = mine.some((row) => row.thread === null);
  const acc: RouterSummaryAccumulator = {
    requests: new Set<string>(),
    providerSequence: [],
    byProvider: {},
    failures: [],
    skipped: [],
    retries: 0,
    exhaustionWaitCount: 0,
    exhaustionWaitMs: 0,
    transportErrors: 0
  };
  for (const row of mine) recordRouterEvent(row, acc);
  return {
    thread: thread.id,
    model: thread.model,
    matchedBy: guessed ? "model-window" : "thread",
    requests: acc.requests.size,
    byProvider: acc.byProvider,
    failures: acc.failures,
    providerSequence: acc.providerSequence,
    ...(acc.skipped.length > 0 ? { skipped: acc.skipped } : {}),
    ...(acc.retries > 0 ? { retries: acc.retries } : {}),
    ...(acc.exhaustionWaitCount > 0
      ? {
          exhaustionWaits: {
            count: acc.exhaustionWaitCount,
            totalMs: acc.exhaustionWaitMs
          }
        }
      : {}),
    ...(acc.transportErrors > 0
      ? { transportErrors: acc.transportErrors }
      : {}),
    ...(withEvents ? { events: mine } : {})
  };
}

function shift(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5000 });
  } catch {
    return "";
  }
}

function providerProcesses(): string[] {
  // Command lines can carry prompts; keep the executable and flags only.
  return run("ps", ["-Ao", "pid,ppid,etime,command"])
    .split("\n")
    .filter((line) => ACTIVE_PROCESS_REGEX.test(line))
    .map((line) =>
      line.trim().split(WHITESPACE_SPLIT_REGEX).slice(0, 5).join(" ")
    );
}

/** Router and bridge processes, with when they started -- a fix is live only in a process started after it was installed. */
function services(): LiveReport["services"] {
  return run("ps", ["-Ao", "pid,lstart,command"])
    .split("\n")
    .flatMap((line) => {
      const match = SERVICE_PROCESS_REGEX.exec(line);
      return match
        ? [
            {
              pid: match[1]!,
              started: new Date(match[2]!).toISOString(),
              script: match[3]!
            }
          ]
        : [];
    });
}

function readTailText(
  file: string,
  maxBytes: number
): { text: string; full: boolean } {
  const size = statSync(file).size;
  const length = Math.min(size, maxBytes);
  if (length === 0) return { text: "", full: true };
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), full: length === size };
  } finally {
    closeSync(fd);
  }
}

function turnMarkers(source: string): { started: number; ended: number } {
  return {
    started: source.lastIndexOf('"type":"task_started"'),
    ended: Math.max(
      source.lastIndexOf('"type":"task_complete"'),
      source.lastIndexOf('"type":"turn_aborted"')
    )
  };
}

/** Whether the rollout's latest turn has started and not yet completed or aborted, read from its tail. */
export function hasOpenTurn(file: string): boolean {
  const { text, full } = readTailText(file, 256 * 1024);
  // A long turn's start can lie far before the tail; read the whole file then.
  let { started, ended } = turnMarkers(text);
  if (started < 0 && ended < 0 && !full)
    ({ started, ended } = turnMarkers(readFileSync(file, "utf8")));
  return started > ended;
}

function sha(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function checkoutRuntimeSourceRoot(repoRoot: string): string | null {
  const monorepoRuntimeSrc = path.join(repoRoot, "runtime", "src");
  if (
    existsSync(path.join(repoRoot, "runtime", "package.json")) &&
    existsSync(monorepoRuntimeSrc)
  )
    return monorepoRuntimeSrc;
  const legacySrc = path.join(repoRoot, "src");
  return existsSync(legacySrc) ? legacySrc : null;
}

/** Installed runtime modules that differ from the checkout: the running services execute the installed copies. */
export function deploymentDrift(
  codexHome: string,
  repoRoot: string | null | undefined
): LiveReport["drift"] {
  const installedRoot = path.join(codexHome, "src");
  const checkoutSrcRoot = repoRoot ? checkoutRuntimeSourceRoot(repoRoot) : null;
  if (!checkoutSrcRoot || !existsSync(installedRoot)) return null;
  const differing: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = path.relative(installedRoot, filePath);
      const source = path.join(checkoutSrcRoot, rel);
      checked += 1;
      if (!existsSync(source)) missing.push(rel);
      else if (sha(source) !== sha(filePath)) differing.push(rel);
    }
  };
  visit(installedRoot);
  return { checked, differing, missing };
}

function readRouterStateFields(codexHome: string): {
  disabledProviders: string[];
  nullRoleModels: string[];
} {
  const stateFile = path.join(codexHome, "codex-router-state.json");
  if (!existsSync(stateFile)) {
    return { disabledProviders: [], nullRoleModels: [] };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!isRecord(raw)) return { disabledProviders: [], nullRoleModels: [] };
    const disabledProviders = Array.isArray(raw.disabledProviders)
      ? raw.disabledProviders.filter((v): v is string => typeof v === "string")
      : [];
    const nullRoleModels: string[] = [];
    if (isRecord(raw.roleAssignments)) {
      for (const [provider, roles] of Object.entries(raw.roleAssignments)) {
        if (!isRecord(roles)) continue;
        for (const [role, entry] of Object.entries(roles)) {
          if (isRecord(entry) && entry.model === null) {
            nullRoleModels.push(`${provider}.${role}`);
          }
        }
      }
    }
    return { disabledProviders, nullRoleModels };
  } catch {
    return { disabledProviders: [], nullRoleModels: [] };
  }
}

function parseExposedServers(raw: unknown): Record<string, number> {
  const exposed: Record<string, number> = {};
  if (!Array.isArray(raw)) return exposed;
  for (const row of raw) {
    if (
      isRecord(row) &&
      typeof row.server === "string" &&
      typeof row.count === "number"
    ) {
      exposed[row.server] = row.count;
    }
  }
  return exposed;
}

function parseUsedServers(raw: unknown): Record<string, number> {
  const used: Record<string, number> = {};
  if (!isRecord(raw)) return used;
  for (const [srv, count] of Object.entries(raw)) {
    if (typeof count === "number") used[srv] = count;
  }
  return used;
}

function parseTopBridgeTools(
  raw: unknown
): Array<{ tool: string; ok: number; error: number }> {
  if (!Array.isArray(raw)) return [];
  const tools: Array<{ tool: string; ok: number; error: number }> = [];
  for (const row of raw) {
    if (!isRecord(row) || typeof row.tool !== "string") continue;
    const byStatus = isRecord(row.byStatus) ? row.byStatus : {};
    const ok = typeof byStatus.ok === "number" ? byStatus.ok : 0;
    const error = typeof byStatus.error === "number" ? byStatus.error : 0;
    tools.push({ tool: row.tool, ok, error });
  }
  tools.sort((a, b) => b.ok + b.error - (a.ok + a.error));
  return tools.slice(0, 8);
}

function readWorkspaceMcpSummaries(
  status: RouterStatusBody
): EfficiencyWorkspaceMcpSummary[] {
  const byWs =
    isRecord(status.usage) && isRecord(status.usage.byWorkspace)
      ? status.usage.byWorkspace
      : null;
  if (!byWs) return [];
  const out: EfficiencyWorkspaceMcpSummary[] = [];
  for (const [workspace, entry] of Object.entries(byWs)) {
    if (!isRecord(entry)) continue;
    out.push({
      workspace,
      exposed: parseExposedServers(entry.mcpExposed),
      used: parseUsedServers(entry.byMcp),
      topTools: parseTopBridgeTools(entry.bridgeTools)
    });
  }
  return out;
}

function readProviderFailuresSummary(
  status: RouterStatusBody
): NonNullable<EfficiencySummary["providerLastFailures"]> {
  if (!status.providers) return [];
  const rows: NonNullable<EfficiencySummary["providerLastFailures"]> = [];
  for (const [provider, info] of Object.entries(status.providers)) {
    const lastFailure = isRecord(info.lastFailure) ? info.lastFailure : null;
    const cooldownKind =
      typeof info.cooldownKind === "string" ? info.cooldownKind : null;
    const provStatus = typeof info.status === "string" ? info.status : null;
    if (!cooldownKind && !lastFailure && provStatus === "ready") continue;
    rows.push({
      provider,
      status: provStatus,
      cooldownKind,
      lastFailureClass:
        lastFailure && typeof lastFailure.class === "string"
          ? lastFailure.class
          : null,
      lastFailureStatus:
        lastFailure && typeof lastFailure.status === "number"
          ? lastFailure.status
          : null
    });
  }
  return rows;
}

function buildEfficiencySummary(
  codexHome: string,
  status: RouterStatusBody | null
): EfficiencySummary {
  const { disabledProviders, nullRoleModels } =
    readRouterStateFields(codexHome);
  if (!status) return { disabledProviders, nullRoleModels };
  const providerLastFailures = readProviderFailuresSummary(status);
  const workspaces = readWorkspaceMcpSummaries(status);
  return {
    disabledProviders,
    nullRoleModels,
    ...(providerLastFailures.length > 0 ? { providerLastFailures } : {}),
    ...(workspaces.length > 0 ? { workspaces } : {})
  };
}

async function liveReportWithStatus(
  options: TraceOptions
): Promise<{ live: LiveReport; status: RouterStatusBody | null }> {
  let parsedStatus: RouterStatusBody | null = null;
  let router: LiveReport["router"] = {
    reachable: false,
    canonicalLiveCount: null,
    byState: null,
    liveByRole: null,
    startedAt: null
  };
  try {
    const response = await fetch(
      `${options.routerUrl ?? "http://127.0.0.1:4100"}/status`,
      { signal: AbortSignal.timeout(3000) }
    );
    const parsed: unknown = await response.json();
    parsedStatus = parseRouterStatus(parsed);
    router = {
      reachable: true,
      canonicalLiveCount:
        typeof parsedStatus?.agents?.canonicalLiveCount === "number"
          ? parsedStatus.agents.canonicalLiveCount
          : null,
      byState: parsedStatus?.agents?.byState ?? null,
      liveByRole: parsedStatus?.agents?.liveByRole ?? null,
      startedAt:
        typeof parsedStatus?.startedAt === "string"
          ? parsedStatus.startedAt
          : null
    };
  } catch {
    /* router down or not reachable: reported as such */
  }
  const cutoff = Date.now() - WRITING_WINDOW_MS;
  const openThreads = rolloutFiles(path.join(options.codexHome, "sessions"))
    .reverse()
    .slice(0, 200)
    .flatMap((file) => {
      const modified = statSync(file).mtimeMs;
      if (modified < cutoff || !hasOpenTurn(file)) return [];
      const meta = firstLine(file)?.payload;
      return [
        {
          id: typeof meta?.id === "string" ? meta.id : file,
          modified: new Date(modified).toISOString()
        }
      ];
    });
  return {
    live: {
      router,
      openThreads,
      processes: providerProcesses(),
      services: services(),
      drift: deploymentDrift(options.codexHome, options.repoRoot)
    },
    status: parsedStatus
  };
}

function logFreshness(codexHome: string): TraceReport["logs"] {
  const candidates = [
    path.join(codexHome, "run"),
    path.join(codexHome, "hooks")
  ].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".log"))
          .map((name) => path.join(dir, name))
      : []
  );
  return candidates
    .map((file) => {
      const stat = statSync(file);
      return { file, modified: stat.mtime.toISOString(), bytes: stat.size };
    })
    .sort((a, b) => COLLATOR.compare(b.modified, a.modified));
}

function bridgeLogAlerts(codexHome: string): BridgeLogAlert[] {
  const hooksDir = path.join(codexHome, "hooks");
  if (!existsSync(hooksDir)) return [];
  const alerts: BridgeLogAlert[] = [];
  for (const name of readdirSync(hooksDir).sort()) {
    if (!name.endsWith(".launchd.log")) continue;
    const { text } = readTailText(
      path.join(hooksDir, name),
      BRIDGE_LOG_TAIL_BYTES
    );
    const matched = text
      .split("\n")
      .filter((line) => BRIDGE_LOG_ALERT_REGEX.test(line));
    if (matched.length > 0) {
      alerts.push({
        file: name,
        count: matched.length,
        samples: matched.slice(-3).map((line) => excerpt(line))
      });
    }
  }
  return alerts;
}

export async function buildReport(options: TraceOptions): Promise<TraceReport> {
  const threads = findSessionRollouts(
    rolloutRoots(options.codexHome),
    options.id
  ).map((file) => traceThread(file, options.items, options.codexHome));
  const stamps = threads
    .flatMap((thread) => [thread.start, thread.end])
    .filter(Boolean)
    .sort();
  const rows =
    stamps.length > 0
      ? await routerEvents(
          options.routerLog,
          shift(stamps[0]!, -5),
          shift(stamps.at(-1)!, 60)
        )
      : [];
  const bridgeAlerts = bridgeLogAlerts(options.codexHome);
  const liveResult = options.offline
    ? null
    : await liveReportWithStatus(options);
  const efficiency = options.efficiency
    ? buildEfficiencySummary(options.codexHome, liveResult?.status ?? null)
    : undefined;
  return {
    threads,
    router: threads.map((thread) =>
      summarizeRouter(thread, rows, options.events ?? false)
    ),
    logs: logFreshness(options.codexHome),
    ...(bridgeAlerts.length > 0 ? { bridgeAlerts } : {}),
    live: liveResult?.live ?? null,
    ...(efficiency ? { efficiency } : {})
  };
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MIB) return `${(bytes / BYTES_PER_MIB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function renderSkippedRouterSummary(skipped: RouterSkippedEvent[]): string {
  const counts = new Map<string, number>();
  for (const entry of skipped) {
    const key = `${entry.provider ?? "?"}:${entry.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
  const first = skipped[0]!;
  return `   ROUTER SKIPPED ${skipped.length} (${summary}) first=${first.at.slice(11, 23)} ${first.requestId.slice(0, 8)}`;
}

function renderRouterRetries(router: RouterSummary): string | null {
  const parts: string[] = [];
  if (router.retries) parts.push(`retries=${router.retries}`);
  if (router.transportErrors)
    parts.push(`transport_errors=${router.transportErrors}`);
  if (router.exhaustionWaits) {
    parts.push(
      `exhaustion_waits=${router.exhaustionWaits.count} (${Math.round(router.exhaustionWaits.totalMs / 1000)}s)`
    );
  }
  return parts.length > 0 ? `   ROUTER RETRIES ${parts.join(" ")}` : null;
}

function renderRouterEventLine(event: RouterEventRow): string {
  const reasonPart =
    event.reason && event.reason !== event.failureClass
      ? ` reason=${event.reason}`
      : "";
  const errorPart = event.errorCode ? ` err=${event.errorCode}` : "";
  const elapsedPart = event.elapsedMs === null ? "" : ` ${event.elapsedMs}ms`;
  const toolsPart =
    event.phase === "result" ? ` tools=${event.toolCalls ?? 0}` : "";
  return (
    `   ${event.at.slice(11, 23)} ${event.requestId.slice(0, 8)} ${event.phase} ${event.provider ?? "-"}/${event.model ?? "-"}` +
    `${event.outcome ? ` ${event.outcome}` : ""}${event.status ? ` ${event.status}` : ""}${event.failureClass ? ` ${event.failureClass}` : ""}` +
    `${reasonPart}${errorPart}${elapsedPart}${toolsPart}`
  );
}

function renderRouterFailureLine(
  failure: RouterSummary["failures"][number]
): string {
  const reasonSuffix =
    failure.spawnFailureReason &&
    failure.spawnFailureReason !== failure.failureClass
      ? ` (${failure.spawnFailureReason})`
      : "";
  return `   ROUTER FAILURE ${failure.at.slice(11, 23)} ${failure.requestId.slice(0, 8)} ${failure.provider ?? "-"} ${failure.status ?? "-"} ${failure.failureClass ?? "-"}${reasonSuffix} ${failure.elapsedMs ?? "-"}ms`;
}

function renderRouterDetails(router: RouterSummary): string[] {
  const lines: string[] = [];
  const providers = Object.entries(router.byProvider).map(
    ([provider, entry]) =>
      `${provider}: ${entry.requests} req, ${entry.failures} failed, ${Math.round(entry.elapsedMs / 1000)}s, tools=${entry.toolCalls}`
  );
  lines.push(
    `   router (${router.matchedBy}) ${router.requests} requests; ${providers.join("; ") || "no results"}`
  );
  if (router.providerSequence.length > 1)
    lines.push(`   PROVIDER HOPS ${router.providerSequence.join(" → ")}`);
  if (router.skipped && router.skipped.length > 0)
    lines.push(renderSkippedRouterSummary(router.skipped));
  const retryLine = renderRouterRetries(router);
  if (retryLine) lines.push(retryLine);
  for (const failure of router.failures)
    lines.push(renderRouterFailureLine(failure));
  for (const event of router.events ?? [])
    lines.push(renderRouterEventLine(event));
  return lines;
}

function renderThreadEfficiency(eff: ThreadEfficiency): string[] {
  const { tokens, compaction, prompt } = eff;
  const tokenLine = tokens.observed
    ? `   efficiency tokens=${formatCompactNumber(tokens.totalTokens)} ` +
      `(in=${formatCompactNumber(tokens.inputTokens)} cached=${formatCompactNumber(tokens.cachedInputTokens)} ` +
      `[${tokens.cacheHitPct ?? "?"}%] out=${formatCompactNumber(tokens.outputTokens)} ` +
      `reasoning=${formatCompactNumber(tokens.reasoningOutputTokens)} [${tokens.reasoningPct ?? "?"}%]) ` +
      `peak-in=${formatCompactNumber(tokens.peakInputTokens)} cache-drops=${tokens.cacheDrops}`
    : "   efficiency tokens=unreported (0 non-zero samples)";
  const compLine =
    `   compactions=${compaction.count} (context_compacted=${compaction.contextCompactedEvents}) ` +
    `max-replacement=${compaction.maxReplacementItems} items/${formatBytes(compaction.maxReplacementBytes)}/imgs=${compaction.maxReplacementImages} ` +
    `response-images=${compaction.responseImageItems}`;
  const roots = Object.entries(prompt.skillsByRoot)
    .sort((a, b) => b[1] - a[1])
    .map(([root, count]) => `${root}=${count}`)
    .join(" ");
  const readPreview =
    prompt.skillsRead.length > 0
      ? ` [${prompt.skillsRead.slice(0, 8).join(", ")}${prompt.skillsRead.length > 8 ? ", …" : ""}]`
      : "";
  const promptLine =
    `   prompt dev=${formatBytes(prompt.initialDeveloperBytes)} skills-block=${formatBytes(prompt.skillsCatalogBytes)} ` +
    `loaded=${prompt.skillsLoaded} (${roots || "none"}) read=${prompt.skillsRead.length}${readPreview} ` +
    `telemetry-reads=${prompt.skillTelemetryReads ?? "?"}`;
  return [tokenLine, compLine, promptLine];
}

function renderThreadFailures(
  toolFailures: ToolFailure[],
  includeInput: boolean,
  allFailures: boolean
): string[] {
  if (toolFailures.length === 0) return [];
  const lines: string[] = [];
  const counts = new Map<ToolFailureCategory, number>();
  for (const failure of toolFailures) {
    const category =
      failure.category ?? classifyToolFailure(failure.detail, failure.input);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (toolFailures.length > 1) {
    const summary = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}=${count}`)
      .join(" ");
    lines.push(`   TOOL FAILURES total=${toolFailures.length} (${summary})`);
  }
  const shown = new Map<ToolFailureCategory, number>();
  const omitted = new Map<ToolFailureCategory, number>();
  for (const failure of toolFailures) {
    const category =
      failure.category ?? classifyToolFailure(failure.detail, failure.input);
    const seen = shown.get(category) ?? 0;
    if (allFailures || seen < FAILURE_CAP_PER_CATEGORY) {
      shown.set(category, seen + 1);
      lines.push(
        `   TOOL FAILED ${failure.at.slice(11, 19)} ${failure.tool} call=${failure.callId} :: ${failure.detail}`
      );
      if (includeInput && failure.input) {
        const renderedInput = allFailures
          ? failure.input
          : excerpt(failure.input, FAILURE_PREVIEW_INPUT_EXCERPT);
        lines.push(`     input=${renderedInput}`);
      }
    } else {
      omitted.set(category, (omitted.get(category) ?? 0) + 1);
    }
  }
  for (const [category, hidden] of omitted.entries()) {
    lines.push(
      `   ... (+${hidden} more ${category} failures; pass --all-failures to list all)`
    );
  }
  return lines;
}

function renderInvestigation(investigation: Investigation): string {
  if (!investigation.observed)
    return "   investigation unavailable (no item events)";
  const { context } = investigation;
  return [
    "   investigation",
    `first-edit=${investigation.firstEditAt === null ? "none" : investigation.firstEditAt.slice(11, 19) || "?"}`,
    `calls=${investigation.toolCalls}`,
    `tokens=${investigation.tokens ?? "?"}`,
    `files-read=${investigation.filesRead}`,
    `repeated-reads=${investigation.repeatedReads}`,
    `searches=${investigation.searches}`,
    `repeated-searches=${investigation.repeatedSearches}`,
    `ccc=${context.ccc}`,
    `cgc=${context.cgc}`,
    `lsp=${context.lsp}`
  ].join(" ");
}

function renderThreadSection(
  thread: ThreadTrace,
  router?: RouterSummary,
  {
    failures = false,
    allFailures = false,
    efficiency = false
  }: { failures?: boolean; allFailures?: boolean; efficiency?: boolean } = {}
): string[] {
  const lines: string[] = [
    `== thread ${thread.id} ${thread.nickname ? `(${thread.nickname}) ` : ""}role=${thread.role ?? "-"} model=${thread.model ?? "-"} codex=${thread.cliVersion ?? "-"}`,
    `   session=${thread.sessionId ?? "-"} parent=${thread.parentId ?? "-"} ${thread.start ?? "?"} → ${thread.end ?? "?"}`,
    `   file=${thread.file}`
  ];
  for (const turn of thread.turns)
    lines.push(
      `   turn ${turn.turnId} ${turn.started ?? "?"} → ${turn.ended ?? "open"} ${turn.outcome}${turn.detail ? ` :: ${turn.detail}` : ""}`
    );
  for (const gap of thread.gaps)
    lines.push(
      `   GAP ${gap.seconds}s after ${gap.after} (${gap.at}) before ${gap.before}`
    );
  const tools = Object.entries(thread.tools).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0)
    lines.push(
      `   tools ${tools.map(([tool, count]) => `${tool}=${count}`).join(" ")}`
    );
  lines.push(renderInvestigation(thread.investigation));
  if (efficiency && thread.efficiency) {
    lines.push(...renderThreadEfficiency(thread.efficiency));
  }
  if (thread.anomalies && thread.anomalies.tagOnlyMessages > 0) {
    lines.push(
      `   ANOMALY tag-only assistant messages: ${thread.anomalies.tagOnlyMessages} (${thread.anomalies.samples.join(", ")})`
    );
  }
  lines.push(
    ...renderThreadFailures(thread.toolFailures, failures, allFailures)
  );
  if (router) {
    lines.push(...renderRouterDetails(router));
  }
  for (const item of thread.items ?? [])
    lines.push(`   ${item.at.slice(11, 19)} ${item.kind} ${item.detail}`);
  return lines;
}

function renderLiveSection(live: LiveReport): string[] {
  const { router, openThreads, processes, services: running, drift } = live;
  const lines: string[] = [
    "== live now",
    router.reachable
      ? `   router (started ${router.startedAt}) live agents=${router.canonicalLiveCount} byState=${JSON.stringify(router.byState)} byRole=${JSON.stringify(router.liveByRole)}`
      : "   router /status unreachable",
    `   threads with an open turn (written in the last 10 min): ${openThreads.length}${openThreads.length > 0 ? ` (${openThreads.map((thread) => thread.id).join(", ")})` : ""}`
  ];
  if (
    router.canonicalLiveCount !== null &&
    router.canonicalLiveCount !== openThreads.length
  ) {
    lines.push(
      `   LIVE COUNT MISMATCH: router ${router.canonicalLiveCount} vs ${openThreads.length} open threads -- above: something keys activity per request; below: reports land on the wrong agent, or an agent went stale`
    );
  }
  for (const service of running)
    lines.push(
      `   service pid=${service.pid} started=${service.started} ${service.script}`
    );
  if (drift) {
    lines.push(
      `   deployed $CODEX_HOME/src vs checkout: ${drift.checked} files, ${drift.differing.length} differ, ${drift.missing.length} not in checkout`
    );
    for (const file of drift.differing.slice(0, 15))
      lines.push(`   DRIFT ${file}`);
  }
  lines.push(
    `   provider CLIs / MCP servers running: ${processes.length === 0 ? "none" : ""}`
  );
  for (const line of processes) lines.push(`     ${line}`);
  return lines;
}

function renderEfficiencySection(efficiency: EfficiencySummary): string[] {
  const lines: string[] = [
    "== efficiency & persisted router state",
    `   disabledProviders=${JSON.stringify(efficiency.disabledProviders)} nullRoleModels=${JSON.stringify(efficiency.nullRoleModels)}`
  ];
  for (const p of efficiency.providerLastFailures ?? []) {
    lines.push(
      `   provider ${p.provider}: status=${p.status ?? "-"} cooldown=${p.cooldownKind ?? "none"} lastFailure=${p.lastFailureClass ?? "-"} (${p.lastFailureStatus ?? "-"})`
    );
  }
  for (const ws of efficiency.workspaces ?? []) {
    const servers = new Set([
      ...Object.keys(ws.exposed),
      ...Object.keys(ws.used)
    ]);
    const mcpPairs = [...servers]
      .sort()
      .map((s) => `${s}:${ws.used[s] ?? 0}/${ws.exposed[s] ?? 0}`)
      .join(" ");
    lines.push(
      `   workspace ${ws.workspace} mcp(used/exposed): ${mcpPairs || "none"}`
    );
    if (ws.topTools.length > 0) {
      lines.push(
        `     topTools: ${ws.topTools.map((t) => `${t.tool}(ok=${t.ok},err=${t.error})`).join(" ")}`
      );
    }
  }
  return lines;
}

export function renderReport(
  report: TraceReport,
  options: {
    failures?: boolean;
    allFailures?: boolean;
    efficiency?: boolean;
  } = {}
): string {
  const showEfficiency = options.efficiency ?? Boolean(report.efficiency);
  const out: string[] = [];
  if (report.threads.length === 0)
    out.push(
      "No rollout found for that id under <codex-home>/sessions or archived_sessions. Try --recent."
    );
  for (const thread of report.threads) {
    const router = report.router.find((entry) => entry.thread === thread.id);
    out.push(
      ...renderThreadSection(thread, router, {
        ...options,
        efficiency: showEfficiency
      })
    );
  }
  if (report.live) {
    out.push(...renderLiveSection(report.live));
  }
  if (report.efficiency) {
    out.push(...renderEfficiencySection(report.efficiency));
  }
  out.push(
    "== log freshness (bridge logs carry no timestamps; correlate by order and mtime)"
  );
  for (const log of report.logs.slice(0, 8))
    out.push(
      `   ${log.modified} ${String(log.bytes).padStart(10)} ${log.file}`
    );
  if (report.bridgeAlerts && report.bridgeAlerts.length > 0) {
    out.push("== bridge log alerts (tail 64 KB)");
    for (const alert of report.bridgeAlerts) {
      out.push(`   ${alert.file}: ${alert.count} matching line(s)`);
      for (const sample of alert.samples) out.push(`     ${sample}`);
    }
  }
  return out.join("\n");
}

export function renderRecent(sessions: RecentSession[]): string {
  return sessions
    .map(
      (session) =>
        `${session.lastWrite} ${session.id} threads=${session.threads} started=${session.started} cwd=${session.cwd ?? "-"}`
    )
    .join("\n");
}

interface HookDenialAccumulator {
  totalLines: number;
  userPromptSubmits: number;
  preToolUseDenials: number;
  byPolicy: Record<string, number>;
  byRole: Record<string, number>;
  reasonCounts: Map<string, number>;
  commandCounts: Map<
    string,
    { commandHead: string; policy: string; count: number }
  >;
}

function recordHookLogLine(
  line: string,
  cutoff: string,
  acc: HookDenialAccumulator
): void {
  if (!line) return;
  acc.totalLines += 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(parsed) || typeof parsed.time !== "string") return;
  if (parsed.time < cutoff) return;
  if (parsed.event === "UserPromptSubmit") {
    acc.userPromptSubmits += 1;
    return;
  }
  if (parsed.event !== "PreToolUse" || parsed.decision !== "deny") return;
  acc.preToolUseDenials += 1;
  const policy =
    typeof parsed.policy === "string" ? parsed.policy : UNKNOWN_LABEL;
  const role = typeof parsed.role === "string" ? parsed.role : UNKNOWN_LABEL;
  const reason =
    typeof parsed.reason === "string" ? parsed.reason : UNKNOWN_LABEL;
  acc.byPolicy[policy] = (acc.byPolicy[policy] ?? 0) + 1;
  acc.byRole[role] = (acc.byRole[role] ?? 0) + 1;
  acc.reasonCounts.set(reason, (acc.reasonCounts.get(reason) ?? 0) + 1);
  if (typeof parsed.commandHead !== "string" || !parsed.commandHead) return;
  const key = `${policy}\0${parsed.commandHead}`;
  const prev = acc.commandCounts.get(key);
  if (prev) prev.count += 1;
  else {
    acc.commandCounts.set(key, {
      commandHead: parsed.commandHead,
      policy,
      count: 1
    });
  }
}

/** Aggregate structured `PreToolUse` denial entries recorded in `$CODEX_HOME/hooks/hooks.log`. */
export function summarizeHookDenials(
  codexHome: string,
  sinceDays = 7,
  nowMs = Date.now()
): HookDenialSummary {
  const logFile = path.join(codexHome, "hooks", "hooks.log");
  const cutoff = new Date(nowMs - sinceDays * MS_PER_DAY).toISOString();
  const acc: HookDenialAccumulator = {
    totalLines: 0,
    userPromptSubmits: 0,
    preToolUseDenials: 0,
    byPolicy: {},
    byRole: {},
    reasonCounts: new Map(),
    commandCounts: new Map()
  };

  if (existsSync(logFile)) {
    for (const line of readFileSync(logFile, "utf8").split("\n")) {
      recordHookLogLine(line, cutoff, acc);
    }
  }

  return {
    logFile,
    sinceDays,
    cutoff,
    totalLines: acc.totalLines,
    userPromptSubmits: acc.userPromptSubmits,
    preToolUseDenials: acc.preToolUseDenials,
    byPolicy: acc.byPolicy,
    byRole: acc.byRole,
    byReason: [...acc.reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([reason, count]) => ({ reason, count })),
    topCommands: [...acc.commandCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
  };
}

export function renderHookDenials(summary: HookDenialSummary): string {
  const lines = [
    `== hook denials (${summary.logFile}) since=${summary.cutoff} (${summary.sinceDays}d)`,
    `   lines=${summary.totalLines} userPromptSubmits=${summary.userPromptSubmits} preToolUseDenials=${summary.preToolUseDenials}`
  ];
  if (summary.preToolUseDenials === 0) {
    lines.push(
      "   no structured PreToolUse denial entries in window (reinstall hooks to enable hooks.log capture, or use --scan-recent to aggregate historical rollout blocks)"
    );
    return lines.join("\n");
  }
  const policyText = Object.entries(summary.byPolicy)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const roleText = Object.entries(summary.byRole)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  lines.push(`   byPolicy: ${policyText}`, `   byRole: ${roleText}`);
  if (summary.byReason.length > 0) {
    lines.push("   top reasons:");
    for (const item of summary.byReason)
      lines.push(`     ${String(item.count).padStart(4)}  ${item.reason}`);
  }
  if (summary.topCommands.length > 0) {
    lines.push("   top blocked commands:");
    for (const item of summary.topCommands)
      lines.push(
        `     ${String(item.count).padStart(4)}  [${item.policy}] ${item.commandHead}`
      );
  }
  return lines.join("\n");
}

function extractPreToolUseReason(detail: string): string | null {
  const markerIndex = detail.indexOf(PRETOOLUSE_MARKER);
  if (markerIndex === -1) return null;
  const afterMarker = detail
    .slice(markerIndex + PRETOOLUSE_MARKER.length)
    .trimStart();
  const newlineIndex = afterMarker.indexOf("\n");
  const reasonLine =
    newlineIndex === -1 ? afterMarker : afterMarker.slice(0, newlineIndex);
  const suffixAt = reasonLine.search(PRETOOLUSE_HINT_SUFFIX_REGEX);
  const clipped = suffixAt === -1 ? reasonLine : reasonLine.slice(0, suffixAt);
  const trimmed = clipped.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rolloutsForSelectedSessions(
  codexHome: string,
  selectedIds: Set<string>
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const files = rolloutRoots(codexHome)
    .flatMap((root) => rolloutFiles(root))
    .sort((a, b) => COLLATOR.compare(path.basename(b), path.basename(a)));
  for (const file of files) {
    const meta = firstLine(file)?.payload;
    if (!meta) continue;
    const owner =
      typeof meta.session_id === "string" && selectedIds.has(meta.session_id)
        ? meta.session_id
        : typeof meta.id === "string" && selectedIds.has(meta.id)
          ? meta.id
          : typeof meta.parent_thread_id === "string" &&
              selectedIds.has(meta.parent_thread_id)
            ? meta.parent_thread_id
            : null;
    if (!owner) continue;
    const list = grouped.get(owner) ?? [];
    list.push(file);
    grouped.set(owner, list);
  }
  return grouped;
}

interface SessionFleetAccumulator {
  row: FleetSessionRow;
  failureCounts: Map<ToolFailureCategory, number>;
}

function accumulateFleetThread(
  thread: ThreadTrace,
  router: RouterSummary,
  acc: SessionFleetAccumulator,
  totals: FleetScanReport["totals"],
  preToolReasons: Map<string, number>,
  skippedReasons: Map<string, number>
): void {
  const eff = thread.efficiency;
  if (eff) {
    acc.row.totalTokens += eff.tokens.totalTokens;
    acc.row.inputTokens += eff.tokens.inputTokens;
    acc.row.cachedInputTokens += eff.tokens.cachedInputTokens;
    acc.row.cacheDrops += eff.tokens.cacheDrops;
    acc.row.compactions += eff.compaction.count;
    if (eff.prompt.skillsLoaded > acc.row.maxSkillsLoaded)
      acc.row.maxSkillsLoaded = eff.prompt.skillsLoaded;
    totals.totalTokens += eff.tokens.totalTokens;
    totals.inputTokens += eff.tokens.inputTokens;
    totals.cachedInputTokens += eff.tokens.cachedInputTokens;
    totals.cacheDrops += eff.tokens.cacheDrops;
    totals.compactions += eff.compaction.count;
  }
  for (const failure of thread.toolFailures) {
    acc.row.toolFailures += 1;
    const cat =
      failure.category ?? classifyToolFailure(failure.detail, failure.input);
    acc.failureCounts.set(cat, (acc.failureCounts.get(cat) ?? 0) + 1);
    totals.toolFailuresByCategory[cat] =
      (totals.toolFailuresByCategory[cat] ?? 0) + 1;
    if (cat === "pretooluse-hook") {
      acc.row.preToolUseBlocks += 1;
      const reason = extractPreToolUseReason(failure.detail) ?? failure.detail;
      preToolReasons.set(reason, (preToolReasons.get(reason) ?? 0) + 1);
    }
  }
  acc.row.routerRequests += router.requests;
  acc.row.routerFailures += router.failures.length;
  for (const [provider, stats] of Object.entries(router.byProvider)) {
    acc.row.providers[provider] =
      (acc.row.providers[provider] ?? 0) + stats.requests;
  }
  for (const skipped of router.skipped ?? []) {
    const key = `${skipped.provider ?? "?"}:${skipped.reason}`;
    acc.row.routerSkipped[key] = (acc.row.routerSkipped[key] ?? 0) + 1;
    skippedReasons.set(key, (skippedReasons.get(key) ?? 0) + 1);
  }
}

/** Summarize efficiency, failures, PreToolUse blocks, and router skips across the N newest sessions. */
export async function scanRecentSessions(options: {
  codexHome: string;
  routerLog: string;
  limit: number;
}): Promise<FleetScanReport> {
  const recent = recentSessions(rolloutRoots(options.codexHome), options.limit);
  const bySession = rolloutsForSelectedSessions(
    options.codexHome,
    new Set(recent.map((s) => s.id))
  );
  const tracedBySession = new Map<string, ThreadTrace[]>();
  const stamps: string[] = [];
  let totalThreads = 0;

  for (const session of recent) {
    const traces = (bySession.get(session.id) ?? []).map((file) =>
      traceThread(file, false, options.codexHome)
    );
    tracedBySession.set(session.id, traces);
    totalThreads += traces.length;
    for (const t of traces) {
      if (t.start) stamps.push(t.start);
      if (t.end) stamps.push(t.end);
    }
  }
  stamps.sort();
  const rows =
    stamps.length > 0
      ? await routerEvents(
          options.routerLog,
          shift(stamps[0]!, -5),
          shift(stamps.at(-1)!, 60)
        )
      : [];

  const totals: FleetScanReport["totals"] = {
    sessions: recent.length,
    threads: totalThreads,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheHitPct: null,
    cacheDrops: 0,
    compactions: 0,
    toolFailuresByCategory: {},
    preToolUseReasons: [],
    routerSkippedByReason: []
  };
  const preToolReasons = new Map<string, number>();
  const skippedReasons = new Map<string, number>();
  const sessionRows: FleetSessionRow[] = [];

  for (const session of recent) {
    const traces = tracedBySession.get(session.id) ?? [];
    const acc: SessionFleetAccumulator = {
      failureCounts: new Map(),
      row: {
        id: session.id,
        started: session.started,
        lastWrite: session.lastWrite,
        cwd: session.cwd,
        threads: traces.length > 0 ? traces.length : session.threads,
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheHitPct: null,
        cacheDrops: 0,
        compactions: 0,
        maxSkillsLoaded: 0,
        toolFailures: 0,
        preToolUseBlocks: 0,
        topFailureCategory: null,
        routerRequests: 0,
        routerFailures: 0,
        routerSkipped: {},
        providers: {}
      }
    };
    for (const trace of traces) {
      accumulateFleetThread(
        trace,
        summarizeRouter(trace, rows, false),
        acc,
        totals,
        preToolReasons,
        skippedReasons
      );
    }
    acc.row.cacheHitPct =
      acc.row.inputTokens > 0
        ? round1((acc.row.cachedInputTokens / acc.row.inputTokens) * 100)
        : null;
    const topFailure = [...acc.failureCounts.entries()].sort(
      (a, b) => b[1] - a[1]
    )[0];
    acc.row.topFailureCategory = topFailure?.[0] ?? null;
    sessionRows.push(acc.row);
  }

  totals.cacheHitPct =
    totals.inputTokens > 0
      ? round1((totals.cachedInputTokens / totals.inputTokens) * 100)
      : null;
  totals.preToolUseReasons = [...preToolReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));
  totals.routerSkippedByReason = [...skippedReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => ({ key, count }));

  return { limit: options.limit, sessions: sessionRows, totals };
}

export function renderFleetScan(report: FleetScanReport): string {
  const t = report.totals;
  const lines = [
    `== fleet scan (${t.sessions} sessions, ${t.threads} threads)`,
    `   totals: tokens=${formatCompactNumber(t.totalTokens)} cache=${t.cacheHitPct ?? "?"}% cache-drops=${t.cacheDrops} compactions=${t.compactions}`
  ];
  for (const s of report.sessions) {
    const repo = s.cwd ? path.basename(s.cwd) : "-";
    const topFail = s.topFailureCategory ? ` (${s.topFailureCategory})` : "";
    const provSummary = Object.entries(s.providers)
      .sort((a, b) => b[1] - a[1])
      .map(([p, c]) => `${p}:${c}`)
      .join(",");
    const skipCount = Object.values(s.routerSkipped).reduce((a, b) => a + b, 0);
    lines.push(
      `   ${s.lastWrite.slice(0, 16)} ${s.id} [${repo}] th=${s.threads} tok=${formatCompactNumber(s.totalTokens)} ` +
        `cache=${s.cacheHitPct ?? "?"}% drops=${s.cacheDrops} comp=${s.compactions} skills<=${s.maxSkillsLoaded} ` +
        `fail=${s.toolFailures}${topFail} hooks=${s.preToolUseBlocks} skip=${skipCount} req=${provSummary || "-"}`
    );
  }
  const catSummary = Object.entries(t.toolFailuresByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  if (catSummary) lines.push(`   failures-by-category: ${catSummary}`);
  if (t.routerSkippedByReason.length > 0) {
    lines.push(
      `   router-skipped: ${t.routerSkippedByReason.map((x) => `${x.key}=${x.count}`).join(" ")}`
    );
  }
  if (t.preToolUseReasons.length > 0) {
    lines.push("   top pretooluse blocks in rollouts:");
    for (const item of t.preToolUseReasons)
      lines.push(`     ${String(item.count).padStart(4)}  ${item.reason}`);
  }
  return lines.join("\n");
}

function repoRootFromScript(): string | null {
  const fromEnv = process.env.AUTODEV_REPO_ROOT;
  if (fromEnv) return fromEnv;
  const top = run("git", [
    "-C",
    path.resolve(import.meta.dirname),
    "rev-parse",
    "--show-toplevel"
  ]).trim();
  return top || null;
}

interface ParsedCliOptions extends TraceOptions {
  json: boolean;
  recent: number | null;
  scanRecent: number | null;
  hooks: boolean;
  sinceDays: number;
}

type BooleanCliFlag =
  | "items"
  | "events"
  | "failures"
  | "allFailures"
  | "efficiency"
  | "json"
  | "offline"
  | "hooks";

const CLI_BOOLEAN_FLAGS: Record<string, BooleanCliFlag> = {
  "--items": "items",
  "--events": "events",
  "--failures": "failures",
  "--all-failures": "allFailures",
  "--efficiency": "efficiency",
  "--json": "json",
  "--offline": "offline",
  "--hooks": "hooks"
};

function parsePositiveNumber(raw: string, fallback: number): number {
  const parsed = Number(raw.trim());
  return raw.trim().length > 0 && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function parseArgs(argv: string[]): ParsedCliOptions | null {
  const codexHomeDefault =
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  let id = "";
  let codexHome = codexHomeDefault;
  let routerLog = "";
  let sinceDays = 7;
  let recent: number | null = null;
  let scanRecent: number | null = null;
  const flags: Record<BooleanCliFlag, boolean> = {
    items: false,
    events: false,
    failures: false,
    allFailures: false,
    efficiency: false,
    json: false,
    offline: false,
    hooks: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const flagKey = CLI_BOOLEAN_FLAGS[arg];
    if (flagKey) {
      flags[flagKey] = true;
      continue;
    }
    if (arg === "--since") {
      sinceDays = parsePositiveNumber(argv[++index] ?? "", 7);
    } else if (arg === "--codex-home") {
      codexHome = argv[++index] ?? codexHome;
    } else if (arg === "--router-log") {
      routerLog = argv[++index] ?? "";
    } else if (arg === "--recent") {
      recent = DIGITS_ONLY_REGEX.test(argv[index + 1] ?? "")
        ? Number(argv[++index])
        : 10;
    } else if (arg === "--scan-recent") {
      scanRecent = DIGITS_ONLY_REGEX.test(argv[index + 1] ?? "")
        ? Number(argv[++index])
        : 10;
    } else if (!arg.startsWith("--")) {
      id = arg;
    }
  }
  if (!id && recent === null && scanRecent === null && !flags.hooks)
    return null;
  return {
    id,
    codexHome,
    routerLog:
      routerLog ||
      path.join(codexHome, "run", "codex-model-router.launchd.err.log"),
    ...flags,
    failures: flags.failures || flags.allFailures,
    recent,
    scanRecent,
    sinceDays,
    repoRoot: repoRootFromScript()
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write(
      "usage: session-trace.ts <session-or-thread-id> [--items] [--events] [--failures] [--all-failures] [--efficiency] [--json] [--codex-home DIR] [--router-log FILE] [--offline]\n" +
        "       session-trace.ts --recent [N] [--json] [--codex-home DIR]\n" +
        "       session-trace.ts --scan-recent [N] [--json] [--codex-home DIR] [--router-log FILE]\n" +
        "       session-trace.ts --hooks [--since DAYS] [--json] [--codex-home DIR]\n"
    );
    process.exit(2);
  }
  if (options.hooks) {
    const summary = summarizeHookDenials(options.codexHome, options.sinceDays);
    process.stdout.write(
      `${options.json ? JSON.stringify(summary, null, 2) : renderHookDenials(summary)}\n`
    );
  } else if (options.scanRecent !== null) {
    const scan = await scanRecentSessions({
      codexHome: options.codexHome,
      routerLog: options.routerLog,
      limit: options.scanRecent
    });
    process.stdout.write(
      `${options.json ? JSON.stringify(scan, null, 2) : renderFleetScan(scan)}\n`
    );
  } else if (options.recent === null) {
    const report = await buildReport(options);
    process.stdout.write(
      `${options.json ? JSON.stringify(report, null, 2) : renderReport(report, { failures: Boolean(options.failures), allFailures: Boolean(options.allFailures), efficiency: Boolean(options.efficiency) })}\n`
    );
  } else {
    const sessions = recentSessions(
      rolloutRoots(options.codexHome),
      options.recent
    );
    process.stdout.write(
      `${options.json ? JSON.stringify(sessions, null, 2) : renderRecent(sessions)}\n`
    );
  }
}
