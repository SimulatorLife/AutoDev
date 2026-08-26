#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { statSync } from "node:fs";

const HOST = process.env.COPILOT_PROXY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.COPILOT_PROXY_PORT ?? "4003", 10);
const TIMEOUT_MS = Number.parseInt(process.env.COPILOT_PROXY_TIMEOUT_MS ?? "300000", 10);
const PROJECT_ROOT = process.env.COPILOT_PROJECT_ROOT ?? "/Users/henrykirk/Desktop/RacingGame";

function isDirectory(path) {
  try { return typeof path === "string" && Boolean(path) && statSync(path).isDirectory(); } catch { return false; }
}

function resolveCwd(payload, prompt) {
  for (const key of ["cwd", "project_root", "working_directory"]) {
    if (isDirectory(payload?.[key])) return payload[key];
  }
  const meta = payload?.metadata;
  if (meta && typeof meta === "object") {
    for (const key of ["cwd", "project_root", "working_directory"]) {
      if (isDirectory(meta[key])) return meta[key];
    }
  }
  const match = typeof prompt === "string" ? prompt.match(/(?:Working directory:|cwd:|in directory:?)\s*([/\w.-]+)/i) : null;
  if (match && isDirectory(match[1].trim())) {
    return match[1].trim();
  }
  if (isDirectory(PROJECT_ROOT)) return PROJECT_ROOT;
  return process.cwd();
}

function sendJson(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close" });
  response.end(encoded);
}

function responsePayload(model, text) {
  return {
    id: `copilot_${Date.now()}`,
    object: "response",
    model,
    status: "completed",
    output_text: text,
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function inputText(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map((item) => typeof item === "string" ? item : item?.text ?? item?.content ?? "").join("\n");
  return String(input ?? "");
}

function invokeCopilot(prompt, model, cwd = PROJECT_ROOT) {
  return new Promise((resolve) => {
    const args = ["--no-auto-update", "--no-color", "--output-format", "text", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--no-ask-user", "--prompt", prompt];
    if (model && model !== "copilot" && model !== "auto") args.push("--model", model);
    const child = spawn(process.env.COPILOT_BIN ?? "copilot", args, { cwd: cwd || PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, text: stdout.trim() });
      else resolve({ ok: false, status: 503, message: (stderr || stdout || `Copilot exited with ${signal || code}`).trim() });
    });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, status: 503, message: error.message }); });
  });
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(request, response) {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") { sendJson(response, 200, { status: "ok", provider: "copilot" }); return; }
  if (pathname !== "/v1/responses" || request.method !== "POST") { sendJson(response, 404, { error: { message: "not found", type: "invalid_request_error" } }); return; }
  let payload;
  try { payload = JSON.parse(await bodyOf(request)); } catch { sendJson(response, 400, { error: { message: "invalid JSON", type: "invalid_request_error" } }); return; }
  const prompt = inputText(payload.input);
  const cwd = resolveCwd(payload, prompt);
  const result = await invokeCopilot(prompt, payload.model, cwd);
  if (!result.ok) { sendJson(response, result.status, { error: { message: result.message, type: "copilot_proxy_error" } }); return; }
  const body = responsePayload(payload.model, result.text);
  if (payload.stream !== false) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: result.text })}\n\n`);
    response.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: body })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  } else sendJson(response, 200, body);
}

createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
  console.error(`Copilot Responses proxy listening at http://${HOST}:${PORT}`);
});
