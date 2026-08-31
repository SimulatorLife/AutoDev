#!/usr/bin/env node

/** OpenAI Responses compatibility proxy for the subscription-authenticated agy CLI. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const HOST = process.env.AGY_PROXY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.AGY_PROXY_PORT ?? "4002", 10);
const CLI = process.env.AGY_CLI_PATH ?? "/Users/henrykirk/.local/bin/agy";
const DEFAULT_MODEL = "gemini-3.6-flash-medium";
const DEFAULT_EFFORT = "medium";
const AGY_MODE = process.env.AGY_MODE ?? "accept-edits";
const AGY_SKIP_PERMISSIONS = process.env.AGY_SKIP_PERMISSIONS ?? "true";
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT ?? "15m";
const AUTH_TOKEN = process.env.LITELLM_API_KEY ?? "";
const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT ?? process.env.AGY_PROJECT_ROOT ?? null;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EFFORTS = new Set([ "low", "medium", "high" ]);
const BRIDGE_INSTRUCTIONS = "You are the leaf implementation agent for a parent Codex task. Use Antigravity's native tools and follow the repository's AGENTS.md. Do not spawn child agents, commit, or push unless the task explicitly requires it.";

import { resolveCwd, WorkspaceResolutionError } from "./scripts/codex/lib/resolve-workspace.mjs";

function modelMetadata() {
  return {
    slug: DEFAULT_MODEL,
    apply_patch_tool_type: "freeform",
    base_instructions: "You are a bounded external-provider Codex agent.",
    display_name: "Antigravity CLI subscription",
    description: "Antigravity CLI subscription through the local Responses adapter.",
    default_reasoning_level: DEFAULT_EFFORT,
    default_reasoning_summary: "none",
    default_verbosity: "low",
    supported_reasoning_levels: [ "low", "medium", "high" ].map((effort) => ({ effort, description: `Antigravity ${effort} reasoning` })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: 1000000,
    max_context_window: 1000000,
    model_messages: { instructions_template: "You are a bounded external-provider Codex agent." },
    input_modalities: [ "text" ],
    experimental_supported_tools: [],
    support_verbosity: false,
    supports_parallel_tool_calls: false,
    supports_search_tool: false,
    tool_mode: "code_mode_only",
    truncation_policy: { mode: "tokens", limit: 10000 },
    use_responses_lite: true,
    multi_agent_version: "v1",
    node_repl_auto_review_required: false,
    node_repl_disabled: true,
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_skills_usage_instructions: false,
    comp_hash: "local-antigravity-bridge",
    effective_context_window_percent: 95
  };
}

function resolveModel(value) {
  if (typeof value !== "string") return DEFAULT_MODEL;
  const model = value.trim();
  if (!model || model === "antigravity-subscription" || !MODEL_PATTERN.test(model)) return DEFAULT_MODEL;
  return model;
}

function resolveEffort(request) {
  const reasoning = request?.reasoning;
  const value = reasoning && typeof reasoning === "object" && "effort" in reasoning
    ? reasoning.effort
    : request?.model_reasoning_effort ?? request?.reasoning_effort;
  if (typeof value !== "string") return DEFAULT_EFFORT;
  const effort = value.trim().toLowerCase();
  if (EFFORTS.has(effort)) return effort;
  if (effort === "xhigh" || effort === "max") return "high";
  return DEFAULT_EFFORT;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map((part) => typeof part === "object" ? (part.text ?? JSON.stringify(part)) : String(part)).join("\n");
}

function promptFromInput(value) {
  if (typeof value === "string") return `${BRIDGE_INSTRUCTIONS}\n\n${value}`;
  if (!Array.isArray(value)) return `${BRIDGE_INSTRUCTIONS}\n\n${JSON.stringify(value)}`;
  const userItems = value.filter((item) => item && typeof item === "object" && (item.role === "user" || item.type === "message" && item.role === "user"));
  const items = userItems.length > 0 ? userItems : value.filter((item) => item && typeof item === "object" && ![ "developer", "system" ].includes(item.role));
  const task = items.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return JSON.stringify(item);
    return contentText(item.content ?? item.text ?? "");
  }).join("\n\n");
  return `${BRIDGE_INSTRUCTIONS}\n\n${task}`;
}

function responseMessageItem(text, itemId) {
  return {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [ { type: "output_text", text, annotations: [] } ]
  };
}

function responsePayload(model, text, result, responseId = `resp_${randomBytes(12).toString("hex")}`, itemId = `msg_${randomBytes(10).toString("hex")}`, output = null) {
  const usage = result?.usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const message = responseMessageItem(text, itemId);
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: output ?? [ message ],
    output_text: text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  };
}

function sendJson(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close" });
  response.end(encoded);
}

function sseLine(eventName, body, sequenceNumber) {
  const payload = sequenceNumber === undefined ? body : { ...body, sequence_number: sequenceNumber };
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sse(response, eventName, body, sequenceNumber) {
  response.write(sseLine(eventName, body, sequenceNumber));
}

function activityText(event) {
  if (event?.event !== "step_update" || !event.step_update) return "";
  const update = event.step_update;
  const state = String(update.state ?? "").toUpperCase();
  const stepType = String(update.step_type ?? "").toLowerCase();
  const toolName = String(update.tool_name ?? update.tool_info?.name ?? "tool");

  if (stepType === "tool") {
    if (state === "ACTIVE") return `Antigravity is using ${toolName}.`;
    if (state === "DONE") return `Antigravity finished ${toolName}.`;
    return `Antigravity tool ${toolName}: ${state.toLowerCase()}.`;
  }
  if (stepType === "agent_response") {
    if (state === "ACTIVE") return "Antigravity is processing the next step.";
    if (state === "DONE") return "Antigravity completed a processing step.";
  }
  if (stepType === "checkpoint" && state === "DONE") return "Antigravity reached a checkpoint.";
  return "";
}

function failedStream(response, responseId, itemId, error) {
  const message = error.message ?? String(error);
  // LiteLLM's Responses adapter expects a completed response with a usage
  // object and does not safely translate response.failed events from a custom
  // upstream. Return a completed, explicit provider-error message so Codex
  // stops without converting quota exhaustion into a reconnect loop.
  const errorText = `Antigravity provider request failed: ${message}`;
  sse(response, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: itemId,
    output_index: 1,
    content_index: 0,
    delta: errorText
  });
  sse(response, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: 1,
    content_index: 0,
    text: errorText
  });
  sse(response, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      output: [responseMessageItem(errorText, itemId)],
      output_text: errorText,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      metadata: { provider_error: true, provider_error_type: "upstream_error" }
    }
  });
  response.end("data: [DONE]\n\n");
}

function runAgy(prompt, model, effort, cwd, onEvent) {
  return new Promise((resolve, reject) => {
    const permissionArgs = AGY_SKIP_PERMISSIONS === "true" ? [ "--dangerously-skip-permissions" ] : [];
    const args = [ "-p", prompt, "--model", model, "--effort", effort, "--mode", AGY_MODE, ...permissionArgs, "--output-format", "stream-json", "--print-timeout", PRINT_TIMEOUT ];
    const child = spawn(CLI, args, { cwd, env: process.env, stdio: [ "ignore", "pipe", "pipe" ] });
    let stderr = "";
    let terminalResult = null;
    let emitted = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      onEvent?.(event);
      if (event.event === "step_update") {
        const delta = String(event.step_update?.text_delta ?? "");
        if (delta) {
          emitted += delta;
          onEvent?.({ type: "text_delta", text: delta });
        }
      }
      if (event.event === "result") terminalResult = event.result ?? {};
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      const result = terminalResult ?? {};
      if (!terminalResult) {
        finish(reject, new Error("agy exited without a terminal result event"));
        return;
      }
      if (result.status && result.status !== "SUCCESS") {
        finish(reject, new Error(result.error ?? `agy ended with status ${result.status}`));
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(stderr.trim().slice(-4000) || `agy exited with code ${code}`));
        return;
      }
      const finalText = String(result.response ?? emitted);
      if (finalText && finalText !== emitted) {
        const suffix = finalText.startsWith(emitted) ? finalText.slice(emitted.length) : finalText;
        if (suffix) onEvent?.({ type: "text_delta", text: suffix });
      }
      if (!finalText.trim()) {
        finish(reject, new Error("agy completed without a response message"));
        return;
      }
      finish(resolve, { text: finalText || emitted, result });
    });
    onEvent?.({ type: "process", child });
  });
}

async function handle(request, response) {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (pathname === "/v1/models") {
    sendJson(response, 200, { object: "list", data: [ { id: DEFAULT_MODEL, object: "model", owned_by: "google-antigravity" } ], models: [ modelMetadata() ] });
    return;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, { error: { type: "invalid_request_error", message: "not found" } });
    return;
  }
  if (AUTH_TOKEN && request.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    sendJson(response, 401, { error: { type: "authentication_error", message: "invalid local gateway key" } });
    return;
  }

  let body = "";
  for await (const chunk of request) body += chunk;
  let payload;
  try { payload = JSON.parse(body); } catch { sendJson(response, 400, { error: { type: "invalid_request_error", message: "invalid JSON" } }); return; }
  const model = resolveModel(payload.model);
  const effort = resolveEffort(payload);
  const prompt = promptFromInput(payload.input ?? "");
  let cwd;
  try {
    cwd = resolveCwd(payload, request.headers, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    console.error(`agy workspace resolution failed: ${error.message}`);
    sendJson(response, 400, { error: { type: "invalid_request_error", message: error.message } });
    return;
  }
  console.error(`agy request model=${model} effort=${effort} cwd=${cwd}`);

  if (!payload.stream) {
    try {
      const result = await runAgy(prompt, model, effort, cwd);
      sendJson(response, 200, responsePayload(payload.model ?? model, result.text, result.result));
    } catch (error) {
      sendJson(response, 502, { error: { type: "upstream_error", message: error.message ?? String(error) } });
    }
    return;
  }

  const responseId = `resp_${randomBytes(12).toString("hex")}`;
  const reasoningId = `rs_${randomBytes(12).toString("hex")}`;
  const itemId = `msg_${randomBytes(10).toString("hex")}`;
  const activityParts = [];
  const seenActivities = new Set();
  let sequenceNumber = 0;
  let streamStarted = false;
  const pendingEvents = [];
  let clientClosed = false;
  const emit = (eventName, body) => {
    const event = sseLine(eventName, { ...body, sequence_number: ++sequenceNumber });
    if (clientClosed || response.writableEnded || response.destroyed) return;
    if (streamStarted) response.write(event);
    else pendingEvents.push(event);
  };
  const startStream = () => {
    if (streamStarted || clientClosed || response.writableEnded || response.destroyed) return;
    streamStarted = true;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    response.flushHeaders();
    response.shouldKeepAlive = false;
    for (const event of pendingEvents.splice(0)) response.write(event);
  };
  const emitActivity = (text, key = text) => {
    if (!text || seenActivities.has(key) || response.writableEnded) return;
    seenActivities.add(key);
    activityParts.push(text);
    emit("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: `${text}\n`
    });
  };
  emit("response.created", { type: "response.created", response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: payload.model ?? model, status: "in_progress", output: [] } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: reasoningId, type: "reasoning", status: "in_progress", summary: [], content: [] } });
  emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
  emit("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  emitActivity("Antigravity started processing.", "initial");

  const keepAlive = setInterval(() => { if (streamStarted && !response.writableEnded) response.write(": agy-bridge keep-alive\n\n"); }, 2000);
  let child;
  response.on("close", () => { clientClosed = true; clearInterval(keepAlive); if (child && !child.killed) child.kill("SIGTERM"); });
  try {
    const result = await runAgy(prompt, model, effort, cwd, (event) => {
      if (event.type === "process") { child = event.child; return; }
      if (event.type === "text_delta") {
        startStream();
        emit("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, delta: event.text, content_index: 0, output_index: 1 });
      }
      if (event.event === "step_update") {
        const update = event.step_update ?? {};
        const activity = activityText(event);
        const key = `${update.step_index ?? "?"}:${update.state ?? "?"}:${update.step_type ?? "?"}:${update.tool_name ?? ""}`;
        if (activity) emitActivity(activity, key);
        if (update.step_type === "tool") console.error(`agy tool=${update.tool_name ?? "unknown"}`);
      }
    });
    clearInterval(keepAlive);
    startStream();
    const reasoningText = activityParts.join("\n");
    const completedReasoning = { id: reasoningId, type: "reasoning", status: "completed", summary: [ { type: "summary_text", text: reasoningText } ], content: [] };
    const completedMessage = responseMessageItem(result.text, itemId);
    const completed = responsePayload(payload.model ?? model, result.text, result.result, responseId, itemId, [ completedReasoning, completedMessage ]);
    emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: 0, summary_index: 0, text: reasoningText });
    emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: reasoningText } });
    emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: completedReasoning });
    emit("response.output_text.done", { type: "response.output_text.done", item_id: itemId, text: result.text, content_index: 0, output_index: 1 });
    emit("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: result.text, annotations: [] } });
    emit("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: completedMessage });
    emit("response.completed", { type: "response.completed", response: completed });
    response.end("data: [DONE]\n\n");
  } catch (error) {
    clearInterval(keepAlive);
    if (clientClosed || response.writableEnded || response.destroyed) return;
    if (!streamStarted) {
      sendJson(response, 503, { error: { type: "upstream_error", message: error.message ?? String(error) } });
      return;
    }
    failedStream(response, responseId, itemId, error);
  }
}

createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
  console.error(`Antigravity Responses proxy listening at http://${HOST}:${PORT}`);
});
