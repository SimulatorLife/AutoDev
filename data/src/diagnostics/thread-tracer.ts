/**
 * The per-thread rollout analyzer.
 *
 * A Codex rollout is a JSONL transcript of one thread: the root turn and every
 * subagent is its own file. This module turns one such file into the facts
 * the diagnostics report: the turns it ran, the silences longer than a minute
 * inside it, the tools it called, the calls that failed and why, how much it
 * investigated before it first edited a file, and what its tokens, compactions
 * and prompt overhead cost.
 *
 * The excerpt of a failure is redacted before it leaves this module: a
 * failing tool call's own arguments are the one place a credential can reach
 * a report.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  classifyToolFailure,
  clientSurfaceFromOriginator,
  type SessionInvestigation,
  type SessionThreadEfficiency,
  type SessionThreadTrace
} from "@simulatorlife/autodev-core";

import {
  parseSessionMetaPayload,
  type SessionMetaPayload
} from "./rollout-discovery.ts";
import type {
  MutableFailure,
  MutableGap,
  MutableInvestigation,
  MutableItem,
  MutableTurn
} from "./working-shapes.ts";

/** The `turn_context` record: carries the model the turn ran against. */
interface TurnContextPayload {
  model?: string;
  [key: string]: unknown;
}

/** A single content part attached to a `response_item`. */
interface ResponseContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** The `response_item` variants the tracer cares about. */
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
      summary?: unknown[];
      content?: ResponseContentPart[];
      [key: string]: unknown;
    }
  | {
      type: "custom_tool_call" | "function_call";
      name?: string;
      call_id?: string;
      id?: string;
      input?: unknown;
      arguments?: unknown;
      [key: string]: unknown;
    }
  | {
      type: "custom_tool_call_output" | "function_call_output";
      call_id?: string;
      output?: unknown;
      [key: string]: unknown;
    };

/** The `event_msg` variants the tracer cares about. */
type EventMsgPayload =
  | { type: "task_started"; turn_id?: string; [key: string]: unknown }
  | {
      type: "task_complete";
      turn_id?: string;
      last_agent_message?: string;
      error?: unknown;
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
  | { type: string; payload?: Record<string, unknown>; timestamp?: string };

const EXCERPT = 160;
const FAILURE_EXCERPT = 400;
const CACHE_DROP_MIN_INPUT = 10_000;
const CACHE_DROP_THRESHOLD = 0.5;
const GAP_SECONDS = 60;
/** Codebase-context MCP servers, as the target state names them. */
const CONTEXT_SERVERS: Readonly<
  Record<string, keyof SessionInvestigation["context"]>
> = {
  "cocoindex-code": "ccc",
  codegraphcontext: "cgc",
  lsp: "lsp"
};
/**
 * The `filesystem` MCP server's tools, by what they do to the investigation:
 * it is the one file surface, so its calls are the file reads, searches and
 * edits a thread made.
 */
const FILESYSTEM_SERVER = "filesystem";
const FILESYSTEM_READ_TOOLS = new Set([
  "read_text_file",
  "read_file",
  "read_media_file",
  "read_multiple_files"
]);
const FILESYSTEM_SEARCH_TOOLS = new Set(["search_files"]);
const FILESYSTEM_EDIT_TOOLS = new Set([
  "write_file",
  "edit_file",
  "append_file",
  "create_directory",
  "move_file",
  "copy_file"
]);
/** `item_completed` kinds that are not tool calls. */
const NON_TOOL_ITEMS = new Set([
  "UserMessage",
  "AgentMessage",
  "Reasoning",
  "FileChange"
]);
const TASK_OR_TURN_REGEX = /task_|turn_/u;
const TAG_ONLY_ASSISTANT_MESSAGE_REGEX =
  /^<([a-z][a-z0-9_-]*)>\s*<\/([a-z][a-z0-9_-]*)>$/iu;
const SKILLS_INSTRUCTIONS_REGEX =
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/u;
const SKILL_CATALOG_LINE_REGEX =
  /^- ([A-Za-z0-9_.-]+): [^\n]*\(file:[ \t]*(\S[^)\n]*\/SKILL\.md)\)[ \t]*$/gmu;
const SKILL_READ_FILE_REGEX = /([A-Za-z0-9_.-]+)\/SKILL\.md\b/gu;
const TOOL_FAILURE =
  /Encountered error in tool execution|Delegation is unavailable|tool call failed|Transport closed|Command blocked by PreToolUse hook|Script failed|Script error|^aborted|No such tool|not found in ALL_TOOLS/imu;
/**
 * The credentials that must never reach a report.
 *
 * A failing tool call's excerpt carries the command that failed, and that
 * command carries whatever the caller passed it. These three patterns cover
 * the three ways a credential gets there: a bearer header, a provider's key
 * prefix, and an environment or flag assignment.
 */
const BEARER_TOKEN_REGEX = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const PROVIDER_KEY_REGEX =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})\b/gu;
const SECRET_ASSIGNMENT_REGEX =
  /([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/giu;
const REDACTED = "[redacted]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove the credentials from an excerpt.
 *
 * The assignment form keeps the variable's name -- the name is the diagnostic
 * -- and replaces only its value.
 */
export function redactSecrets(text: string): string {
  return text
    .replaceAll(BEARER_TOKEN_REGEX, `$1${REDACTED}`)
    .replaceAll(PROVIDER_KEY_REGEX, REDACTED)
    .replaceAll(SECRET_ASSIGNMENT_REGEX, `$1${REDACTED}`);
}

function excerpt(value: unknown, maxLen = EXCERPT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
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
      const payload: ResponseItemPayload = { ...raw, type: "message" };
      if (typeof raw.role === "string") payload.role = raw.role;
      const content = parseContentParts(raw.content);
      if (content !== null) payload.content = content;
      return payload;
    }
    case "reasoning": {
      const payload: ResponseItemPayload = { ...raw, type: "reasoning" };
      if (typeof raw.id === "string") payload.id = raw.id;
      if (Array.isArray(raw.summary)) payload.summary = raw.summary;
      const content = parseContentParts(raw.content);
      if (content !== null) payload.content = content;
      return payload;
    }
    case "custom_tool_call":
    case "function_call": {
      const payload: ResponseItemPayload = { ...raw, type: raw.type };
      if (typeof raw.name === "string") payload.name = raw.name;
      if (typeof raw.call_id === "string") payload.call_id = raw.call_id;
      if (typeof raw.id === "string") payload.id = raw.id;
      return payload;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      const payload: ResponseItemPayload = { ...raw, type: raw.type };
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
      const payload: EventMsgPayload = { ...raw, type: "task_started" };
      if (typeof raw.turn_id === "string") payload.turn_id = raw.turn_id;
      return payload;
    }
    case "task_complete": {
      const payload: EventMsgPayload = { ...raw, type: "task_complete" };
      if (typeof raw.turn_id === "string") payload.turn_id = raw.turn_id;
      if (typeof raw.last_agent_message === "string")
        payload.last_agent_message = raw.last_agent_message;
      return payload;
    }
    case "turn_aborted": {
      const payload: EventMsgPayload = { ...raw, type: "turn_aborted" };
      if (typeof raw.turn_id === "string") payload.turn_id = raw.turn_id;
      if (typeof raw.reason === "string") payload.reason = raw.reason;
      return payload;
    }
    default: {
      return { ...raw, type: raw.type };
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

function itemDetail(
  payload: ResponseItemPayload | Record<string, unknown>
): string {
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

/** The tools a call reached: its own name, plus every `tools.<name>(` it calls. */
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
      /tools\.([A-Za-z0-9_]+)\s*\(/gu
    )) {
      if (match[1]) nested.push(match[1]);
    }
    return nested.length > 0 ? nested : ["exec"];
  }
  return [name];
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
  initialDeveloperChars: number;
  skillsCatalogBytes: number;
  loadedSkills: Set<string>;
  skillsByRoot: Record<string, number>;
  /** SKILL.md reads per skill name: one per tool call that names it. */
  skillReadCounts: Map<string, number>;
}

interface ThreadTraceAccumulator {
  counts: Record<string, number>;
  turns: MutableTurn[];
  open: Map<string, MutableTurn>;
  items: MutableItem[];
  gaps: MutableGap[];
  tools: Record<string, number>;
  toolFailures: MutableFailure[];
  callTools: Map<string, string>;
  callInputs: Map<string, string>;
  tagOnlyMessages: number;
  tagOnlySamples: string[];
  previous: { at: string; label: string } | null;
  investigation: MutableInvestigation;
  tokenState: TokenAccumulatorState;
  compaction: CompactionAccumulatorState;
  prompt: PromptAccumulatorState;
  cwd: string;
  reads: Set<string>;
  searchKeys: Set<string>;
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
      initialDeveloperChars: 0,
      skillsCatalogBytes: 0,
      loadedSkills: new Set(),
      skillsByRoot: {},
      skillReadCounts: new Map()
    },
    cwd: typeof meta.cwd === "string" ? meta.cwd : "/",
    reads: new Set(),
    searchKeys: new Set()
  };
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
  if (acc.previous && acc.open.size > 0) {
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
    acc.items.push({
      at,
      kind: payload.type,
      detail: itemDetail(payload),
      threadId: ""
    });
}

function callInputText(payload: ResponseItemPayload): string | null {
  if (payload.type !== "custom_tool_call" && payload.type !== "function_call")
    return null;
  const raw = payload.input ?? payload.arguments;
  if (raw === undefined || raw === null) return null;
  return redactSecrets(excerpt(raw, FAILURE_EXCERPT));
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
  const detail = redactSecrets(
    excerpt(text.slice(Math.max(0, failure.index - 40)))
  );
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
  // One call that names a SKILL.md twice (a cat, then a sed of the same file)
  // read it once; a later call that names it again read it again.
  const skillsInCall = new Set<string>();
  for (const match of raw.matchAll(SKILL_READ_FILE_REGEX)) {
    if (match[1]) skillsInCall.add(match[1]);
  }
  const counts = acc.prompt.skillReadCounts;
  for (const skill of skillsInCall)
    counts.set(skill, (counts.get(skill) ?? 0) + 1);
}

/**
 * A string's length in Unicode code points.
 *
 * A surrogate pair is one code point and an unpaired surrogate is one; this
 * is the length `Array.from(text)` reports, without building the array.
 */
export function countCodePoints(text: string): number {
  let pairs = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    const high = text.charCodeAt(index);
    if (high < 0xd8_00 || high > 0xdb_ff) continue;
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc_00 && low <= 0xdf_ff) {
      pairs += 1;
      index += 1;
    }
  }
  return text.length - pairs;
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
  acc.prompt.initialDeveloperChars += countCodePoints(text);
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
  item: Record<string, unknown>,
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
  payload: Record<string, unknown>,
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
  if (kind === "FileChange" || isFilesystemEdit(kind, item)) {
    investigation.firstEditAt = at ?? "";
    return;
  }
  if (NON_TOOL_ITEMS.has(kind)) return;
  investigation.toolCalls += 1;
  if (kind === "CommandExecution") recordCommandInvestigation(item, acc);
  else if (kind === "McpToolCall" && typeof item.server === "string") {
    if (item.server === FILESYSTEM_SERVER)
      recordFilesystemInvestigation(item, acc);
    const server = CONTEXT_SERVERS[item.server];
    if (server) investigation.context[server] += 1;
  }
}

function isFilesystemEdit(kind: string, item: Record<string, unknown>): boolean {
  return (
    kind === "McpToolCall" &&
    item.server === FILESYSTEM_SERVER &&
    typeof item.tool === "string" &&
    FILESYSTEM_EDIT_TOOLS.has(item.tool)
  );
}

/** A `filesystem` read or search, counted like the shell's own. */
function recordFilesystemInvestigation(
  item: Record<string, unknown>,
  acc: ThreadTraceAccumulator
): void {
  const tool = typeof item.tool === "string" ? item.tool : "";
  const args = isRecord(item.arguments) ? item.arguments : {};
  if (FILESYSTEM_READ_TOOLS.has(tool)) {
    const paths = Array.isArray(args.paths) ? args.paths : [args.path];
    for (const file of paths)
      if (typeof file === "string") recordReadInvestigation(acc.cwd, file, acc);
  } else if (FILESYSTEM_SEARCH_TOOLS.has(tool)) {
    const query = typeof args.pattern === "string" ? args.pattern : "";
    const searchPath = typeof args.path === "string" ? args.path : ".";
    recordSearchInvestigation(acc.cwd, query, searchPath, acc);
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

function finiteNonNegative(record: unknown, key: string): number {
  if (!isRecord(record)) return 0;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function recordTokenEfficiency(
  payload: Record<string, unknown>,
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
  const state = acc.tokenState;
  if (state.prevRawTotal === rawTotal && state.prevRawIn === rawIn) return;
  if (state.prevRawTotal !== null && rawTotal < state.prevRawTotal) {
    state.offsetIn += state.prevRawIn ?? 0;
    state.offsetCached += state.prevRawCached;
    state.offsetOut += state.prevRawOut;
    state.offsetReas += state.prevRawReas;
    state.offsetTotal += state.prevRawTotal;
    state.prevLastInput = 0;
  }
  state.prevRawIn = rawIn;
  state.prevRawCached = rawCached;
  state.prevRawOut = rawOut;
  state.prevRawReas = rawReas;
  state.prevRawTotal = rawTotal;
  state.observed = true;
  state.samples += 1;

  const last = isRecord(payload.info.last_token_usage)
    ? payload.info.last_token_usage
    : null;
  const lastIn = finiteNonNegative(last, "input_tokens");
  const lastCached = finiteNonNegative(last, "cached_input_tokens");
  if (lastIn > state.peakInputTokens) state.peakInputTokens = lastIn;
  if (
    state.prevLastInput >= CACHE_DROP_MIN_INPUT &&
    lastIn >= CACHE_DROP_MIN_INPUT &&
    lastCached < Math.min(state.prevLastInput, lastIn) * CACHE_DROP_THRESHOLD
  ) {
    state.cacheDrops += 1;
  }
  if (lastIn > 0) state.prevLastInput = lastIn;
}

function recordCompactionRecord(
  record: RolloutPayload,
  acc: ThreadTraceAccumulator
): void {
  if (record.type === "compacted") {
    acc.compaction.compactedRecords += 1;
    const replacementHistory =
      isRecord(record.payload) &&
      Array.isArray(record.payload.replacement_history)
        ? record.payload.replacement_history
        : null;
    if (!replacementHistory) return;
    const serializedBytes = Buffer.byteLength(
      JSON.stringify(replacementHistory),
      "utf8"
    );
    const imageCount = countImageObjects(replacementHistory);
    acc.compaction.maxReplacementItems = Math.max(
      acc.compaction.maxReplacementItems,
      replacementHistory.length
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
  turns: Record<string, unknown>,
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
  turnIds: readonly string[]
): number | null {
  if (!codexHome) return null;
  const dir = path.join(codexHome, "run", "skill-read-telemetry");
  const candidates: { file: string; filter: Set<string> | null }[] = [
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

function skillReadSummary(counts: ReadonlyMap<string, number>): {
  skillsRead: string[];
  skillReadCounts: Record<string, number>;
} {
  const skillsRead = [...counts.keys()].sort();
  const skillReadCounts: Record<string, number> = {};
  for (const skill of skillsRead)
    skillReadCounts[skill] = counts.get(skill) ?? 0;
  return { skillsRead, skillReadCounts };
}

function buildThreadEfficiency(
  acc: ThreadTraceAccumulator,
  codexHome: string | null,
  threadId: string,
  sessionId: string | null
): SessionThreadEfficiency {
  const state = acc.tokenState;
  const inputTokens = state.offsetIn + (state.prevRawIn ?? 0);
  const cachedInputTokens = state.offsetCached + state.prevRawCached;
  const outputTokens = state.offsetOut + state.prevRawOut;
  const reasoningOutputTokens = state.offsetReas + state.prevRawReas;
  const totalTokens = state.offsetTotal + (state.prevRawTotal ?? 0);
  const compaction = acc.compaction;
  const prompt = acc.prompt;
  return {
    tokens: {
      observed: state.observed,
      samples: state.samples,
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
      peakInputTokens: state.peakInputTokens,
      cacheDrops: state.cacheDrops
    },
    compaction: {
      count: Math.max(
        compaction.compactedRecords,
        compaction.contextCompactedEvents
      ),
      contextCompactedEvents: compaction.contextCompactedEvents,
      maxReplacementItems: compaction.maxReplacementItems,
      maxReplacementBytes: compaction.maxReplacementBytes,
      maxReplacementImages: compaction.maxReplacementImages,
      responseImageItems: compaction.responseImageItems
    },
    prompt: {
      initialDeveloperBytes: prompt.initialDeveloperBytes,
      initialDeveloperChars: prompt.initialDeveloperChars,
      // No tokenizer for the thread's provider model ships with the engine,
      // and a rollout's token usage is per request, not per message.
      initialDeveloperTokens: null,
      skillsCatalogBytes: prompt.skillsCatalogBytes,
      skillsLoaded: prompt.loadedSkills.size,
      skillsByRoot: prompt.skillsByRoot,
      ...skillReadSummary(prompt.skillReadCounts),
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
  options: { withItems: boolean; codexHome?: string | undefined }
): SessionThreadTrace {
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
    // A root thread carries no agent_role; it is the orchestrator.
    role:
      typeof meta.agent_role === "string"
        ? meta.agent_role
        : meta.thread_source === "subagent"
          ? null
          : "orchestrator",
    model: typeof context.model === "string" ? context.model : null,
    modelProvider:
      typeof meta.model_provider === "string" ? meta.model_provider : null,
    cliVersion: typeof meta.cli_version === "string" ? meta.cli_version : null,
    clientSurface: clientSurfaceFromOriginator(
      typeof meta.originator === "string" ? meta.originator : null
    ),
    cwd: typeof meta.cwd === "string" ? meta.cwd : null,
    file,
    start,
    end,
    counts: acc.counts,
    turns: acc.turns,
    gaps: [...acc.gaps].sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    tools: acc.tools,
    toolFailures: acc.toolFailures,
    ...(acc.tagOnlyMessages > 0
      ? {
          anomalies: {
            tagOnlyMessages: acc.tagOnlyMessages,
            samples: acc.tagOnlySamples
          }
        }
      : {}),
    efficiency: buildThreadEfficiency(acc, resolvedHome, id, sessionId),
    investigation: acc.investigation,
    ...(options.withItems
      ? { items: acc.items.map((item) => ({ ...item, threadId: id })) }
      : {})
  };
}

/** How a thread's rollout should be read. */
export interface TraceThreadOptions {
  /** Collect the truncated rollout items as well as the summary. */
  readonly items: boolean;
  /** The `$CODEX_HOME` the rollout belongs to; inferred from the path when absent. */
  readonly codexHome?: string | undefined;
}

/**
 * Read one rollout into the thread's facts.
 *
 * The rollout is untrusted JSON: every record is parsed defensively and a
 * malformed line is skipped rather than aborting the read.
 */
export function traceThread(
  file: string,
  options: TraceThreadOptions
): SessionThreadTrace {
  const records = readJsonl(file);
  const { meta, context } = traceMetadata(records);
  const acc = createTraceAccumulator(meta);
  for (const record of records)
    accumulateTraceRecord(record, options.items, acc);
  return buildThreadTrace(file, records, meta, context, acc, {
    withItems: options.items,
    codexHome: options.codexHome
  });
}

/** The SHA-256 of a file's bytes, used for the deployment-drift comparison. */
export function fileDigest(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
