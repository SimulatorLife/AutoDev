import {
  dropUnresolvableReasoning,
  normalizeInputItemIds
} from "@simulatorlife/autodev-runtime/shared/responses-item-ids";
import { MULTI_AGENT_NAMESPACE } from "@simulatorlife/autodev-runtime/shared/tool-names";

/**
 * Flat prefixes the router recognizes when un-flattening an inbound response.
 *
 * A model answers with a flat `namespace__name`, and the router splits it back
 * into the `namespace`/`name` pair the provider expects. Only names carrying one
 * of these prefixes are split: an unprefixed tool name that merely contains a
 * double underscore must survive untouched.
 *
 * The table is module-private. Nothing outside here reads it, and keeping it
 * exported made the router advertise a vocabulary it does not share -- while
 * also duplicating the versioned `multi_agent_v1` namespace that
 * `shared/tool-names.ts` owns. That one is now derived from
 * `MULTI_AGENT_NAMESPACE` so bumping the versioned namespace cannot leave the
 * router recognizing last version's prefix.
 */
const FLATTENED_NAMESPACES: readonly (readonly [string, string])[] =
  Object.freeze([
    [MULTI_AGENT_NAMESPACE, `${MULTI_AGENT_NAMESPACE}__`],
    ["collaboration", "collaboration__"],
    ["agents", "agents__"]
  ]);

export interface RouterResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RouterResponseOutputTextContent {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface RouterResponseMessageItem {
  type: "message";
  role: "assistant";
  status: "completed";
  content: RouterResponseOutputTextContent[];
}

export type RouterResponseItem =
  | RouterResponseMessageItem
  | {
      type: string;
      id?: string;
      role?: string;
      status?: string;
      content?: unknown;
      [key: string]: unknown;
    };

export interface RouterResponseIncompleteDetails {
  reason?: string;
  [key: string]: unknown;
}

export interface RouterResponseEnvelope {
  id?: string;
  object?: "response";
  status?: string;
  output_text?: string;
  output?: RouterResponseItem[];
  output_index?: number;
  usage?: RouterResponseUsage;
  incomplete_details?: RouterResponseIncompleteDetails;
  [key: string]: unknown;
}

export interface RouterProviderRouteLike {
  provider: string;
  [key: string]: unknown;
}

export interface UpstreamPayloadOptions {
  wantsStream?: boolean;
  requestId?: string | null;
  dropUnresolvableReasoning?: (input: unknown) => {
    input: unknown;
    dropped: number;
  };
  normalizeInputItemIds?: (input: unknown) => {
    input: unknown;
    changed: number;
  };
  normalizeItemIds?: boolean;
  recordEvent?: (event: Record<string, unknown>) => void;
  requestedModel?: string | null;
}

export interface UpstreamShapeHooks {
  dropUnresolvableReasoning: (input: unknown) => {
    input: unknown;
    dropped: number;
  };
  normalizeInputItemIds: (input: unknown) => {
    input: unknown;
    changed: number;
  };
  normalizeItemIds?: boolean;
  recordEvent: (event: Record<string, unknown>) => void;
  requestedModel?: string | null;
  shouldNormalizeItemIds: boolean;
  shouldDropUnresolvableReasoning: boolean;
}

const TOOL_OUTPUT_TYPES = new Set([
  "function_call",
  "computer_call",
  "custom_tool_call",
  "code_interpreter_call"
]);
const SSE_LINE_WITH_NEWLINE_PATTERN = /(\r?\n)/;

function getNamespacePrefix(ns: string): string {
  const match = FLATTENED_NAMESPACES.find((entry) => entry[0] === ns);
  return match ? match[1] : `${ns}__`;
}

export function flattenOutboundTool(
  tool: unknown,
  defaultNamespace: string | null = null
): unknown {
  if (!isRecord(tool)) return tool;
  const ns =
    (typeof tool.namespace === "string" ? tool.namespace : defaultNamespace) ??
    null;
  const prefix = ns ? getNamespacePrefix(ns) : "";
  const result: Record<string, unknown> = { ...tool };
  delete result.namespace;
  if (result.type === "namespace") result.type = "function";
  if (prefix) {
    if (typeof result.name === "string" && !result.name.startsWith(prefix)) {
      result.name = `${prefix}${result.name}`;
    }
    if (
      isRecord(result.function) &&
      typeof result.function.name === "string" &&
      !result.function.name.startsWith(prefix)
    ) {
      result.function = {
        ...result.function,
        name: `${prefix}${result.function.name}`
      };
    }
  }
  return result;
}

export function flattenOutboundTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  const flattened: unknown[] = [];
  for (const item of tools) {
    if (!isRecord(item)) {
      flattened.push(item);
      continue;
    }
    const ns =
      item.type === "namespace"
        ? (item.name ?? item.namespace)
        : item.namespace;
    if (typeof ns === "string" && Array.isArray(item.tools)) {
      for (const innerTool of item.tools) {
        if (isRecord(innerTool))
          flattened.push(flattenOutboundTool(innerTool, ns));
      }
    } else {
      flattened.push(flattenOutboundTool(item));
    }
  }
  return flattened;
}

/**
 * Copy-on-write rewriters.
 *
 * These return the value they were handed when nothing underneath them needed
 * changing, and only allocate along a path that actually did. That is what
 * makes "did this event need rewriting at all?" answerable as a reference
 * comparison, which in turn lets the SSE drain skip re-serializing the frames
 * that only carry deltas -- the overwhelming majority of them.
 *
 * They never mutate the input: a changed node is copied before it is written to,
 * so a caller holding the original parse still sees the original values. That
 * matters because the drain inspects and counts from the same parse it rewrites.
 */
interface RewriteTrace {
  value: boolean;
}

/**
 * The shared copy-on-write traversal. A child that comes back identical leaves
 * the container untouched; the first child that differs copies the container
 * once, before writing, so the input is never mutated.
 */
function rewriteListSharing<T>(
  list: readonly T[],
  rewriteChild: (child: T) => T
): readonly T[] {
  let out: T[] = list as T[];
  for (const [index, child] of list.entries()) {
    const next = rewriteChild(child);
    if (next === child) continue;
    if (out === list) out = list.slice() as T[];
    out[index] = next;
  }
  return out;
}

function rewriteRecordSharing(
  record: Record<string, unknown>,
  rewriteChild: (key: string, child: unknown) => unknown
): Record<string, unknown> {
  let out: Record<string, unknown> = record;
  for (const [key, child] of Object.entries(record)) {
    const next = rewriteChild(key, child);
    if (next === child) continue;
    if (out === record) out = { ...record };
    out[key] = next;
  }
  return out;
}

/** Splits a flattened `namespace__name` into its two fields, once per record. */
function splitFlattenedNamespace(
  record: Record<string, unknown>,
  trace: RewriteTrace
): Record<string, unknown> {
  const name = record.name;
  if (typeof name !== "string") return record;
  if (record.namespace !== undefined && record.namespace !== null)
    return record;
  const match = FLATTENED_NAMESPACES.find(([, prefix]) =>
    name.startsWith(prefix)
  );
  if (!match) return record;
  trace.value = true;
  return { ...record, namespace: match[0], name: name.slice(match[1].length) };
}

function rewriteToolNamespacesSharing(
  value: unknown,
  trace: RewriteTrace
): unknown {
  if (Array.isArray(value))
    return rewriteListSharing(value, (child) =>
      rewriteToolNamespacesSharing(child, trace)
    );
  if (value === null || !isRecord(value)) return value;
  return splitFlattenedNamespace(
    rewriteRecordSharing(value, (_key, child) =>
      rewriteToolNamespacesSharing(child, trace)
    ),
    trace
  );
}

function replaceModelFieldsSharing(
  value: unknown,
  publicModel: string,
  trace: RewriteTrace
): unknown {
  if (Array.isArray(value))
    return rewriteListSharing(value, (child) =>
      replaceModelFieldsSharing(child, publicModel, trace)
    );
  if (value === null || !isRecord(value)) return value;
  return rewriteRecordSharing(value, (key, child) => {
    if (key !== "model" || typeof child !== "string")
      return replaceModelFieldsSharing(child, publicModel, trace);
    if (child === publicModel) return child;
    trace.value = true;
    return publicModel;
  });
}

export function rewriteToolNamespaces(value: unknown): unknown {
  return rewriteToolNamespacesSharing(value, { value: false });
}

export function replaceModelFields(
  value: unknown,
  publicModel: string
): unknown {
  return replaceModelFieldsSharing(value, publicModel, { value: false });
}

export function rewriteResponseValue(
  value: unknown,
  publicModel: string
): unknown {
  return rewriteToolNamespaces(replaceModelFields(value, publicModel));
}

export interface ResponseRewrite {
  readonly value: unknown;
  readonly changed: boolean;
}

/**
 * `rewriteResponseValue`, plus whether anything actually changed.
 *
 * A `changed: false` result means the rewrite was a no-op and the caller can
 * emit the bytes it already has instead of paying for a `JSON.stringify`.
 */
export function rewriteResponseValueTracking(
  value: unknown,
  publicModel: string
): ResponseRewrite {
  const trace: RewriteTrace = { value: false };
  const replaced = replaceModelFieldsSharing(value, publicModel, trace);
  const rewritten = rewriteToolNamespacesSharing(replaced, trace);
  return { value: rewritten, changed: trace.value };
}

export function transformSseEvent(event: string, publicModel: string): string {
  return processSseEvent(event, { publicModel }).output;
}

/** Collect the call ids of the tool calls in a response, or in one output item. */
export function collectToolCallIds(value: unknown, into: Set<string>): void {
  if (!isRecord(value)) return;
  if (Array.isArray(value.output)) {
    for (const item of value.output) collectToolCallIds(item, into);
    return;
  }
  if (
    typeof value.type === "string" &&
    TOOL_OUTPUT_TYPES.has(value.type) &&
    typeof value.call_id === "string" &&
    value.call_id
  )
    into.add(value.call_id);
}

export function countToolCallsInResponse(
  response: unknown,
  seen: Set<string> = new Set()
): number {
  if (!isRecord(response) || !Array.isArray(response.output)) return 0;
  let count = 0;
  for (const item of response.output) {
    if (
      isRecord(item) &&
      typeof item.type === "string" &&
      TOOL_OUTPUT_TYPES.has(item.type) &&
      typeof item.id === "string" &&
      !seen.has(item.id)
    ) {
      seen.add(item.id);
      count += 1;
    }
  }
  return count;
}

export function countToolCallsFromSse(
  body: string,
  seen: Set<string> = new Set()
): number {
  let count = 0;
  for (const line of body.split(SSE_LINE_WITH_NEWLINE_PATTERN)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (isRecord(event)) count += countToolCallInEvent(event, seen);
    } catch {
      // Ignore malformed/non-JSON SSE lines.
    }
  }
  return count;
}

/** The tool-call contribution of one already-parsed SSE event. */
function countToolCallInEvent(
  event: Record<string, unknown>,
  seen: Set<string>
): number {
  if (
    event.type === "response.output_item.added" &&
    isRecord(event.item) &&
    typeof event.item.type === "string" &&
    TOOL_OUTPUT_TYPES.has(event.item.type) &&
    typeof event.item.id === "string" &&
    !seen.has(event.item.id)
  ) {
    seen.add(event.item.id);
    return 1;
  }
  if (event.type === "response.completed" && isRecord(event.response))
    return countToolCallsInResponse(event.response, seen);
  return 0;
}

export interface ProcessedSseEvent {
  readonly output: string;
  readonly toolCalls: number;
}

export interface ProcessSseEventOptions {
  readonly publicModel: string;
  readonly seenToolCalls?: Set<string>;
  /**
   * Called once per successfully parsed `data:` payload, with the event exactly
   * as it arrived. The rewriters are copy-on-write, so the object observed here
   * is still the unmodified parse even when the rewrite changed something.
   */
  readonly onParsed?: (event: Record<string, unknown>) => void;
}

/**
 * One pass over one SSE frame: inspect it, count its tool calls, and emit the
 * rewritten bytes.
 *
 * The drain loop used to do this as three independent passes over the same
 * frame -- inspect, count, transform -- which meant three splits and three
 * `JSON.parse` calls of identical bytes, plus two full deep rebuilds and a
 * `JSON.stringify` even for the frames that needed no rewrite at all. Since
 * every chunk of every streaming response goes through here, that redundancy
 * was the router's hottest avoidable cost.
 *
 * `changed` from the rewrite is what makes the output honest as well as cheap:
 * an untouched frame is emitted byte-for-byte instead of being round-tripped
 * through `JSON.stringify`, so the proxy stops normalizing whitespace in frames
 * it was never modifying.
 */
export function processSseEvent(
  frame: string,
  options: ProcessSseEventOptions
): ProcessedSseEvent {
  const seen = options.seenToolCalls ?? new Set<string>();
  let toolCalls = 0;
  let output = "";
  for (const line of frame.split(SSE_LINE_WITH_NEWLINE_PATTERN)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") {
      output += line;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      output += line;
      continue;
    }
    if (isRecord(parsed)) {
      options.onParsed?.(parsed);
      toolCalls += countToolCallInEvent(parsed, seen);
    }
    const { value, changed } = rewriteResponseValueTracking(
      parsed,
      options.publicModel
    );
    output += changed ? `data: ${JSON.stringify(value)}` : line;
  }
  return { output, toolCalls };
}

export interface BufferedSseSummary {
  /** First `response.completed` that carried an object response, else null. */
  readonly firstCompleted: Record<string, unknown> | null;
  /** The last `response.completed` payload seen, verbatim. */
  readonly lastCompleted: unknown;
  readonly text: string;
  readonly toolCalls: number;
}

/**
 * Everything the buffered (non-streaming) path needs from an SSE body, in one
 * pass.
 *
 * It used to call `completedResponseFromSse`, `countToolCallsFromSse` and
 * `responseTextFromSse` back to back, each of which split and re-parsed the
 * entire body. A buffered Codex response is the whole conversation output, so
 * that was three full JSON parses of a large payload to answer three questions
 * one answer could answer.
 */
export function summarizeBufferedSse(body: string): BufferedSseSummary {
  let text = "";
  let firstCompleted: Record<string, unknown> | null = null;
  let lastCompleted: unknown = null;
  let toolCalls = 0;
  const seen = new Set<string>();
  for (const line of body.split(SSE_LINE_WITH_NEWLINE_PATTERN)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      // Ignore non-JSON SSE comments and provider keep-alives.
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "response.output_text.delta")
      text += String(event.delta ?? "");
    if (event.type === "response.completed") {
      lastCompleted = event.response;
      const response = event.response;
      if (
        firstCompleted === null &&
        response !== null &&
        response !== undefined &&
        typeof response === "object"
      )
        firstCompleted = response as Record<string, unknown>;
    }
    toolCalls += countToolCallInEvent(event, seen);
  }
  return { firstCompleted, lastCompleted, text, toolCalls };
}

/** The response envelope the buffered path sends downstream. */
export function bufferedEnvelope(
  summary: BufferedSseSummary
): RouterResponseEnvelope {
  return buildCompletedResponse(
    summary.text,
    isRecord(summary.lastCompleted)
      ? { completedResponse: summary.lastCompleted }
      : {}
  );
}

export function responseTextFromSse(body: string): RouterResponseEnvelope {
  return bufferedEnvelope(summarizeBufferedSse(body));
}

export function buildCompletedResponse(
  text: string,
  extras: { id?: string; completedResponse?: unknown } = {}
): RouterResponseEnvelope {
  const completed = extras.completedResponse;
  if (isRecord(completed)) {
    return {
      ...(completed as Record<string, unknown>),
      output_text:
        typeof completed.output_text === "string"
          ? completed.output_text
          : text,
      output:
        Array.isArray(completed.output) && completed.output.length > 0
          ? (completed.output as RouterResponseItem[])
          : completedEnvelopeMessage(text)
    } as RouterResponseEnvelope;
  }
  return {
    ...(extras.id === undefined
      ? { id: `router_${Date.now()}` }
      : { id: extras.id }),
    object: "response",
    status: "completed",
    output_text: text,
    output: completedEnvelopeMessage(text),
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}

function completedEnvelopeMessage(text: string): RouterResponseMessageItem[] {
  return [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }]
    }
  ];
}

const DEFAULT_HOOKS: UpstreamShapeHooks = {
  dropUnresolvableReasoning: (input) => {
    const res = dropUnresolvableReasoning(input);
    return { input: res.input, dropped: res.dropped };
  },
  normalizeInputItemIds: (input) => {
    const res = normalizeInputItemIds(input);
    return { input: res.input, changed: res.changed };
  },
  recordEvent: () => undefined,
  shouldNormalizeItemIds: true,
  shouldDropUnresolvableReasoning: true
};

let currentHooks: UpstreamShapeHooks = DEFAULT_HOOKS;

export function setUpstreamShapeHooks(
  hooks: Partial<UpstreamShapeHooks>
): void {
  currentHooks = { ...DEFAULT_HOOKS, ...currentHooks, ...hooks };
}

export function resetUpstreamShapeHooks(): void {
  currentHooks = DEFAULT_HOOKS;
}

/**
 * Apply Codex-specific reasoning drop and item-id normalization to the payload,
 * leaving non-Codex routes untouched. The router installs hooks that report
 * what was dropped/changed; tests can supply minimal hooks that capture them.
 */
function normalizePayloadInput(
  route: RouterProviderRouteLike,
  payload: Record<string, unknown>,
  requestId: string | null | undefined,
  hooks: UpstreamShapeHooks
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...payload };
  if (route.provider === "codex" && hooks.shouldDropUnresolvableReasoning) {
    const dropped = hooks.dropUnresolvableReasoning(result.input);
    if (dropped.dropped > 0) {
      result.input = dropped.input;
      hooks.recordEvent({
        phase: "foreign_reasoning_dropped",
        requestId,
        requestedModel: payload.model ?? null,
        provider: route.provider,
        model: result.model ?? null,
        droppedReasoningItems: dropped.dropped
      });
    }
  }
  if (hooks.shouldNormalizeItemIds) {
    const normalized = hooks.normalizeInputItemIds(result.input);
    if (normalized.changed > 0) {
      result.input = normalized.input;
      hooks.recordEvent({
        phase: "item_ids_normalized",
        requestId,
        requestedModel: payload.model ?? null,
        provider: route.provider,
        model: result.model ?? null,
        normalizedItemIds: normalized.changed
      });
    }
  }
  return result;
}

export function upstreamPayload(
  route: RouterProviderRouteLike,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string | null = null,
  hooks: UpstreamShapeHooks = currentHooks,
  options: { normalizeItemIds?: boolean } = {}
): Record<string, unknown> {
  // `extra_headers` is an SDK escape hatch a proxy consumes as outbound HTTP
  // headers. Never pass the caller's value through the router: doing so would
  // bypass the router's credential and header allowlist. Every provider now
  // sits behind a local adapter the router calls directly, so the router's own
  // headers travel as real headers and nothing needs to ride in the body.
  const { extra_headers: _discarded, ...safePayload } = payload as {
    extra_headers?: unknown;
  } & Record<string, unknown>;
  void _discarded;
  const normalizeItemIds =
    options.normalizeItemIds ?? hooks.shouldNormalizeItemIds ?? true;
  const hookOptions: UpstreamShapeHooks = {
    ...hooks,
    shouldNormalizeItemIds: normalizeItemIds
  };
  const prepared = normalizeItemIds
    ? normalizePayloadInput(
        route,
        safePayload as Record<string, unknown>,
        requestId,
        hookOptions
      )
    : ({ ...safePayload } as Record<string, unknown>);
  if (route.provider !== "codex" && Array.isArray(prepared.tools)) {
    prepared.tools = flattenOutboundTools(prepared.tools);
  }
  return route.provider === "codex"
    ? { ...prepared, stream: true, store: false }
    : { ...prepared, stream: wantsStream };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
