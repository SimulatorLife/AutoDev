#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_MODEL_ROUTER_PORT ?? "4100", 10);
const CODEX_HOME = process.env.CODEX_HOME ?? "/Users/henrykirk/.codex";
const AUTH_FILE = process.env.CODEX_ROUTER_AUTH_FILE ?? `${CODEX_HOME}/auth.json`;
const CATALOG_FILE = process.env.CODEX_ROUTER_CATALOG_FILE ?? `${CODEX_HOME}/codex-model-catalog.json`;
const GPT_BASE_URL = process.env.CODEX_ROUTER_GPT_BASE_URL ?? "https://chatgpt.com/backend-api/codex";

const ROUTES = Object.freeze([
  { provider: "claude", pattern: /^(sonnet|opus|haiku|claude-[A-Za-z0-9][A-Za-z0-9.-]*)$/, baseUrl: "http://127.0.0.1:4000/v1", envKey: "LITELLM_API_KEY" },
  { provider: "minimax", pattern: /^MiniMax-[A-Za-z0-9][A-Za-z0-9.-]*$/, baseUrl: "http://127.0.0.1:18765", envKey: "MINIMAX_API_KEY" },
  { provider: "antigravity", pattern: /^gemini-[A-Za-z0-9][A-Za-z0-9.-]*$/, baseUrl: "http://127.0.0.1:4001/v1", envKey: "LITELLM_API_KEY" },
  { provider: "codex", pattern: /^(gpt-[A-Za-z0-9][A-Za-z0-9.-]*|o[1-9][A-Za-z0-9.-]*|codex-[A-Za-z0-9][A-Za-z0-9.-]*)$/, baseUrl: GPT_BASE_URL, envKey: null },
]);

function routeForModel(model) {
  if (typeof model !== "string") return null;
  return ROUTES.find((route) => route.pattern.test(model.trim())) ?? null;
}

function providerModelMetadata(model) {
  const route = routeForModel(model);
  return { id: model, object: "model", owned_by: route?.provider ?? "local-router" };
}

async function loadCatalog() {
  const parsed = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  return { models, data: models.map((model) => providerModelMetadata(model.slug)) };
}

async function loadCodexAuth() {
  const auth = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId) throw new Error(`Codex auth is missing access_token or account_id in ${AUTH_FILE}`);
  return { token, accountId };
}

function sendJson(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close" });
  response.end(encoded);
}

function errorBody(message, type = "invalid_request_error") {
  return { error: { message, type } };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const encoding = String(request.headers["content-encoding"] ?? "").toLowerCase();
  if (encoding === "gzip") return gunzipSync(body).toString("utf8");
  if (encoding === "br") return brotliDecompressSync(body).toString("utf8");
  if (encoding === "deflate") return inflateSync(body).toString("utf8");
  return body.toString("utf8");
}

function downstreamHeaders(route, auth) {
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  if (route.envKey) {
    const key = process.env[route.envKey];
    if (key) headers.authorization = `Bearer ${key}`;
  } else {
    headers.authorization = `Bearer ${auth.token}`;
    headers["chatgpt-account-id"] = auth.accountId;
  }
  return headers;
}

function responseTextFromSse(body) {
  let text = "";
  let completed = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.output_text.delta") text += event.delta ?? "";
      if (event.type === "response.completed") completed = event.response;
    } catch {
      // Ignore non-JSON SSE comments and provider keep-alives.
    }
  }
  if (completed) {
    return {
      ...completed,
      output_text: completed.output_text ?? text,
      output: completed.output?.length
        ? completed.output
        : [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    };
  }
  return {
    id: `router_${Date.now()}`,
    object: "response",
    status: "completed",
    output_text: text,
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

async function proxyResponse(response, route, payload, wantsStream) {
  const auth = route.provider === "codex" ? await loadCodexAuth() : null;
  const upstreamPayload = route.provider === "codex"
    ? { ...payload, stream: true, store: false }
    : { ...payload, stream: wantsStream };
  const upstream = await fetch(`${route.baseUrl}/responses`, {
    method: "POST",
    headers: downstreamHeaders(route, auth),
    body: JSON.stringify(upstreamPayload),
  });
  if (!upstream.ok) {
    const body = await upstream.text();
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
    return;
  }
  if (wantsStream) {
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache", connection: "close" });
    for await (const chunk of upstream.body) response.write(chunk);
    response.end();
    return;
  }
  const body = await upstream.text();
  if (route.provider === "codex") {
    sendJson(response, upstream.status, responseTextFromSse(body));
    return;
  }
  response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  response.end(body);
}

async function handle(request, response) {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", router: "codex-model-router" });
    return;
  }
  if (pathname === "/v1/models" && request.method === "GET") {
    sendJson(response, 200, await loadCatalog());
    return;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, errorBody("not found"));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await requestBody(request));
  } catch {
    sendJson(response, 400, errorBody("request body must be valid JSON"));
    return;
  }
  const route = routeForModel(payload.model);
  if (!route) {
    sendJson(response, 400, errorBody(`No local route is configured for model ${String(payload.model)}`));
    return;
  }
  const wantsStream = payload.stream !== false;
  console.error(`codex-model-router model=${payload.model} provider=${route.provider} stream=${wantsStream}`);
  try {
    await proxyResponse(response, route, payload, wantsStream);
  } catch (error) {
    if (!response.writableEnded) sendJson(response, 502, errorBody(error instanceof Error ? error.message : String(error), "router_upstream_error"));
  }
}

export { providerModelMetadata, responseTextFromSse, routeForModel };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
    console.error(`Codex model router listening at http://${HOST}:${PORT}`);
  });
}
