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
 *   node session-trace.ts <session-or-thread-id> [--items] [--events] [--json]
 *        [--codex-home DIR] [--router-log FILE] [--offline]
 *   node session-trace.ts --recent [N]            # when no id was given
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
  elapsedMs?: number;
  toolCalls?: number;
  selection?: string;
  [key: string]: unknown;
}

/** The router /status top-level body the live report reads. */
interface RouterStatusBody {
  agents?: RouterAgentStatus;
  startedAt?: string;
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
  if (typeof raw.elapsedMs === "number") result.elapsedMs = raw.elapsedMs;
  if (typeof raw.toolCalls === "number") result.toolCalls = raw.toolCalls;
  if (typeof raw.selection === "string") result.selection = raw.selection;
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

export interface TraceOptions {
  id: string;
  codexHome: string;
  routerLog: string;
  items: boolean;
  events?: boolean;
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
  elapsedMs: number | null;
  toolCalls: number | null;
  selection: string | null;
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
    elapsedMs: number | null;
  }>;
  /** Providers in request order, collapsed: a turn that hops providers shows more than one. */
  providerSequence: string[];
  events?: RouterEventRow[];
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

export interface TraceReport {
  threads: ThreadTrace[];
  router: RouterSummary[];
  logs: Array<{ file: string; modified: string; bytes: number }>;
  live: LiveReport | null;
}

const EXCERPT = 160;
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
  /tool call failed|Transport closed|Script failed|Script error|^aborted|No such tool|not found in ALL_TOOLS/im;

function excerpt(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat;
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
 * Rollouts belonging to the id: the thread itself, plus -- whether the id names
 * a session or a thread -- every thread sharing its session. Newest files are
 * checked first because a debugged session is almost always recent.
 */
export function findSessionRollouts(
  sessionsRoot: string,
  id: string
): string[] {
  const files = rolloutFiles(sessionsRoot).reverse();
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

/** The newest root sessions, for when the user names none. */
export function recentSessions(
  sessionsRoot: string,
  limit: number
): RecentSession[] {
  const sessions = new Map<string, RecentSession>();
  for (const file of rolloutFiles(sessionsRoot).reverse().slice(0, 400)) {
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

interface ThreadTraceAccumulator {
  counts: Record<string, number>;
  turns: ThreadTrace["turns"];
  open: Map<string, ThreadTrace["turns"][number]>;
  items: NonNullable<ThreadTrace["items"]>;
  gaps: ThreadTrace["gaps"];
  tools: Record<string, number>;
  toolFailures: ToolFailure[];
  callTools: Map<string, string>;
  previous: { at: string; label: string } | null;
  investigation: Investigation;
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

function recordToolUsage(
  record: RolloutPayload,
  at: string | null,
  payload: ResponseItemPayload | undefined,
  acc: ThreadTraceAccumulator
): void {
  if (record.type !== "response_item" || !payload) return;
  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const reached = toolsOfCall(payload);
    for (const tool of reached) acc.tools[tool] = (acc.tools[tool] ?? 0) + 1;
    if (typeof payload.call_id === "string")
      acc.callTools.set(payload.call_id, reached.join("+"));
  } else if (
    payload.type === "custom_tool_call_output" ||
    payload.type === "function_call_output"
  ) {
    const text = outputText(payload.output);
    const failure = TOOL_FAILURE.exec(text);
    if (failure) {
      acc.toolFailures.push({
        at: at ?? "",
        tool:
          (typeof payload.call_id === "string" &&
            acc.callTools.get(payload.call_id)) ||
          "?",
        callId: typeof payload.call_id === "string" ? payload.call_id : "",
        detail: excerpt(text.slice(Math.max(0, failure.index - 40)))
      });
    }
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
    if (payload) recordInvestigation(record, at, payload, acc);
    return;
  }
  incrementCount(acc, record.type);
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
  withItems: boolean
): ThreadTrace {
  const { counts, turns, gaps, tools, toolFailures, items, investigation } =
    acc;
  const { start, end } = timestampBounds(records);
  return {
    id: typeof meta.id === "string" ? meta.id : file,
    sessionId: typeof meta.session_id === "string" ? meta.session_id : null,
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
    investigation,
    ...(withItems ? { items } : {})
  };
}

export function traceThread(file: string, withItems: boolean): ThreadTrace {
  const records = readJsonl(file);
  const { meta, context } = traceMetadata(records);
  const acc = createTraceAccumulator(meta);
  for (const record of records) accumulateTraceRecord(record, withItems, acc);
  return buildThreadTrace(file, records, meta, context, acc, withItems);
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
    requestId: typeof event.requestId === "string" ? event.requestId : "",
    thread: typeof event.thread === "string" ? event.thread : null,
    phase: typeof event.phase === "string" ? event.phase : "",
    role: typeof event.role === "string" ? event.role : null,
    requestedModel:
      typeof event.requestedModel === "string" ? event.requestedModel : null,
    provider: typeof event.provider === "string" ? event.provider : null,
    model: typeof event.model === "string" ? event.model : null,
    outcome: typeof event.outcome === "string" ? event.outcome : null,
    status: typeof event.status === "number" ? event.status : null,
    failureClass:
      typeof event.failureClass === "string" ? event.failureClass : null,
    elapsedMs: typeof event.elapsedMs === "number" ? event.elapsedMs : null,
    toolCalls: typeof event.toolCalls === "number" ? event.toolCalls : null,
    selection: typeof event.selection === "string" ? event.selection : null
  };
}

export async function routerEvents(
  logFile: string,
  start: string,
  end: string
): Promise<RouterEventRow[]> {
  if (!existsSync(logFile)) return [];
  const rows: RouterEventRow[] = [];
  const lines = createInterface({
    input: createReadStream(logFile, "utf8"),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    const event = routerEventFromLine(line, start, end);
    if (event) rows.push(event);
  }
  return rows;
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
      ? row.at >= start &&
        row.at <= end &&
        (!thread.model ||
          !row.requestedModel ||
          row.requestedModel === thread.model)
      : row.thread === thread.id
  );
  const guessed = mine.some((row) => row.thread === null);
  const byProvider: RouterSummary["byProvider"] = {};
  const failures: RouterSummary["failures"] = [];
  const providerSequence: string[] = [];
  const requests = new Set<string>();
  for (const row of mine) {
    if (row.phase === "selected") {
      requests.add(row.requestId);
      const provider = row.provider ?? "?";
      if (providerSequence.at(-1) !== provider) providerSequence.push(provider);
    }
    if (row.phase !== "result") continue;
    const entry = (byProvider[row.provider ?? "?"] ??= {
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
      failures.push({
        at: row.at,
        requestId: row.requestId,
        provider: row.provider,
        status: row.status,
        failureClass: row.failureClass,
        elapsedMs: row.elapsedMs
      });
    }
  }
  return {
    thread: thread.id,
    model: thread.model,
    matchedBy: guessed ? "model-window" : "thread",
    requests: requests.size,
    byProvider,
    failures,
    providerSequence,
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

/** Whether the rollout's latest turn has started and not yet completed or aborted, read from its tail. */
export function hasOpenTurn(file: string): boolean {
  const size = statSync(file).size;
  const length = Math.min(size, 256 * 1024);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    // A long turn's start can lie far before the tail; read the whole file then.
    const text = buffer.toString("utf8");
    const markers = (source: string) => ({
      started: source.lastIndexOf('"type":"task_started"'),
      ended: Math.max(
        source.lastIndexOf('"type":"task_complete"'),
        source.lastIndexOf('"type":"turn_aborted"')
      )
    });
    let { started, ended } = markers(text);
    if (started < 0 && ended < 0 && length < size)
      ({ started, ended } = markers(readFileSync(file, "utf8")));
    return started > ended;
  } finally {
    closeSync(fd);
  }
}

function sha(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Installed runtime modules that differ from the checkout: the running services execute the installed copies. */
function deploymentDrift(
  codexHome: string,
  repoRoot: string | null | undefined
): LiveReport["drift"] {
  const installedRoot = path.join(codexHome, "src");
  if (
    !repoRoot ||
    !existsSync(path.join(repoRoot, "src")) ||
    !existsSync(installedRoot)
  )
    return null;
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
      const source = path.join(repoRoot, "src", rel);
      checked += 1;
      if (!existsSync(source)) missing.push(rel);
      else if (sha(source) !== sha(filePath)) differing.push(rel);
    }
  };
  visit(installedRoot);
  return { checked, differing, missing };
}

async function liveReport(options: TraceOptions): Promise<LiveReport> {
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
    const status = parseRouterStatus(parsed);
    router = {
      reachable: true,
      canonicalLiveCount:
        typeof status?.agents?.canonicalLiveCount === "number"
          ? status.agents.canonicalLiveCount
          : null,
      byState: status?.agents?.byState ?? null,
      liveByRole: status?.agents?.liveByRole ?? null,
      startedAt: typeof status?.startedAt === "string" ? status.startedAt : null
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
    router,
    openThreads,
    processes: providerProcesses(),
    services: services(),
    drift: deploymentDrift(options.codexHome, options.repoRoot)
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

export async function buildReport(options: TraceOptions): Promise<TraceReport> {
  const threads = findSessionRollouts(
    path.join(options.codexHome, "sessions"),
    options.id
  ).map((file) => traceThread(file, options.items));
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
  return {
    threads,
    router: threads.map((thread) =>
      summarizeRouter(thread, rows, options.events ?? false)
    ),
    logs: logFreshness(options.codexHome),
    live: options.offline ? null : await liveReport(options)
  };
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
  for (const failure of router.failures)
    lines.push(
      `   ROUTER FAILURE ${failure.at.slice(11, 23)} ${failure.requestId.slice(0, 8)} ${failure.provider ?? "-"} ${failure.status ?? "-"} ${failure.failureClass ?? "-"} ${failure.elapsedMs ?? "-"}ms`
    );
  for (const event of router.events ?? []) {
    lines.push(
      `   ${event.at.slice(11, 23)} ${event.requestId.slice(0, 8)} ${event.phase} ${event.provider ?? "-"}/${event.model ?? "-"}` +
        `${event.outcome ? ` ${event.outcome}` : ""}${event.status ? ` ${event.status}` : ""}${event.failureClass ? ` ${event.failureClass}` : ""}` +
        `${event.elapsedMs === null ? "" : ` ${event.elapsedMs}ms`}${event.phase === "result" ? ` tools=${event.toolCalls ?? 0}` : ""}`
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
  router?: RouterSummary
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
  for (const failure of thread.toolFailures)
    lines.push(
      `   TOOL FAILED ${failure.at.slice(11, 19)} ${failure.tool} call=${failure.callId} :: ${failure.detail}`
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

export function renderReport(report: TraceReport): string {
  const out: string[] = [];
  if (report.threads.length === 0)
    out.push(
      "No rollout found for that id under <codex-home>/sessions. Try --recent."
    );
  for (const thread of report.threads) {
    const router = report.router.find((entry) => entry.thread === thread.id);
    out.push(...renderThreadSection(thread, router));
  }
  if (report.live) {
    out.push(...renderLiveSection(report.live));
  }
  out.push(
    "== log freshness (bridge logs carry no timestamps; correlate by order and mtime)"
  );
  for (const log of report.logs.slice(0, 8))
    out.push(
      `   ${log.modified} ${String(log.bytes).padStart(10)} ${log.file}`
    );
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

function parseArgs(
  argv: string[]
): (TraceOptions & { json: boolean; recent: number | null }) | null {
  const codexHomeDefault =
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  let id = "";
  let codexHome = codexHomeDefault;
  let routerLog = "";
  let items = false;
  let events = false;
  let json = false;
  let offline = false;
  let recent: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--items") items = true;
    else if (arg === "--events") events = true;
    else if (arg === "--json") json = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--codex-home") codexHome = argv[++index] ?? codexHome;
    else if (arg === "--router-log") routerLog = argv[++index] ?? "";
    else if (arg === "--recent")
      recent = DIGITS_ONLY_REGEX.test(argv[index + 1] ?? "")
        ? Number(argv[++index])
        : 10;
    else if (!arg.startsWith("--")) id = arg;
  }
  if (!id && recent === null) return null;
  return {
    id,
    codexHome,
    routerLog:
      routerLog ||
      path.join(codexHome, "run", "codex-model-router.launchd.err.log"),
    items,
    events,
    json,
    offline,
    recent,
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
      "usage: session-trace.ts <session-or-thread-id> [--items] [--events] [--json] [--codex-home DIR] [--router-log FILE] [--offline]\n       session-trace.ts --recent [N]\n"
    );
    process.exit(2);
  }
  if (options.recent === null) {
    const report = await buildReport(options);
    process.stdout.write(
      `${options.json ? JSON.stringify(report, null, 2) : renderReport(report)}\n`
    );
  } else {
    const sessions = recentSessions(
      path.join(options.codexHome, "sessions"),
      options.recent
    );
    process.stdout.write(
      `${options.json ? JSON.stringify(sessions, null, 2) : renderRecent(sessions)}\n`
    );
  }
}
