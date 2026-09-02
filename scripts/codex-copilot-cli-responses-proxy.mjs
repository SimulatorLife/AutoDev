#!/usr/bin/env node

/** OpenAI Responses compatibility proxy for the subscription-authenticated Copilot CLI. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const HOST = process.env.COPILOT_PROXY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.COPILOT_PROXY_PORT ?? "4003", 10);
const TIMEOUT_MS = Number.parseInt(process.env.COPILOT_PROXY_TIMEOUT_MS ?? "900000", 10);
const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT ?? process.env.COPILOT_PROJECT_ROOT ?? null;

import { resolveCwd, WorkspaceResolutionError } from "./scripts/codex/lib/resolve-workspace.mjs";
import { bridgeInstructions, isOrchestratorRole, resolveAgentRole } from "./scripts/codex/lib/bridge-role.mjs";

function sendJson(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close" });
  response.end(encoded);
}

function responseMessageItem(text, itemId) {
  return { id: itemId, type: "message", role: "assistant", status: "completed", content: [ { type: "output_text", text, annotations: [] } ] };
}

function responsePayload(model, text, result, responseId = `resp_${randomBytes(12).toString("hex")}`, itemId = `msg_${randomBytes(10).toString("hex")}`, output = null) {
  const message = responseMessageItem(text, itemId);
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: output ?? [ message ],
    output_text: text,
    // The Copilot CLI reports premium-request spend rather than token counts,
    // so there is nothing token-shaped to report back to the router.
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => typeof part === "object" ? part?.text ?? JSON.stringify(part) : String(part)).join("\n");
}

function inputText(input, instructions) {
  if (typeof input === "string") return `${instructions}\n\nDelegated task:\n${input}`;
  if (!Array.isArray(input)) return `${instructions}\n\nDelegated task:\n${String(input ?? "")}`;
  const userItems = input.filter((item) => item && typeof item === "object" && item.role === "user");
  const items = userItems.length > 0 ? userItems : input.filter((item) => !item || typeof item !== "object" || ![ "developer", "system" ].includes(item.role));
  const task = items.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? contentText(item.content ?? item.text ?? "") : String(item ?? "")).join("\n\n");
  return `${instructions}\n\nDelegated task:\n${task}`;
}

// The Copilot CLI's `report_intent` tool exists to narrate what the agent is
// about to do, so its argument is a better activity line than the tool name.
function toolActivityText(data) {
  const toolName = String(data?.toolName ?? "tool");
  const intent = data?.arguments?.intent;
  if (toolName === "report_intent" && typeof intent === "string" && intent.trim()) return `Copilot: ${intent.trim()}`;
  return `Copilot is using ${toolName}.`;
}

/**
 * Run one Copilot turn, reporting the CLI's JSONL events as they arrive.
 * `onEvent` receives `{ type: "text_delta" | "activity", text }` for the
 * final answer and for the commentary/tool narration around it, so the parent
 * sees the turn progress instead of one silent block at the end.
 */
function runCopilot(prompt, model, cwd, onEvent) {
  return new Promise((resolve, reject) => {
    const args = [ "--no-auto-update", "--no-color", "--output-format", "json", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--no-ask-user", "--prompt", prompt ];
    if (model && model !== "copilot" && model !== "auto") args.push("--model", model);
    const child = spawn(process.env.COPILOT_BIN ?? "copilot", args, { cwd, stdio: [ "ignore", "pipe", "pipe" ] });
    const phases = new Map();
    let stderr = "";
    let answer = "";
    let terminalResult = null;
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const data = event?.data ?? {};
      switch (event?.type) {
        case "assistant.message_start":
          if (data.messageId) phases.set(data.messageId, String(data.phase ?? ""));
          break;
        case "assistant.message_delta": {
          const delta = String(data.deltaContent ?? "");
          if (!delta) break;
          if (phases.get(data.messageId) === "final_answer") {
            answer += delta;
            onEvent?.({ type: "text_delta", text: delta });
          } else {
            onEvent?.({ type: "activity", text: delta });
          }
          break;
        }
        case "assistant.message": {
          // Terminal snapshot for one message. Reconcile the answer against it
          // so a dropped delta cannot truncate the delegated result.
          if (String(data.phase ?? "") !== "final_answer") break;
          const full = String(data.content ?? "");
          if (full && !answer.endsWith(full)) {
            const suffix = full.startsWith(answer) ? full.slice(answer.length) : full;
            if (suffix) {
              answer += suffix;
              onEvent?.({ type: "text_delta", text: suffix });
            }
          }
          break;
        }
        case "tool.execution_start":
          onEvent?.({ type: "activity", text: toolActivityText(data), key: `tool:${data.toolCallId ?? ""}` });
          break;
        case "result":
          terminalResult = event;
          break;
        default:
          break;
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      const exitCode = terminalResult?.exitCode ?? code;
      if (exitCode !== 0 || code !== 0) {
        finish(reject, new Error((stderr.trim() || `Copilot exited with ${signal || exitCode}`).slice(-4000)));
        return;
      }
      if (!answer.trim()) {
        finish(reject, new Error("Copilot exited successfully without a final answer"));
        return;
      }
      finish(resolve, { text: answer, result: terminalResult ?? {} });
    });
    onEvent?.({ type: "process", child });
  });
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sseLine(eventName, body) {
  return `event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`;
}

async function handle(request, response) {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") { sendJson(response, 200, { status: "ok", provider: "copilot" }); return; }
  if (pathname !== "/v1/responses" || request.method !== "POST") { sendJson(response, 404, { error: { message: "not found", type: "invalid_request_error" } }); return; }
  let payload;
  try { payload = JSON.parse(await bodyOf(request)); } catch { sendJson(response, 400, { error: { message: "invalid JSON", type: "invalid_request_error" } }); return; }
  // The router classifies the turn; only it can tell this bridge that it is
  // serving the root orchestrator rather than a delegated leaf.
  const agentRole = resolveAgentRole(request.headers);
  const prompt = inputText(payload.input, bridgeInstructions(agentRole));
  let cwd;
  try {
    cwd = resolveCwd(payload, request.headers, PROJECT_ROOT);
  } catch (error) {
    if (!(error instanceof WorkspaceResolutionError)) throw error;
    console.error(`copilot workspace resolution failed: ${error.message}`);
    sendJson(response, 400, { error: { type: "invalid_request_error", message: error.message } });
    return;
  }
  console.error(`copilot request model=${payload.model} role=${isOrchestratorRole(agentRole) ? "orchestrator" : "leaf"} cwd=${cwd}`);

  if (payload.stream === false) {
    try {
      const result = await runCopilot(prompt, payload.model, cwd);
      sendJson(response, 200, responsePayload(payload.model, result.text, result.result));
    } catch (error) {
      sendJson(response, 503, { error: { type: "copilot_proxy_error", message: error.message ?? String(error) } });
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
    if (clientClosed || response.writableEnded || response.destroyed) return;
    const event = sseLine(eventName, { ...body, sequence_number: ++sequenceNumber });
    if (streamStarted) response.write(event);
    else pendingEvents.push(event);
  };
  // Hold the SSE headers back until the CLI has produced real output. Until
  // then a provider failure can still be reported as an HTTP status the router
  // is able to fall back on; after it, the turn is genuinely under way and the
  // parent should watch it live.
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
    emit("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: reasoningId, output_index: 0, summary_index: 0, delta: `${text}\n` });
  };
  emit("response.created", { type: "response.created", response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: payload.model, status: "in_progress", output: [] } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: reasoningId, type: "reasoning", status: "in_progress", summary: [], content: [] } });
  emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } });
  emit("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
  emit("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });

  const keepAlive = setInterval(() => { if (streamStarted && !response.writableEnded) response.write(": copilot-bridge keep-alive\n\n"); }, 2000);
  let child;
  response.on("close", () => { clientClosed = true; clearInterval(keepAlive); if (child && !child.killed) child.kill("SIGTERM"); });
  try {
    const result = await runCopilot(prompt, payload.model, cwd, (event) => {
      if (event.type === "process") { child = event.child; return; }
      startStream();
      if (event.type === "text_delta") {
        emit("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, delta: event.text, content_index: 0, output_index: 1 });
        return;
      }
      // Commentary and tool narration are appended verbatim; the CLI streams
      // commentary token by token, so those parts are keyed by their text.
      emitActivity(event.text, event.key ?? `activity:${activityParts.length}:${event.text}`);
    });
    clearInterval(keepAlive);
    startStream();
    const reasoningText = activityParts.join("");
    const completedReasoning = { id: reasoningId, type: "reasoning", status: "completed", summary: [ { type: "summary_text", text: reasoningText } ], content: [] };
    const completedMessage = responseMessageItem(result.text, itemId);
    const completed = responsePayload(payload.model, result.text, result.result, responseId, itemId, [ completedReasoning, completedMessage ]);
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
    const message = error.message ?? String(error);
    if (!streamStarted) {
      sendJson(response, 503, { error: { type: "copilot_proxy_error", message } });
      return;
    }
    emit("response.failed", { type: "response.failed", response: { id: responseId, status: "failed", error: { message, type: "upstream_error" } } });
    response.end("data: [DONE]\n\n");
  }
}

createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
  console.error(`Copilot Responses proxy listening at http://${HOST}:${PORT}`);
});
