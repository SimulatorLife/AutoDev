#!/usr/bin/env node

/**
 * Responses boundary adapter for the MiniMax API.
 *
 * Unlike the Claude, Antigravity, and Copilot bridges, this is a pass-through
 * to a remote API rather than a local CLI gateway. MiniMax speaks the Responses
 * API natively -- custom tools, namespace tools, and web search included -- so
 * the adapter keeps only what a direct transport cannot provide:
 *
 * - the machine boundary: only the credential and content negotiation headers
 *   leave the machine, and Codex's body-embedded turn metadata is dropped;
 * - freeform coercion for the `exec` tool when MiniMax answers it with JSON
 *   arguments, which Codex otherwise aborts as an incompatible payload;
 * - tool, activity, and MCP exposure telemetry for the router.
 *
 * Namespace flattening and item-id normalization belong to the router, which
 * applies them to every provider route.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { pathToFileURL } from "node:url";

import {
  readOnlySystemPromptInjection,
  resolveAgentRole
} from "@simulatorlife/autodev-runtime/agents";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import {
  type AgentEventReporter,
  resolveAgentEventReporter
} from "@simulatorlife/autodev-runtime/telemetry";

const MCP_EXPOSURE_SOURCE = "role_contract";

// Provider payloads are JSON-shaped but intentionally retain upstream fields we
// do not own. Keep the dynamic edge explicit while the transport and boundary
// operations remain typed.
type JsonRecord = Record<string, unknown>;
type EventTransform = (event: JsonRecord) => JsonRecord | JsonRecord[] | null;
type AgentReporter = AgentEventReporter;

const SSE_DATA_PREFIX_REGEX = /^data:\s*/u;
const TRAILING_CR_REGEX = /\r$/u;

// Bind the port only when run as a program. The rewriting helpers below are
// pure and worth testing directly; importing this file must not take the port
// out from under the running proxy. Mirrors the Antigravity bridge.
const IS_MAIN =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const host = process.env.MINIMAX_PROXY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MINIMAX_PROXY_PORT ?? "18765");
const upstreamBaseUrl =
  process.env.MINIMAX_PROXY_UPSTREAM_BASE_URL ?? "https://api.minimax.io";
// The only request headers that leave the machine. Codex attaches session,
// thread, window, and request identifiers plus `x-codex-turn-metadata`
// (absolute workspace paths, git remote URLs, commit hashes), and the router
// adds its own agent role, session, request-id, and agent-events URL headers.
// None of them mean anything to a remote API, so the upstream request is built
// from an allowlist rather than a denylist that would have to track every new
// local header. The MiniMax Responses API needs nothing beyond these.
const forwardedRequestHeaders = ["accept", "authorization", "content-type"];

const WEB_RESEARCH_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

function isWebResearchTool(tool: JsonRecord | null | undefined): boolean {
  if (!tool || typeof tool !== "object") return false;
  if (
    (typeof tool.type === "string" && WEB_RESEARCH_TOOL_NAMES.has(tool.type)) ||
    (typeof tool.name === "string" && WEB_RESEARCH_TOOL_NAMES.has(tool.name))
  )
    return true;
  const fn = tool.function as JsonRecord | undefined;
  if (fn && typeof fn.name === "string" && WEB_RESEARCH_TOOL_NAMES.has(fn.name))
    return true;
  return false;
}

// Codex duplicates its turn metadata -- absolute workspace paths, git remote
// URLs, commit hashes, installation and session ids -- into `client_metadata`
// in the request body. It is Codex-internal correlation that the MiniMax
// Responses API does not define, so it is removed before the payload leaves
// the machine. Everything else is the caller's own payload and is forwarded.
function rewriteOutboundPayload(
  payload: JsonRecord | null | undefined
): JsonRecord | null | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const { client_metadata: _clientMetadata, ...rewritten } = payload;
  return rewritten;
}

// Codex runs these models in code mode, where the whole tool surface is one
// freeform `custom` tool -- `exec` -- whose payload is raw JavaScript, not JSON
// arguments. MiniMax does not model freeform tools: it answers with an ordinary
// `function_call` carrying JSON, and Codex rejects the turn outright with
// "tool exec invoked with incompatible payload". Every MiniMax turn that tried
// to run a command died that way, which is why a MiniMax-served leaf could
// reason but never actually do anything.
//
// The names are learned from the request rather than hard-coded: Codex declares
// the tool with `"type": "custom"`, and in code mode it arrives inside an
// `additional_tools` input item rather than the top-level `tools` array. A
// renamed or additional freeform tool is therefore picked up automatically, and
// a payload that declares none leaves the response untouched.
function collectFreeformToolNames(
  payload: JsonRecord | null | undefined,
  names: Set<string> = new Set<string>()
): Set<string> {
  const visit = (tools: unknown): void => {
    for (const tool of Array.isArray(tools) ? tools : []) {
      if (!tool || typeof tool !== "object") continue;
      if (
        tool.type === "custom" &&
        typeof tool.name === "string" &&
        !isWebResearchTool(tool)
      )
        names.add(tool.name);
      if (Array.isArray(tool.tools)) visit(tool.tools);
    }
  };
  if (payload && typeof payload === "object") {
    visit(payload.tools);
    for (const item of Array.isArray(payload.input) ? payload.input : []) {
      if (item && typeof item === "object") visit(item.tools);
    }
  }
  return names;
}

function extractWrappedScript(parsed: Record<string, unknown>): string | null {
  for (const key of ["input", "code", "script", "source", "js", "javascript"]) {
    const val = parsed[key];
    if (typeof val === "string" && val.trim()) return val;
  }
  return null;
}

function synthesizeExecCommandScript(
  parsed: Record<string, unknown>
): string | null {
  if (
    typeof parsed.cmd !== "string" &&
    !Array.isArray(parsed.cmd) &&
    typeof parsed.command !== "string"
  ) {
    return null;
  }
  const call = { ...parsed };
  if (call.command !== undefined && call.cmd === undefined) {
    call.cmd = call.command;
    delete call.command;
  }
  return [
    `const result = await tools.exec_command(${JSON.stringify(call)});`,
    `text(typeof result === "string" ? result : JSON.stringify(result));`,
    ""
  ].join("\n");
}

// JavaScript equivalent to the JSON arguments MiniMax produced, or null when
// the intent is not clear enough to rewrite. Guessing wrong would swap one
// broken call for a different broken call, so an unrecognised shape is never
// translated; see unrecognisedFreeformFeedback for what the model is told.
function freeformInputFromArguments(argumentsText: unknown): string | null {
  const raw = typeof argumentsText === "string" ? argumentsText.trim() : "";
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all: the model wrote the script directly, which is exactly
    // what the tool wants.
    return raw;
  }
  if (typeof parsed === "string") return parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;

  const obj = parsed as Record<string, unknown>;
  return extractWrappedScript(obj) ?? synthesizeExecCommandScript(obj);
}

function describeArgumentsShape(raw: string): string {
  if (!raw) return "no arguments";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      return keys.length > 0
        ? `a JSON object with keys ${keys.map((key) => JSON.stringify(key)).join(", ")}`
        : "an empty JSON object";
    }
    const kind = Array.isArray(parsed)
      ? "array"
      : parsed === null
        ? "null"
        : typeof parsed;
    return `a JSON ${kind}`;
  } catch {
    return "arguments that are not JSON";
  }
}

// A freeform call whose arguments carry no recognisable source -- `{}`, or keys
// this adapter does not know -- cannot be translated without guessing. Left as
// a function_call, Codex rejects it as an incompatible payload and the model,
// told nothing, repeats the same call: 121 of 145 such historical MiniMax calls
// were followed by another identical broken one. The call instead becomes a
// script that fails with an explanation naming only the argument keys (never
// their values), so the model learns what the tool expects and can correct it.
function unrecognisedFreeformFeedback(
  toolName: string,
  argumentsText: unknown
): string {
  const raw = typeof argumentsText === "string" ? argumentsText.trim() : "";
  const shape = describeArgumentsShape(raw);
  const message = `${toolName} takes raw JavaScript source, not JSON arguments, and received ${shape}. Call ${toolName} again with a script, for example: const result = await tools.exec_command({ cmd: "ls" }); text(result);`;
  return `throw new Error(${JSON.stringify(message)});\n`;
}

function freeformSourceFor(toolName: string, argumentsText: unknown): string {
  return (
    freeformInputFromArguments(argumentsText) ??
    unrecognisedFreeformFeedback(toolName, argumentsText)
  );
}

/**
 * Per-response coercion of freeform tool calls.
 *
 * Stateful because the translation cannot happen until the arguments are
 * complete: the deltas carry JSON fragments and the script is only derivable
 * from the whole. Fragments for a coerced call are therefore dropped and the
 * finished source is emitted as one input delta at `done` time, which is also
 * how the bridges emit a spawn call.
 */
function handleFunctionCallArgumentsDone(
  event: JsonRecord,
  eventItemId: string,
  coerced: Map<
    string,
    { name: string; source: string | null; closed?: boolean }
  >
): JsonRecord[] {
  const entry = coerced.get(eventItemId);
  const source = freeformSourceFor(
    entry?.name ?? "",
    String(event.arguments ?? "")
  );
  if (entry) {
    coerced.set(eventItemId, { ...entry, source });
  }
  return [
    {
      type: "response.custom_tool_call_input.delta",
      item_id: eventItemId,
      output_index: event.output_index,
      delta: source
    },
    {
      type: "response.custom_tool_call_input.done",
      item_id: eventItemId,
      output_index: event.output_index,
      input: source
    }
  ];
}

function coerceResponseSnapshot(
  event: JsonRecord,
  coerced: Map<
    string,
    { name: string; source: string | null; closed?: boolean }
  >,
  isFreeform: (item: unknown) => item is JsonRecord
): JsonRecord {
  const responseObj = event.response as JsonRecord | undefined;
  if (!responseObj || !Array.isArray(responseObj.output)) return event;
  let changed = false;
  const output = (responseObj.output as unknown[]).map((rawItem) => {
    if (!isFreeform(rawItem)) return rawItem;
    const itemId = String(rawItem.id ?? "");
    const source =
      coerced.get(itemId)?.source ??
      freeformSourceFor(
        String(rawItem.name ?? ""),
        String(rawItem.arguments ?? "")
      );
    changed = true;
    const { arguments: _arguments, namespace: _namespace, ...rest } = rawItem;
    return { ...rest, type: "custom_tool_call", input: source };
  });
  if (changed) return { ...event, response: { ...responseObj, output } };
  return event;
}

function createFreeformCoercion(freeformNames: Set<string>): EventTransform {
  const coerced = new Map<
    string,
    { name: string; source: string | null; closed?: boolean }
  >();

  const isFreeform = (item: unknown): item is JsonRecord => {
    if (!item || typeof item !== "object") return false;
    const rec = item as JsonRecord;
    return (
      rec.type === "function_call" &&
      typeof rec.name === "string" &&
      freeformNames.has(rec.name) &&
      !isWebResearchTool(rec)
    );
  };

  return function coerce(event: JsonRecord): JsonRecord | JsonRecord[] | null {
    if (!event || typeof event !== "object") return event;

    if (event.type === "response.output_item.added" && isFreeform(event.item)) {
      const item = event.item;
      const itemId = String(item.id ?? "");
      const itemName = String(item.name ?? "");
      coerced.set(itemId, { name: itemName, source: null });
      const { arguments: _arguments, namespace: _namespace, ...rest } = item;
      return {
        ...event,
        item: { ...rest, type: "custom_tool_call", input: "" }
      };
    }

    const eventItemId = typeof event.item_id === "string" ? event.item_id : "";

    if (
      event.type === "response.function_call_arguments.delta" &&
      coerced.has(eventItemId)
    ) {
      return null; // Partial JSON cannot be translated; the full source follows.
    }

    if (
      event.type === "response.function_call_arguments.done" &&
      coerced.has(eventItemId)
    ) {
      return handleFunctionCallArgumentsDone(event, eventItemId, coerced);
    }

    const eventItem = event.item as JsonRecord | undefined;
    const doneItemId = typeof eventItem?.id === "string" ? eventItem.id : "";
    if (
      event.type === "response.output_item.done" &&
      doneItemId &&
      coerced.has(doneItemId)
    ) {
      const entry = coerced.get(doneItemId);
      const source =
        entry?.source ??
        freeformSourceFor(
          String(eventItem?.name ?? ""),
          String(eventItem?.arguments ?? "")
        );
      // Keep the entry: the terminal snapshot below still has to find its
      // source, and `response.completed` arrives after this.
      if (entry) {
        coerced.set(doneItemId, { ...entry, source, closed: true });
      }
      if (eventItem) {
        const {
          arguments: _arguments,
          namespace: _namespace,
          ...rest
        } = eventItem;
        return {
          ...event,
          item: { ...rest, type: "custom_tool_call", input: source }
        };
      }
    }

    return coerceResponseSnapshot(event, coerced, isFreeform);
  };
}

/**
 * The same coercion for a non-streaming response, where the whole item is
 * present at once and no cross-line state is needed.
 */
function coerceResponseBody(
  body: JsonRecord | null | undefined,
  freeformNames: Set<string>
): JsonRecord | null | undefined {
  if (
    !body ||
    typeof body !== "object" ||
    !(freeformNames instanceof Set) ||
    freeformNames.size === 0
  )
    return body;
  const responseObj = body.response as JsonRecord | undefined;
  const output = responseObj?.output ?? body.output;
  if (!Array.isArray(output)) return body;

  let changed = false;
  const coercedOutput = output.map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return rawItem;
    const item = rawItem as JsonRecord;
    if (
      item.type !== "function_call" ||
      typeof item.name !== "string" ||
      !freeformNames.has(item.name) ||
      isWebResearchTool(item)
    )
      return item;
    const source = freeformSourceFor(item.name, String(item.arguments ?? ""));
    changed = true;
    const { arguments: _arguments, namespace: _namespace, ...rest } = item;
    return { ...rest, type: "custom_tool_call", input: source };
  });
  if (!changed) return body;

  return responseObj?.output
    ? { ...body, response: { ...responseObj, output: coercedOutput } }
    : { ...body, output: coercedOutput };
}

// Tool telemetry for a pass-through proxy.
//
// Unlike the CLI bridges, this proxy runs nothing: MiniMax answers with a tool
// call and the Codex runtime on the other side executes it. So the two halves
// of one call arrive in two different requests -- the call in the response
// streamed back from upstream, and its output in the `input` array of the
// *next* request. That split is what decides which event each half becomes.
// The call itself is only ever `tool_requested`: this proxy has no evidence it
// ran. The output item is the Codex runtime's own record that it did, which is
// the execution proof `tool_executed` is defined to carry.
//
// No skills are reported here. This proxy never forwards the router's
// agent-role header (see forwardedRequestHeaders) and selects no
// role contract, so it exposes no skills to report; claiming otherwise would
// put a skill on a workspace that never saw one.
//
// Every request replays the whole conversation, so the same output item is
// visible on every later turn of the same session. Reports are therefore
// de-duplicated by `call_id`, which is unique per tool call -- otherwise a
// twenty-turn session would report its first tool call twenty times, once
// under each new router request id.
const REPORTED_CALL_LIMIT = 4096;
const reportedCalls = new Map<string, boolean>();

function firstReport(kind: string, callId: unknown): boolean {
  const id = typeof callId === "string" && callId.trim() ? callId.trim() : null;
  // An un-idd call cannot be de-duplicated across replays, and reporting it
  // once per remaining turn of the conversation would be worse than not
  // reporting it at all.
  if (id === null) return false;
  const key = `${kind}:${id}`;
  if (reportedCalls.has(key)) return false;
  reportedCalls.set(key, true);
  // Bounded: a long-lived proxy must not keep every call id it ever saw. Map
  // iterates in insertion order, so the oldest entry is the one that goes.
  if (reportedCalls.size > REPORTED_CALL_LIMIT) {
    const oldestKey = reportedCalls.keys().next().value;
    if (oldestKey !== undefined) {
      reportedCalls.delete(oldestKey);
    }
  }
  return true;
}

const TOOL_CALL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);
const TOOL_OUTPUT_ITEM_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output"
]);

const MINIMAX_DENIED_PATTERN =
  /permission[_\s-]?denied|auto[_\s-]?denied|denied|not[_\s-]?permitted|not[_\s-]?allowed|user[_\s-]?rejected|tool[_\s-]?not[_\s-]?found|no such tool/iu;

function parseToolOutputPayload(raw: string | null): JsonRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function isOutcomeDenied(
  item: JsonRecord | null | undefined,
  raw: string | null,
  statusStr: string,
  errorStr: string
): boolean {
  return (
    item?.denied === true ||
    statusStr === "denied" ||
    MINIMAX_DENIED_PATTERN.test(statusStr) ||
    MINIMAX_DENIED_PATTERN.test(errorStr) ||
    Boolean(raw && MINIMAX_DENIED_PATTERN.test(raw))
  );
}

/** How a tool call ended, as far as its output item says. */
function toolOutputOutcome(item: JsonRecord | null | undefined): JsonRecord {
  const raw = typeof item?.output === "string" ? item.output : null;
  const payload = parseToolOutputPayload(raw);
  const metadata =
    payload && typeof payload.metadata === "object" && payload.metadata !== null
      ? (payload.metadata as JsonRecord)
      : null;
  const exitCode =
    metadata &&
    typeof metadata.exit_code === "number" &&
    Number.isFinite(metadata.exit_code)
      ? metadata.exit_code
      : null;
  const durationSeconds =
    metadata &&
    typeof metadata.duration_seconds === "number" &&
    Number.isFinite(metadata.duration_seconds)
      ? metadata.duration_seconds
      : null;
  const statusStr = String(item?.status ?? payload?.status ?? "");
  const errorStr = String(item?.error ?? payload?.error ?? "");

  if (isOutcomeDenied(item, raw, statusStr, errorStr)) {
    return { kind: "unavailable", reason: "denied" };
  }
  const failed =
    statusStr === "failed" ||
    statusStr === "error" ||
    item?.success === false ||
    (exitCode !== null && exitCode !== 0);
  return {
    kind: "executed",
    status: failed ? "error" : "ok",
    durationMs:
      durationSeconds === null
        ? null
        : Math.max(0, Math.round(durationSeconds * 1000))
  };
}

function extractCallServer(rec: JsonRecord): string | null {
  if (typeof rec.server === "string" && rec.server.trim()) {
    return rec.server.trim();
  }
  if (typeof rec.namespace === "string" && rec.namespace.trim()) {
    return rec.namespace.trim();
  }
  return null;
}

function extractCallIdAndName(
  rec: JsonRecord
): { callId: string; name: string } | null {
  const callId = typeof rec.call_id === "string" ? rec.call_id.trim() : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!callId || !name) return null;
  return { callId, name };
}

function extractToolCallMetadata(input: unknown[]): {
  names: Map<string, string>;
  servers: Map<string, string>;
} {
  const names = new Map<string, string>();
  const servers = new Map<string, string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const rec = item as JsonRecord;
    if (typeof rec.type !== "string" || !TOOL_CALL_ITEM_TYPES.has(rec.type))
      continue;
    const info = extractCallIdAndName(rec);
    if (!info) continue;
    names.set(info.callId, info.name);
    const server = extractCallServer(rec);
    if (server) servers.set(info.callId, server);
  }
  return { names, servers };
}

function emitToolOutcome(
  agentEvents: AgentReporter,
  outcome: JsonRecord,
  tool: string,
  callId: string,
  server: string | null
): void {
  if (outcome.kind === "unavailable" && firstReport("unavailable", callId)) {
    void agentEvents.reportToolUnavailable({
      tool,
      callId,
      reason: String(outcome.reason ?? "unavailable"),
      server
    });
  } else if (outcome.kind === "executed" && firstReport("executed", callId)) {
    void agentEvents.reportToolExecuted({
      tool,
      callId,
      status: outcome.status === "error" ? "error" : "ok",
      durationMs:
        typeof outcome.durationMs === "number" ? outcome.durationMs : null,
      server
    });
  }
}

function dispatchExecutedToolItem(
  agentEvents: AgentReporter,
  item: unknown,
  names: Map<string, string>,
  servers: Map<string, string>
): void {
  if (!item || typeof item !== "object") return;
  const rec = item as JsonRecord;
  if (typeof rec.type !== "string" || !TOOL_OUTPUT_ITEM_TYPES.has(rec.type))
    return;
  const callId =
    typeof rec.call_id === "string" && rec.call_id.trim()
      ? rec.call_id.trim()
      : null;
  const tool = callId ? names.get(callId) : null;
  if (!tool || !callId) return;
  const server =
    servers.get(callId) ??
    (typeof rec.server === "string" && rec.server.trim()
      ? rec.server.trim()
      : null);
  emitToolOutcome(agentEvents, toolOutputOutcome(rec), tool, callId, server);
}

/** Report every tool call this request carries the output of. */
function reportExecutedToolCalls(
  agentEvents: AgentReporter | null,
  payload: JsonRecord | null | undefined
): void {
  if (!agentEvents || !payload || typeof payload !== "object") return;
  const input = Array.isArray(payload.input) ? payload.input : [];
  const { names, servers } = extractToolCallMetadata(input);
  for (const item of input) {
    dispatchExecutedToolItem(agentEvents, item, names, servers);
  }
}

/** Report a tool call the model just asked for, once per call id. */
function reportRequestedToolCall(
  agentEvents: AgentReporter | null,
  item: JsonRecord | null | undefined
): void {
  if (
    !agentEvents ||
    !item ||
    typeof item !== "object" ||
    typeof item.type !== "string" ||
    !TOOL_CALL_ITEM_TYPES.has(item.type)
  )
    return;
  const tool = typeof item.name === "string" ? item.name.trim() : "";
  const callId =
    typeof item.call_id === "string" && item.call_id.trim()
      ? item.call_id.trim()
      : null;
  const server =
    typeof item.server === "string" && item.server.trim()
      ? item.server.trim()
      : typeof item.namespace === "string" && item.namespace.trim()
        ? item.namespace.trim()
        : null;
  if (!tool || !firstReport("requested", callId)) return;
  void agentEvents.reportToolRequested({ tool, callId, server });
}

/**
 * Observe one upstream response event for the tool calls it carries. Progress
 * and terminal snapshots repeat the whole output array, which is why the
 * de-duplication above is what makes this safe to call on every event.
 */
function observeResponseEvent(
  agentEvents: AgentReporter | null,
  event: JsonRecord | null | undefined
): void {
  if (!agentEvents || !event || typeof event !== "object") return;
  if (event.item && typeof event.item === "object") {
    reportRequestedToolCall(agentEvents, event.item as JsonRecord);
  }
  const responseObj = event.response as JsonRecord | undefined;
  const responseOutput = Array.isArray(responseObj?.output)
    ? (responseObj.output as (JsonRecord | null | undefined)[])
    : [];
  for (const item of responseOutput) {
    reportRequestedToolCall(agentEvents, item);
  }
  const directOutput = Array.isArray(event.output)
    ? (event.output as (JsonRecord | null | undefined)[])
    : [];
  for (const item of directOutput) {
    reportRequestedToolCall(agentEvents, item);
  }
}

function rewriteSseLine(
  line: string,
  coerce: EventTransform | null = null,
  observe: ((event: JsonRecord) => void) | null = null
): string | null {
  const lineEnding = line.endsWith("\r") ? "\r" : "";
  const content = lineEnding ? line.slice(0, -1) : line;
  if (!content.startsWith("data:")) {
    return line;
  }
  const data = content.slice(5).trimStart();
  if (!data || data === "[DONE]") {
    return line;
  }
  try {
    const parsed = JSON.parse(data) as JsonRecord;
    // Observed before coercion: the tool call's own name and call id are what
    // the router is told about, and coercion only changes the item's shape.
    observe?.(parsed);
    const coerced = coerce ? coerce(parsed) : parsed;
    if (coerced === null) return null;
    const events = Array.isArray(coerced) ? coerced : [coerced];
    return events
      .map((event) => `data: ${JSON.stringify(event)}${lineEnding}`)
      .join("\n");
  } catch {
    return line;
  }
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      !forwardedRequestHeaders.includes(name.toLowerCase())
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function requestBody(
  request: IncomingMessage
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0
    ? undefined
    : Buffer.concat(chunks).toString("utf8");
}

function upstreamHeaders(response: ServerResponse, upstream: Response): void {
  for (const [name, value] of upstream.headers) {
    if (
      [
        "connection",
        "content-encoding",
        "content-length",
        "transfer-encoding"
      ].includes(name.toLowerCase())
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
}

function extractSseEventPayload(dataLine: string): string {
  return dataLine
    .replace(SSE_DATA_PREFIX_REGEX, "")
    .replace(TRAILING_CR_REGEX, "");
}

function extractSseEventType(dataLine: string): string | null {
  const payloadText = extractSseEventPayload(dataLine);
  try {
    const parsed = JSON.parse(payloadText) as JsonRecord;
    return typeof parsed?.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

async function streamSse(
  body: ReadableStream<Uint8Array>,
  response: ServerResponse,
  coerce: EventTransform | null = null,
  observe: ((event: JsonRecord) => void) | null = null,
  agentEvents: AgentReporter | null = null
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bufferedLine = "";
  // An `event:` line names the same thing its `data:` line's `type` does, and
  // Codex dispatches on the name. Coercion rewrites the type and can turn one
  // event into two or none, so the header cannot be written before its payload
  // is known -- otherwise a dropped delta leaves an orphaned header and a
  // rewritten one contradicts it. Hold it and re-derive it from the result.
  let pendingEventLine: string | null = null;

  const keepAlive = setInterval(() => {
    if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
      void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }
  }, 5000);

  const writeLine = (line: string, terminated: boolean): void => {
    const suffix = terminated ? "\n" : "";
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;

    if (trimmed.startsWith("event:")) {
      pendingEventLine = line;
      return;
    }
    if (!trimmed.startsWith("data:")) {
      // Separators and comments pass through, but a held header must go first
      // so a payload-free event (a bare `event:` + blank line) is preserved.
      if (pendingEventLine !== null) {
        response.write(`${pendingEventLine}\n`);
        pendingEventLine = null;
      }
      response.write(`${line}${suffix}`);
      return;
    }

    const held = pendingEventLine;
    pendingEventLine = null;
    const rewritten = rewriteSseLine(line, coerce, observe);
    if (rewritten === null) return; // Header and payload dropped together.

    if (held === null) {
      response.write(`${rewritten}${suffix}`);
      return;
    }
    // Re-derive one header per emitted payload from that payload's own type.
    const out = rewritten
      .split("\n")
      .map((dataLine) => {
        const type = extractSseEventType(dataLine);
        return `${type ? `event: ${type}` : held}\n${dataLine}`;
      })
      .join("\n");
    response.write(`${out}${suffix}`);
  };

  const readNextChunk = async () => {
    const result = await reader.read();
    if (result.done) {
      bufferedLine += decoder.decode();
      if (bufferedLine) {
        writeLine(bufferedLine, false);
      }
      response.end();
      return;
    }

    if (typeof agentEvents?.reportHeartbeat === "function") {
      void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }

    bufferedLine += decoder.decode(result.value, { stream: true });
    const lines = bufferedLine.split("\n");
    bufferedLine = lines.pop() ?? "";
    for (const line of lines) {
      writeLine(line, true);
    }
    await readNextChunk();
  };

  try {
    await readNextChunk();
  } finally {
    clearInterval(keepAlive);
  }
}

function proxyError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.writeHead(502, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message:
          error instanceof Error ? error.message : "Upstream request failed.",
        type: "minimax_responses_proxy_error"
      }
    })
  );
}

function extractMcpCandidateNames(record: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  if (record.type === "mcp" && typeof record.server_label === "string") {
    candidates.push(record.server_label);
  }
  const fn = record.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === "string") {
    candidates.push(fn.name);
  }
  if (typeof record.name === "string") {
    candidates.push(record.name);
  }
  if (record.tools && typeof record.tools === "object") {
    candidates.push(...Object.keys(record.tools as Record<string, unknown>));
  }
  return candidates;
}

function collectMcpServer(value: unknown, servers: Set<string>): void {
  if (!value || typeof value !== "object") return;
  const candidates = extractMcpCandidateNames(value as Record<string, unknown>);
  for (const candidate of candidates) {
    const server = mcpServerFromToolName(candidate);
    if (server) servers.add(server);
  }
}

/**
 * Extract the MCP servers actually exposed by this turn's wire payload, not
 * the role-contract's declarative list. A tool name like `mcp__lsp__lsp_diagnostics`
 * proves lsp is wired in; a tool name like `mcp__context7__get-library-docs` proves
 * context7 is wired in. The contract list is used only as a fallback when the
 * payload declares no tools at all, so the router attribution is still
 * informative for empty / tool-free turns.
 */
export function extractWireMcpServers(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const servers = new Set<string>();
  // Top-level tools[] array.
  if (Array.isArray(root.tools)) {
    for (const tool of root.tools) collectMcpServer(tool, servers);
  }
  // Codex's code-mode puts MCP tools in additional_tools input items.
  if (Array.isArray(root.input)) {
    for (const item of root.input) collectMcpServer(item, servers);
  }
  return servers.size > 0 ? [...servers] : null;
}

export function mcpServerFromToolName(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const parts = rest.split("__");
  if (parts.length >= 2 && parts[0]) return parts[0];
  return null;
}

function applySandboxInjection(
  body: string | undefined,
  sandboxInjection: string | null
): string | undefined {
  if (!sandboxInjection || typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const existing =
        typeof parsed.instructions === "string" ? parsed.instructions : "";
      parsed.instructions = `${existing}${sandboxInjection}`;
      return JSON.stringify(parsed);
    }
  } catch {
    // Body is not JSON; nothing to do.
  }
  return body;
}

function reportWireMcpExposure(
  agentEvents: AgentReporter | null,
  rawBody: string | undefined,
  defaultServers: string[]
): void {
  if (!agentEvents || !rawBody || typeof rawBody !== "string") return;
  let wireServers: string[] | null;
  try {
    wireServers = extractWireMcpServers(JSON.parse(rawBody));
  } catch {
    wireServers = null;
  }
  const reportedServers = wireServers ?? defaultServers;
  for (const server of reportedServers) {
    if (typeof agentEvents.reportMcpExposed === "function") {
      void agentEvents.reportMcpExposed({
        server,
        source: MCP_EXPOSURE_SOURCE
      });
    } else if (typeof agentEvents.post === "function") {
      void agentEvents.post([
        { type: "mcp_exposed", server, source: MCP_EXPOSURE_SOURCE }
      ]);
    }
  }
}

function processOutboundPayload(
  rawBody: string | undefined,
  agentEvents: AgentReporter | null
): { body: string | undefined; freeformNames: Set<string> } {
  let freeformNames = new Set<string>();
  let body = rawBody;
  if (rawBody) {
    try {
      const payload = JSON.parse(rawBody) as JsonRecord;
      freeformNames = collectFreeformToolNames(payload);
      reportExecutedToolCalls(agentEvents, payload);
      body = JSON.stringify(rewriteOutboundPayload(payload));
    } catch {
      // Preserve malformed JSON unchanged.
    }
  }
  return { body, freeformNames };
}

async function handleUpstreamResponse(
  upstream: Response,
  response: ServerResponse,
  coerce: EventTransform | null,
  observe: ((event: JsonRecord) => void) | null,
  agentEvents: AgentReporter | null,
  freeformNames: Set<string>
): Promise<void> {
  upstreamHeaders(response, upstream);
  response.writeHead(upstream.status);
  if (upstream.body === null) {
    response.end();
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    await streamSse(upstream.body, response, coerce, observe, agentEvents);
    return;
  }

  const responseText = await upstream.text();
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      const parsed = JSON.parse(responseText) as JsonRecord;
      observe?.(parsed);
      response.end(JSON.stringify(coerceResponseBody(parsed, freeformNames)));
      return;
    } catch {
      // Preserve malformed/non-JSON upstream responses unchanged.
    }
  }
  response.end(responseText);
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok\n");
    return;
  }

  // The router authorizes reporting per request; a caller that is not the
  // router, or a request the router sent no telemetry headers on, gets none.
  const agentEvents = resolveAgentEventReporter(request.headers);
  const agentRole = resolveAgentRole(request.headers);
  const contract = roleContract(agentRole);
  const sandboxInjection = readOnlySystemPromptInjection(
    request.headers as Record<string, unknown>
  );
  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  request.once("aborted", abortUpstream);
  response.once("close", () => {
    if (!response.writableFinished) {
      abortUpstream();
    }
  });

  try {
    const rawBody =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await requestBody(request);

    reportWireMcpExposure(agentEvents, rawBody, contract.mcp ?? []);

    const { body: transformedBody, freeformNames } = processOutboundPayload(
      rawBody,
      agentEvents
    );
    const body = applySandboxInjection(transformedBody, sandboxInjection);

    const coerce =
      freeformNames.size > 0 ? createFreeformCoercion(freeformNames) : null;
    const observe: ((event: JsonRecord) => void) | null = agentEvents
      ? (event) => observeResponseEvent(agentEvents, event)
      : null;

    const upstream = await fetch(new URL(request.url ?? "/", upstreamBaseUrl), {
      ...(body === undefined ? {} : { body }),
      headers: requestHeaders(request),
      method: request.method ?? "GET",
      signal: abortController.signal
    });

    await handleUpstreamResponse(
      upstream,
      response,
      coerce,
      observe,
      agentEvents,
      freeformNames
    );
  } catch (error) {
    proxyError(response, error);
  } finally {
    request.removeListener("aborted", abortUpstream);
  }
}

if (IS_MAIN) {
  createServer((request, response) => {
    void forward(request, response);
  }).listen(port, host, () => {
    process.stderr.write(
      `MiniMax Responses proxy listening at http://${host}:${port}.\n`
    );
  });
}

export {
  coerceResponseBody,
  forwardedRequestHeaders,
  freeformInputFromArguments,
  isWebResearchTool,
  MCP_EXPOSURE_SOURCE,
  observeResponseEvent,
  reportExecutedToolCalls,
  reportRequestedToolCall,
  rewriteOutboundPayload,
  toolOutputOutcome,
  unrecognisedFreeformFeedback
};
