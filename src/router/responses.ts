import {
  dropUnresolvableReasoning,
  normalizeInputItemIds
} from "../shared/responses-item-ids.ts";

export const FLATTENED_NAMESPACES = Object.freeze([
  ["multi_agent_v1", "multi_agent_v1__"],
  ["collaboration", "collaboration__"],
  ["agents", "agents__"]
] as const);

export type FlattenedNamespace = {
  readonly namespace: string;
  readonly prefix: string;
};

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

export function rewriteToolNamespaces(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) => rewriteToolNamespaces(item));
  if (value === null || !isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    result[key] = rewriteToolNamespaces(child)!;
  if (
    typeof result.name === "string" &&
    (result.namespace === undefined || result.namespace === null)
  ) {
    const match = FLATTENED_NAMESPACES.find(
      ([, prefix]) =>
        typeof result.name === "string" && result.name.startsWith(prefix)
    );
    if (match && typeof result.name === "string") {
      result.namespace = match[0];
      result.name = result.name.slice(match[1].length);
    }
  }
  return result;
}

export function replaceModelFields(
  value: unknown,
  publicModel: string
): unknown {
  if (Array.isArray(value))
    return value.map((item) => replaceModelFields(item, publicModel));
  if (value === null || !isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] =
      key === "model" && typeof item === "string"
        ? publicModel
        : replaceModelFields(item, publicModel);
  }
  return result;
}

export function rewriteResponseValue(
  value: unknown,
  publicModel: string
): unknown {
  return rewriteToolNamespaces(replaceModelFields(value, publicModel));
}

export function transformSseEvent(event: string, publicModel: string): string {
  return event
    .split(/(\r?\n)/)
    .map((line) => {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") return line;
      try {
        const parsed = JSON.parse(line.slice(6));
        const rewritten = rewriteResponseValue(parsed, publicModel);
        return `data: ${JSON.stringify(rewritten)}`;
      } catch {
        return line;
      }
    })
    .join("");
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
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (
        event.type === "response.output_item.added" &&
        isRecord(event.item) &&
        typeof event.item.type === "string" &&
        TOOL_OUTPUT_TYPES.has(event.item.type) &&
        typeof event.item.id === "string" &&
        !seen.has(event.item.id)
      ) {
        seen.add(event.item.id);
        count += 1;
      } else if (
        event.type === "response.completed" &&
        isRecord(event.response)
      ) {
        count += countToolCallsInResponse(event.response, seen);
      }
    } catch {
      // Ignore malformed/non-JSON SSE lines.
    }
  }
  return count;
}

export function responseTextFromSse(body: string): RouterResponseEnvelope {
  let text = "";
  let completed: unknown = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.output_text.delta")
        text += String(event.delta ?? "");
      if (event.type === "response.completed") completed = event.response;
    } catch {
      // Ignore non-JSON SSE comments and provider keep-alives.
    }
  }
  return buildCompletedResponse(
    text,
    isRecord(completed) ? { completedResponse: completed } : {}
  );
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
