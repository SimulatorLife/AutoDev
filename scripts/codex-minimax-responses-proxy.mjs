#!/usr/bin/env node

/**
 * Responses compatibility proxy for the MiniMax API.
 *
 * Unlike the Claude, Antigravity, and Copilot bridges, this is a transparent
 * pass-through to a remote API rather than a local CLI gateway: it forwards the
 * parent's own Responses payload upstream and only re-expands the tool
 * namespaces MiniMax flattens. There is no delegated-role prompt to select, so
 * the router's local-only routing headers are stripped instead of honoured.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { resolveAgentEventReporter } from "./codex/lib/agent-events.mjs";
import { resolveAgentRole } from "./codex/lib/bridge-role.mjs";
import { roleContract } from "./codex/lib/execution-contract.mjs";

const MCP_EXPOSURE_SOURCE = "role_contract";

// Bind the port only when run as a program. The rewriting helpers below are
// pure and worth testing directly; importing this file must not take the port
// out from under the running proxy. Mirrors the Antigravity bridge.
const IS_MAIN = process.argv[ 1 ] && import.meta.url === pathToFileURL(process.argv[ 1 ]).href;

const host = process.env.MINIMAX_PROXY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MINIMAX_PROXY_PORT ?? "18765", 10);
const upstreamBaseUrl = process.env.MINIMAX_PROXY_UPSTREAM_BASE_URL ?? "https://api.minimax.io";
// Hop-by-hop headers, plus the router's local-only routing headers. The turn
// metadata carries absolute workspace paths and git remote URLs, and the agent
// role is this router's own dispatch classification; both exist for local
// provider bridges and have no meaning to a remote API, so neither is sent
// upstream. Kept in sync with the router by tests/bridge-role.test.mjs.
const strippedRequestHeaders = [
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "x-codex-turn-metadata",
  "x-autodev-agent-role"
];
const flattenedNamespaces = [
  ["multi_agent_v1", "multi_agent_v1__"],
  ["collaboration", "collaboration__"],
  ["agents", "agents__"]
];

function rewrite(value) {
  if (Array.isArray(value)) {
    return value.map(rewrite);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = rewrite(child);
  }

  if (typeof result.name === "string" && (result.namespace === undefined || result.namespace === null)) {
    const match = flattenedNamespaces.find(([, prefix]) => result.name.startsWith(prefix));
    if (match) {
      result.namespace = match[0];
      result.name = result.name.slice(match[1].length);
    }
  }
  return result;
}

const WEB_RESEARCH_TOOL_NAMES = new Set([ "web_search", "web_fetch" ]);

export function isWebResearchTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  if (WEB_RESEARCH_TOOL_NAMES.has(tool.type) || WEB_RESEARCH_TOOL_NAMES.has(tool.name)) return true;
  if (tool.function && typeof tool.function.name === "string" && WEB_RESEARCH_TOOL_NAMES.has(tool.function.name)) return true;
  return false;
}

function getNamespacePrefix(ns) {
  const match = flattenedNamespaces.find(([namespace]) => namespace === ns);
  return match ? match[1] : `${ns}__`;
}

function flattenOutboundTool(tool, defaultNamespace = null) {
  if (isWebResearchTool(tool)) {
    return { ...tool };
  }
  const ns = tool.namespace ?? defaultNamespace;
  const prefix = ns ? getNamespacePrefix(ns) : "";

  const result = { ...tool };
  delete result.namespace;

  if (result.type === "namespace") {
    result.type = "function";
  }

  if (prefix) {
    if (typeof result.name === "string" && !result.name.startsWith(prefix)) {
      result.name = `${prefix}${result.name}`;
    }
    if (result.function && typeof result.function.name === "string" && !result.function.name.startsWith(prefix)) {
      result.function = {
        ...result.function,
        name: `${prefix}${result.function.name}`
      };
    }
  }
  return result;
}

function flattenOutboundTools(tools) {
  if (!Array.isArray(tools)) return tools;
  const flattened = [];

  for (const item of tools) {
    if (item === null || typeof item !== "object") {
      flattened.push(item);
      continue;
    }

    const ns = item.type === "namespace" ? (item.name ?? item.namespace) : item.namespace;

    if (ns && Array.isArray(item.tools)) {
      for (const innerTool of item.tools) {
        if (innerTool && typeof innerTool === "object") {
          flattened.push(flattenOutboundTool(innerTool, ns));
        }
      }
    } else {
      flattened.push(flattenOutboundTool(item));
    }
  }
  return flattened;
}

function rewriteOutboundPayload(payload) {
  if (payload === null || typeof payload !== "object") return payload;
  const rewritten = { ...payload };

  if (Array.isArray(rewritten.tools)) {
    rewritten.tools = flattenOutboundTools(rewritten.tools);
  }

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
function collectFreeformToolNames(payload, names = new Set()) {
  const visit = (tools) => {
    for (const tool of Array.isArray(tools) ? tools : []) {
      if (!tool || typeof tool !== "object") continue;
      if (tool.type === "custom" && typeof tool.name === "string" && !isWebResearchTool(tool)) names.add(tool.name);
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

// JavaScript equivalent to the JSON arguments MiniMax produced, or null when
// the intent is not clear enough to rewrite. Guessing wrong would swap one
// broken call for a different broken call, so anything unrecognised is left
// alone and fails the way it already did, visibly.
export function freeformInputFromArguments(argumentsText) {
  const raw = typeof argumentsText === "string" ? argumentsText.trim() : "";
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all: the model wrote the script directly, which is exactly
    // what the tool wants.
    return raw;
  }
  if (typeof parsed === "string") return parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  // The model understood code mode and just wrapped the source in an object.
  for (const key of [ "input", "code", "script", "source", "js", "javascript" ]) {
    if (typeof parsed[ key ] === "string" && parsed[ key ].trim()) return parsed[ key ];
  }

  // The common failure: `exec` was called as though it were `exec_command`.
  // Preserve the intent by making the script do what those arguments asked for.
  if (typeof parsed.cmd === "string" || Array.isArray(parsed.cmd) || typeof parsed.command === "string") {
    const call = { ...parsed };
    if (call.command !== undefined && call.cmd === undefined) {
      call.cmd = call.command;
      delete call.command;
    }
    return [
      `const result = await tools.exec_command(${JSON.stringify(call)});`,
      `text(typeof result === "string" ? result : JSON.stringify(result));`,
      "",
    ].join("\n");
  }

  return null;
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
function createFreeformCoercion(freeformNames) {
  const coerced = new Map(); // item_id -> { source }

  const isFreeform = (item) =>
    item?.type === "function_call" && typeof item.name === "string" && freeformNames.has(item.name) && !isWebResearchTool(item);

  return function coerce(event) {
    if (!event || typeof event !== "object") return event;

    if (event.type === "response.output_item.added" && isFreeform(event.item)) {
      coerced.set(event.item.id, { source: null });
      const { arguments: _arguments, namespace: _namespace, ...rest } = event.item;
      return { ...event, item: { ...rest, type: "custom_tool_call", input: "" } };
    }

    if (event.type === "response.function_call_arguments.delta" && coerced.has(event.item_id)) {
      return null; // Partial JSON cannot be translated; the full source follows.
    }

    if (event.type === "response.function_call_arguments.done" && coerced.has(event.item_id)) {
      const source = freeformInputFromArguments(event.arguments);
      if (source === null) {
        // Unrecognised shape: undo the coercion so the item goes out as the
        // function_call it was, rather than a custom tool call with no input.
        coerced.delete(event.item_id);
        return event;
      }
      coerced.set(event.item_id, { source });
      return [
        { type: "response.custom_tool_call_input.delta", item_id: event.item_id, output_index: event.output_index, delta: source },
        { type: "response.custom_tool_call_input.done", item_id: event.item_id, output_index: event.output_index, input: source },
      ];
    }

    if (event.type === "response.output_item.done" && coerced.has(event.item?.id)) {
      const { source } = coerced.get(event.item.id);
      // Keep the entry: the terminal snapshot below still has to find its
      // source, and `response.completed` arrives after this.
      coerced.set(event.item.id, { source, closed: true });
      if (source === null) return event;
      const { arguments: _arguments, namespace: _namespace, ...rest } = event.item;
      return { ...event, item: { ...rest, type: "custom_tool_call", input: source } };
    }

    // Terminal and progress snapshots repeat the whole output array. Leaving
    // the un-coerced `function_call` there hands Codex the same incompatible
    // payload it would have rejected, only at the end of the turn instead of
    // the middle -- so the snapshot has to be coerced too, using the source
    // already derived for each item.
    if (event.response && Array.isArray(event.response.output)) {
      let changed = false;
      const output = event.response.output.map((item) => {
        if (!isFreeform(item)) return item;
        const source = coerced.get(item.id)?.source ?? freeformInputFromArguments(item.arguments);
        if (source === null || source === undefined) return item;
        changed = true;
        const { arguments: _arguments, namespace: _namespace, ...rest } = item;
        return { ...rest, type: "custom_tool_call", input: source };
      });
      if (changed) return { ...event, response: { ...event.response, output } };
    }

    return event;
  };
}

/**
 * The same coercion for a non-streaming response, where the whole item is
 * present at once and no cross-line state is needed.
 */
export function coerceResponseBody(body, freeformNames) {
  if (!body || typeof body !== "object" || !(freeformNames instanceof Set) || freeformNames.size === 0) return body;
  const output = body.response?.output ?? body.output;
  if (!Array.isArray(output)) return body;

  let changed = false;
  const coercedOutput = output.map((item) => {
    if (item?.type !== "function_call" || typeof item.name !== "string" || !freeformNames.has(item.name) || isWebResearchTool(item)) return item;
    const source = freeformInputFromArguments(item.arguments);
    if (source === null) return item;
    changed = true;
    const { arguments: _arguments, namespace: _namespace, ...rest } = item;
    return { ...rest, type: "custom_tool_call", input: source };
  });
  if (!changed) return body;

  return body.response?.output
    ? { ...body, response: { ...body.response, output: coercedOutput } }
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
// No skills are reported here. This proxy strips the router's agent-role
// header rather than honouring it (see strippedRequestHeaders) and selects no
// role contract, so it exposes no skills to report; claiming otherwise would
// put a skill on a workspace that never saw one.
//
// Every request replays the whole conversation, so the same output item is
// visible on every later turn of the same session. Reports are therefore
// de-duplicated by `call_id`, which is unique per tool call -- otherwise a
// twenty-turn session would report its first tool call twenty times, once
// under each new router request id.
const REPORTED_CALL_LIMIT = 4096;
const reportedCalls = new Map();

function firstReport(kind, callId) {
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
  if (reportedCalls.size > REPORTED_CALL_LIMIT) reportedCalls.delete(reportedCalls.keys().next().value);
  return true;
}

const TOOL_CALL_ITEM_TYPES = new Set([ "function_call", "custom_tool_call" ]);
const TOOL_OUTPUT_ITEM_TYPES = new Set([ "function_call_output", "custom_tool_call_output" ]);

const MINIMAX_DENIED_PATTERN = /permission[_\s-]?denied|auto[_\s-]?denied|denied|not[_\s-]?permitted|not[_\s-]?allowed|user[_\s-]?rejected|tool[_\s-]?not[_\s-]?found|no such tool/i;

/** How a tool call ended, as far as its output item says. */
function toolOutputOutcome(item) {
  const raw = typeof item?.output === "string" ? item.output : null;
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); } catch { payload = null; }
  }
  const metadata = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.metadata : null;
  const exitCode = metadata && Number.isFinite(metadata.exit_code) ? metadata.exit_code : null;
  const durationSeconds = metadata && Number.isFinite(metadata.duration_seconds) ? metadata.duration_seconds : null;
  const statusStr = String(item?.status ?? payload?.status ?? "");
  const errorStr = String(item?.error ?? payload?.error ?? "");
  if (item?.denied === true || statusStr === "denied" || MINIMAX_DENIED_PATTERN.test(statusStr) || MINIMAX_DENIED_PATTERN.test(errorStr) || (raw && MINIMAX_DENIED_PATTERN.test(raw))) {
    return { kind: "unavailable", reason: "denied" };
  }
  const failed = statusStr === "failed" || statusStr === "error" || item?.success === false || (exitCode !== null && exitCode !== 0);
  return {
    kind: "executed",
    status: failed ? "error" : "ok",
    durationMs: durationSeconds === null ? null : Math.max(0, Math.round(durationSeconds * 1000)),
  };
}

/** Report every tool call this request carries the output of. */
function reportExecutedToolCalls(agentEvents, payload) {
  if (!agentEvents || !payload || typeof payload !== "object") return;
  const input = Array.isArray(payload.input) ? payload.input : [];
  // An output item names only the call id it settles, so the name comes from
  // the call item beside it in the same replayed history.
  const names = new Map();
  const servers = new Map();
  for (const item of input) {
    if (!item || typeof item !== "object" || !TOOL_CALL_ITEM_TYPES.has(item.type)) continue;
    const callId = typeof item.call_id === "string" && item.call_id.trim() ? item.call_id.trim() : null;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
    if (callId && name) {
      names.set(callId, name);
      const server = typeof item.server === "string" && item.server.trim()
        ? item.server.trim()
        : (typeof item.namespace === "string" && item.namespace.trim() ? item.namespace.trim() : null);
      if (server) servers.set(callId, server);
    }
  }
  for (const item of input) {
    if (!item || typeof item !== "object" || !TOOL_OUTPUT_ITEM_TYPES.has(item.type)) continue;
    const callId = typeof item.call_id === "string" && item.call_id.trim() ? item.call_id.trim() : null;
    const tool = callId ? names.get(callId) : null;
    // A call whose name is not in this request's history is unattributable,
    // and the router has nothing to file an unnamed tool under.
    if (!tool) continue;
    const server = (callId ? servers.get(callId) : null) ?? (typeof item.server === "string" && item.server.trim() ? item.server.trim() : null);
    const outcome = toolOutputOutcome(item);
    if (outcome.kind === "unavailable") {
      if (!firstReport("unavailable", callId)) continue;
      void agentEvents.reportToolUnavailable({ tool, callId, reason: outcome.reason, server });
      if (typeof agentEvents.reportActivity === "function") void agentEvents.reportActivity({ state: "resumed" });
    } else if (outcome.kind === "executed") {
      if (!firstReport("executed", callId)) continue;
      void agentEvents.reportToolExecuted({ tool, callId, status: outcome.status, durationMs: outcome.durationMs, server });
      if (typeof agentEvents.reportActivity === "function") void agentEvents.reportActivity({ state: "resumed" });
    }
  }
}

/** Report a tool call the model just asked for, once per call id. */
function reportRequestedToolCall(agentEvents, item) {
  if (!item || typeof item !== "object" || !TOOL_CALL_ITEM_TYPES.has(item.type)) return;
  const tool = typeof item.name === "string" ? item.name.trim() : "";
  const callId = typeof item.call_id === "string" && item.call_id.trim() ? item.call_id.trim() : null;
  const server = typeof item.server === "string" && item.server.trim()
    ? item.server.trim()
    : (typeof item.namespace === "string" && item.namespace.trim() ? item.namespace.trim() : null);
  if (!tool || !firstReport("requested", callId)) return;
  void agentEvents.reportToolRequested({ tool, callId, server });
  if (typeof agentEvents.reportActivity === "function") void agentEvents.reportActivity({ state: tool.toLowerCase() === "ask_question" ? "user_wait" : "tool_wait" });
}

/**
 * Observe one upstream response event for the tool calls it carries. Progress
 * and terminal snapshots repeat the whole output array, which is why the
 * de-duplication above is what makes this safe to call on every event.
 */
function observeResponseEvent(agentEvents, event) {
  if (!agentEvents || !event || typeof event !== "object") return;
  if (event.item) reportRequestedToolCall(agentEvents, event.item);
  for (const item of Array.isArray(event.response?.output) ? event.response.output : []) reportRequestedToolCall(agentEvents, item);
  for (const item of Array.isArray(event.output) ? event.output : []) reportRequestedToolCall(agentEvents, item);
}

function rewriteSseLine(line, coerce = null, observe = null) {
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
    const rewritten = rewrite(JSON.parse(data));
    // Observed before coercion: the tool call's own name and call id are what
    // the router is told about, and coercion only changes the item's shape.
    observe?.(rewritten);
    const coerced = coerce ? coerce(rewritten) : rewritten;
    if (coerced === null) return null;
    const events = Array.isArray(coerced) ? coerced : [ coerced ];
    return events.map((event) => `data: ${JSON.stringify(event)}${lineEnding}`).join("\n");
  } catch {
    return line;
  }
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || strippedRequestHeaders.includes(name.toLowerCase())) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
}

function upstreamHeaders(response, upstream) {
  for (const [name, value] of upstream.headers) {
    if (["connection", "content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())) {
      continue;
    }
    response.setHeader(name, value);
  }
}

async function streamSse(body, response, coerce = null, observe = null, agentEvents = null) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bufferedLine = "";
  // An `event:` line names the same thing its `data:` line's `type` does, and
  // Codex dispatches on the name. Coercion rewrites the type and can turn one
  // event into two or none, so the header cannot be written before its payload
  // is known -- otherwise a dropped delta leaves an orphaned header and a
  // rewritten one contradicts it. Hold it and re-derive it from the result.
  let pendingEventLine = null;

  const keepAlive = setInterval(() => {
    if (agentEvents && typeof agentEvents.reportHeartbeat === "function") {
      void agentEvents.reportHeartbeat({ minIntervalMs: 5000 });
    }
  }, 5000);

  const writeLine = (line, terminated) => {
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
        const body = dataLine.replace(/^data:\s*/, "").replace(/\r$/, "");
        let type = null;
        try { type = JSON.parse(body)?.type ?? null; } catch { /* keep the held header */ }
        return `${typeof type === "string" ? `event: ${type}` : held}\n${dataLine}`;
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

function proxyError(response, error) {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.writeHead(502, { "content-type": "application/json" });
  response.end(JSON.stringify({
    error: {
      message: error instanceof Error ? error.message : "Upstream request failed.",
      type: "minimax_responses_proxy_error"
    }
  }));
}

async function forward(request, response) {
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
  if (agentEvents) {
    for (const server of contract.mcp ?? []) {
      if (typeof agentEvents.reportMcpExposed === "function") {
        void agentEvents.reportMcpExposed({ server, source: MCP_EXPOSURE_SOURCE });
      } else if (typeof agentEvents.post === "function") {
        void agentEvents.post([ { type: "mcp_exposed", server, source: MCP_EXPOSURE_SOURCE } ]);
      }
    }
  }
  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  request.once("aborted", abortUpstream);
  response.once("close", () => {
    if (!response.writableFinished) {
      abortUpstream();
    }
  });

  try {
    const rawBody = request.method === "GET" || request.method === "HEAD" ? undefined : await requestBody(request);
    let body = rawBody;
    // Which tools this turn declared as freeform, so the response can be
    // coerced back into the shape Codex will accept.
    let freeformNames = new Set();
    if (rawBody) {
      try {
        const payload = JSON.parse(rawBody);
        freeformNames = collectFreeformToolNames(payload);
        // The outputs in this request settle calls a previous response made:
        // this is where a tool call is proved to have run.
        reportExecutedToolCalls(agentEvents, payload);
        body = JSON.stringify(rewriteOutboundPayload(payload));
      } catch {
        // Preserve malformed JSON unchanged.
      }
    }
    const coerce = freeformNames.size > 0 ? createFreeformCoercion(freeformNames) : null;
    const observe = agentEvents ? (event) => observeResponseEvent(agentEvents, event) : null;

    const upstream = await fetch(new URL(request.url ?? "/", upstreamBaseUrl), {
      body,
      headers: requestHeaders(request),
      method: request.method,
      signal: abortController.signal
    });
    upstreamHeaders(response, upstream);
    response.writeHead(upstream.status);
    if (upstream.body === null) {
      response.end();
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/event-stream")) {
      await streamSse(upstream.body, response, coerce, observe, agentEvents);
      if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
      return;
    }

    const responseText = await upstream.text();
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        const rewritten = rewrite(JSON.parse(responseText));
        // The non-streaming form of the same observation: one whole response
        // rather than the event stream that would have carried it.
        observe?.(rewritten);
        response.end(JSON.stringify(coerceResponseBody(rewritten, freeformNames)));
        if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
        return;
      } catch {
        // Preserve malformed/non-JSON upstream responses unchanged.
      }
    }
    if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "finished" });
    response.end(responseText);
  } catch (error) {
    if (typeof agentEvents?.reportActivity === "function") void agentEvents.reportActivity({ state: "failed" });
    proxyError(response, error);
  } finally {
    request.removeListener("aborted", abortUpstream);
  }
}

if (IS_MAIN) {
  createServer((request, response) => {
    void forward(request, response);
  }).listen(port, host, () => {
    process.stderr.write(`MiniMax Responses proxy listening at http://${host}:${port}.\n`);
  });
}

export {
  MCP_EXPOSURE_SOURCE,
  observeResponseEvent,
  reportExecutedToolCalls,
  reportRequestedToolCall,
  toolOutputOutcome,
};
