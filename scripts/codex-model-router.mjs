#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_MODEL_ROUTER_PORT ?? "4100", 10);
const CODEX_HOME = process.env.CODEX_HOME ?? "/Users/henrykirk/.codex";
const AUTH_FILE = process.env.CODEX_ROUTER_AUTH_FILE ?? `${CODEX_HOME}/auth.json`;
const CATALOG_FILE = process.env.CODEX_ROUTER_CATALOG_FILE ?? `${CODEX_HOME}/codex-model-catalog.json`;
const GPT_BASE_URL = process.env.CODEX_ROUTER_GPT_BASE_URL ?? "https://chatgpt.com/backend-api/codex";
const DASHBOARD_FILE = new URL("./codex-model-router-dashboard.html", import.meta.url);

const ROUTES = Object.freeze([
  { provider: "claude", pattern: /^(sonnet|opus|haiku|claude-[A-Za-z0-9][A-Za-z0-9.-]*)$/, baseUrl: "http://127.0.0.1:4000/v1", healthUrl: "http://127.0.0.1:4000/health/liveliness", envKey: "LITELLM_API_KEY" },
  { provider: "minimax", pattern: /^MiniMax-[A-Za-z0-9][A-Za-z0-9.-]*$/, baseUrl: "http://127.0.0.1:18765/v1", healthUrl: "http://127.0.0.1:18765/health", envKey: "MINIMAX_API_KEY" },
  { provider: "antigravity", pattern: /^gemini-[A-Za-z0-9][A-Za-z0-9.-]*$/, baseUrl: "http://127.0.0.1:4001/v1", healthUrl: "http://127.0.0.1:4001/health/liveliness", envKey: "LITELLM_API_KEY" },
  { provider: "codex", pattern: /^(gpt-[A-Za-z0-9][A-Za-z0-9.-]*|o[1-9][A-Za-z0-9.-]*|codex-[A-Za-z0-9][A-Za-z0-9.-]*)$/, baseUrl: GPT_BASE_URL, envKey: null },
  { provider: "copilot", pattern: /^copilot$/, baseUrl: "http://127.0.0.1:4003/v1", healthUrl: "http://127.0.0.1:4003/health/liveliness", envKey: "CODEX_ROUTER_COPILOT_API_KEY" },
]);
const ROUTING_CONFIG_FILE = process.env.CODEX_ROUTER_CONFIG_FILE
  ?? (existsSync(`${CODEX_HOME}/codex-model-routing.json`)
    ? `${CODEX_HOME}/codex-model-routing.json`
    : new URL('./codex/model-routing.json', import.meta.url).pathname);
const ROLE_NAMES = ['default', 'docs-researcher', 'browser-tester', 'explorer', 'worker', 'validator', 'smart'];
const ROUTING_CONFIG = JSON.parse(readFileSync(ROUTING_CONFIG_FILE, 'utf8'));

function validateRoutingConfig(config) {
  if (!config.providerGroups || typeof config.providerGroups !== 'object') throw new Error(`Routing config requires providerGroups: ${ROUTING_CONFIG_FILE}`);
  if (!config.providers || typeof config.providers !== 'object') throw new Error(`Routing config requires providers: ${ROUTING_CONFIG_FILE}`);
  if (!config.roles || typeof config.roles !== 'object') throw new Error(`Routing config requires roles: ${ROUTING_CONFIG_FILE}`);
  for (const [provider, info] of Object.entries(config.providers)) {
    if (!info || typeof info !== 'object' || !info.models || typeof info.models !== 'object') {
      throw new Error(`Routing config provider ${provider} must define a models object.`);
    }
    if (typeof info.models.default !== 'string' || !info.models.default.trim()) {
      throw new Error(`Routing config provider ${provider} must define a default model.`);
    }
  }
  for (const role of ROLE_NAMES) {
    const tier = config.roles[role]?.tier;
    if (typeof tier !== 'string' || !tier) throw new Error(`Routing config role ${role} must define a tier.`);
    const groups = config.providerGroups[tier];
    if (!Array.isArray(groups) || groups.length === 0) throw new Error(`Routing config tier ${tier} must define provider groups.`);
    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0 || !group.every((provider) => typeof provider === 'string' && provider.trim())) {
        throw new Error(`Routing config tier ${tier} contains an invalid provider group.`);
      }
      for (const provider of group) {
        if (!config.providers[provider]) throw new Error(`Routing config tier ${tier} references unknown provider ${provider}.`);
      }
    }
  }
  return config;
}

const ROUTING = validateRoutingConfig(ROUTING_CONFIG);
const PROVIDER_COOLDOWN_MS = 30_000;
const providerCooldowns = new Map();
const activeProviderRequests = new Map();
const ROUTER_STARTED_AT = new Date().toISOString();
const ROUTER_INSTANCE_ID = randomUUID();
const MAX_RECENT_EVENTS = Number.parseInt(process.env.CODEX_ROUTER_MAX_RECENT_EVENTS ?? "100", 10);
const recentRouterEvents = [];
const providerTelemetry = new Map(ROUTES.map(({ provider }) => [provider, {
  attempts: 0,
  successes: 0,
  failures: 0,
  skipped: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureClass: null,
  lastFailure: null,
}]));

function providerState(provider) {
  if (!providerTelemetry.has(provider)) {
    providerTelemetry.set(provider, {
      attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureClass: null,
      lastFailure: null,
    });
  }
  return providerTelemetry.get(provider);
}

function classifyProviderFailure(status, body = "") {
  const text = String(body ?? "");
  if (/session.?limit|session.*(?:exhaust|capacity)|concurrent session/i.test(text)) return "session_limit";
  if (/quota|credit|billing|insufficient.*(?:fund|quota)/i.test(text)) return "quota_exhausted";
  if (status === 429 || /rate.?limit|throttl|too many requests/i.test(text)) return "throttled";
  if (/high.?demand|overloaded|capacity/i.test(text)) return "capacity";
  if (status === 408 || /timeout|timed.?out/i.test(text)) return "timeout";
  if ([502, 503, 504].includes(status) || /temporarily unavailable|unavailable/i.test(text)) return "unavailable";
  if (/invalid model|model name.*(?:invalid|not found)|unknown model/i.test(text)) return "invalid_model";
  if ([401, 403].includes(status)) return "authentication";
  if (typeof status === "number" && status >= 500) return "upstream_error";
  return "request_error";
}

function recordRouterEvent({ phase, requestId, role = null, requestedModel, provider, model, outcome = null, status = null, failureClass = null, elapsedMs = null }) {
  const timestamp = new Date().toISOString();
  const event = {
    schema: "autodev-router-event-v1",
    timestamp,
    routerInstanceId: ROUTER_INSTANCE_ID,
    requestId,
    phase,
    role,
    requestedModel,
    provider,
    model,
    outcome,
    status,
    failureClass,
    elapsedMs,
  };
  recentRouterEvents.push(event);
  while (recentRouterEvents.length > Math.max(1, MAX_RECENT_EVENTS)) recentRouterEvents.shift();

  const state = providerState(provider);
  if (phase === "selected") {
    state.attempts += 1;
    state.lastAttemptAt = timestamp;
  } else if (phase === "skipped") {
    state.skipped += 1;
    state.lastFailureClass = failureClass;
  } else if (phase === "result") {
    if (outcome === "success") {
      state.successes += 1;
      state.lastSuccessAt = timestamp;
      state.lastFailureClass = null;
      state.lastFailure = null;
    } else {
      state.failures += 1;
      state.lastFailureAt = timestamp;
      state.lastFailureClass = failureClass;
      state.lastFailure = { timestamp, class: failureClass, status };
    }
  }
  console.error(JSON.stringify(event));
  return event;
}

function resetRouterTelemetry() {
  recentRouterEvents.length = 0;
  for (const state of providerTelemetry.values()) {
    state.attempts = 0;
    state.successes = 0;
    state.failures = 0;
    state.skipped = 0;
    state.lastAttemptAt = null;
    state.lastSuccessAt = null;
    state.lastFailureAt = null;
    state.lastFailureClass = null;
    state.lastFailure = null;
  }
}

function getRouterStatus(now = Date.now()) {
  const providers = Object.fromEntries(ROUTES.map((route) => {
    const state = providerState(route.provider);
    const cooldownUntil = providerCooldowns.get(route.provider) ?? 0;
    if (cooldownUntil <= now) providerCooldowns.delete(route.provider);
    const activeRequests = getActiveRequests(route.provider);
    const coolingDown = cooldownUntil > now;
    return [route.provider, {
      status: coolingDown ? (state.lastFailureClass ?? "cooldown") : "ready",
      activeRequests,
      cooldownUntil: coolingDown ? new Date(cooldownUntil).toISOString() : null,
      cooldownRemainingMs: coolingDown ? cooldownUntil - now : 0,
      configuredModels: ROUTING.providers[route.provider]?.models ?? {},
      attempts: state.attempts,
      successes: state.successes,
      failures: state.failures,
      skipped: state.skipped,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      lastFailure: state.lastFailure,
    }];
  }));
  return {
    schema: "autodev-router-status-v1",
    router: "codex-model-router",
    routerInstanceId: ROUTER_INSTANCE_ID,
    startedAt: ROUTER_STARTED_AT,
    pid: process.pid,
    activeRequests: Object.fromEntries(activeProviderRequests),
    providers,
    recentEvents: [...recentRouterEvents].reverse(),
  };
}

function getActiveRequests(provider) {
  return activeProviderRequests.get(provider) ?? 0;
}

function incrementActiveRequests(provider) {
  activeProviderRequests.set(provider, getActiveRequests(provider) + 1);
}

function decrementActiveRequests(provider) {
  const current = getActiveRequests(provider);
  if (current <= 1) {
    activeProviderRequests.delete(provider);
  } else {
    activeProviderRequests.set(provider, current - 1);
  }
}

function shuffleGroup(group, random = Math.random) {
  const items = [...group];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  items.sort((a, b) => getActiveRequests(a) - getActiveRequests(b));
  return items;
}

function providerPriority(tier, random = Math.random) {
  const rawGroups = ROUTING.providerGroups[tier] ?? [];
  const providers = [];
  const seen = new Set();
  for (const rawGroup of rawGroups) {
    const group = rawGroup.map((provider) => provider.trim().toLowerCase());
    const shuffled = shuffleGroup(group, random);
    for (const provider of shuffled) {
      if (!seen.has(provider)) {
        seen.add(provider);
        providers.push(provider);
      }
    }
  }
  return providers;
}

function isProviderCoolingDown(provider, now = Date.now()) {
  const cooldownUntil = providerCooldowns.get(provider) ?? 0;
  if (cooldownUntil > now) return true;
  providerCooldowns.delete(provider);
  return false;
}

function cooldownProvider(provider, now = Date.now()) {
  providerCooldowns.set(provider, now + PROVIDER_COOLDOWN_MS);
}

function clearProviderCooldown(provider) {
  providerCooldowns.delete(provider);
}

function roleForModel(model) {
  if (typeof model !== "string") return null;
  const match = model.trim().match(/^autodev\/([a-z0-9-]+)$/i);
  return match && ROUTING.roles[match[1].toLowerCase()] ? match[1].toLowerCase() : null;
}

function copilotRoute() {
  return ROUTES.find((route) => route.provider === "copilot") ?? null;
}

function routeForModel(model) {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (trimmed === "copilot") return copilotRoute();
  return ROUTES.find((route) => route.pattern.test(trimmed)) ?? null;
}

function roleCandidates(role, random = Math.random) {
  const tier = ROUTING.roles[role]?.tier;
  if (!tier) return [];
  return providerPriority(tier, random).map((provider) => {
    const providerModels = ROUTING.providers[provider]?.models;
    const model = providerModels?.[tier] || providerModels?.default;
    if (typeof model !== 'string' || !model) return null;
    const route = routeForModel(model);
    return route ? { ...route, model } : null;
  }).filter(Boolean);
}

function providerModelMetadata(model) {
  const route = routeForModel(model);
  return { id: model, object: "model", owned_by: route?.provider ?? "local-router" };
}

function catalogModelIds(models, roles = ROLE_NAMES.map((role) => `autodev/${role}`)) {
  return [...new Set([...models.map((model) => model.slug), ...roles])];
}

async function loadCatalog() {
  const parsed = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  const ids = catalogModelIds(models);
  return { models: ids, data: ids.map(providerModelMetadata) };
}

function replaceModelFields(value, publicModel) {
  if (Array.isArray(value)) return value.map((item) => replaceModelFields(item, publicModel));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "model" && typeof item === "string" ? publicModel : replaceModelFields(item, publicModel),
  ]));
}

function transformSseEvent(event, publicModel) {
  return event.split(/(\r?\n)/).map((line) => {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") return line;
    try {
      return `data: ${JSON.stringify(replaceModelFields(JSON.parse(line.slice(6)), publicModel))}`;
    } catch {
      return line;
    }
  }).join("");
}

async function writeResponseStream(response, upstream, publicModel) {
  const decoder = new TextDecoder();
  let buffer = "";
  const flushEvents = (flush = false) => {
    while (true) {
      const boundary = buffer.match(/\r?\n\r?\n/);
      if (!boundary) break;
      const end = boundary.index + boundary[0].length;
      response.write(transformSseEvent(buffer.slice(0, end), publicModel));
      buffer = buffer.slice(end);
    }
    if (flush && buffer) {
      response.write(transformSseEvent(buffer, publicModel));
      buffer = "";
    }
  };
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    flushEvents();
  }
  buffer += decoder.decode();
  flushEvents(true);
}

async function loadCodexAuth() {
  const auth = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId) throw new Error(`Codex auth is missing access_token or account_id in ${AUTH_FILE}`);
  return { token, accountId };
}

function sendJson(response, status, body, extraHeaders = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length, connection: "close", ...extraHeaders });
  response.end(encoded);
}

async function sendDashboard(response) {
  const body = await readFile(DASHBOARD_FILE);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store", connection: "close" });
  response.end(body);
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

async function fetchUpstream(route, payload, wantsStream) {
  const auth = route.provider === "codex" ? await loadCodexAuth() : null;
  const upstreamPayload = route.provider === "codex" ? { ...payload, stream: true, store: false } : { ...payload, stream: wantsStream };
  const upstream = await fetch(`${route.baseUrl}/responses`, {
    method: "POST",
    headers: downstreamHeaders(route, auth),
    body: JSON.stringify(upstreamPayload),
  });
  if (!upstream.ok) return { ok: false, status: upstream.status, body: await upstream.text() };
  return { ok: true, upstream };
}

async function writeSuccessfulResponse(response, route, result, wantsStream, publicModel, requestId, resolvedModel) {
  const responseHeaders = { "x-autodev-provider": route.provider, "x-autodev-model": resolvedModel, "x-autodev-request-id": requestId };
  const upstream = result.upstream;
  if (wantsStream) {
    response.writeHead(upstream.status, { ...responseHeaders, "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache", connection: "close" });
    await writeResponseStream(response, upstream, publicModel);
    response.end();
    return;
  }
  const body = await upstream.text();
  if (route.provider === "codex") {
    sendJson(response, upstream.status, replaceModelFields(responseTextFromSse(body), publicModel), responseHeaders);
    return;
  }
  try {
    const rewritten = replaceModelFields(JSON.parse(body), publicModel);
    sendJson(response, upstream.status, rewritten, responseHeaders);
  } catch {
    response.writeHead(upstream.status, { ...responseHeaders, "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
  }
}

function fallbackable(status, body) {
  if ([401, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 400 && /invalid model|model name.*(invalid|not found)|unknown model/i.test(String(body ?? ""))) return true;
  return /(quota|rate.?limit|session|high.?demand|credit|timeout|timed.?out|overloaded|temporarily unavailable|unavailable)/i.test(String(body ?? ""));
}

async function providerAvailable(route) {
  if (route.provider === "codex") {
    try { await loadCodexAuth(); return true; } catch { return false; }
  }
  if (!route.healthUrl) return true;
  try {
    const result = await fetch(route.healthUrl, { signal: AbortSignal.timeout(700) });
    return result.ok;
  } catch {
    return false;
  }
}

async function proxyConcreteResponse(response, route, payload, wantsStream, requestId) {
  const startedAt = Date.now();
  recordRouterEvent({ phase: "selected", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model });
  incrementActiveRequests(route.provider);
  try {
    const result = await fetchUpstream(route, payload, wantsStream);
    if (!result.ok) {
      const failureClass = classifyProviderFailure(result.status, result.body);
      recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, outcome: "failure", status: result.status, failureClass, elapsedMs: Date.now() - startedAt });
      response.writeHead(result.status, { "content-type": "application/json", "x-autodev-provider": route.provider, "x-autodev-model": payload.model, "x-autodev-request-id": requestId });
      response.end(result.body);
      return;
    }
    await writeSuccessfulResponse(response, route, result, wantsStream, payload.model, requestId, payload.model);
    recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, outcome: "success", status: result.upstream.status, elapsedMs: Date.now() - startedAt });
  } catch (error) {
    const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
    recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, outcome: "failure", status: 502, failureClass, elapsedMs: Date.now() - startedAt });
    if (!response.writableEnded) {
      if (response.headersSent) response.end();
      else sendJson(response, 502, errorBody(error instanceof Error ? error.message : String(error), "router_upstream_error"), { "x-autodev-provider": route.provider, "x-autodev-model": payload.model, "x-autodev-request-id": requestId });
    }
  } finally {
    decrementActiveRequests(route.provider);
  }
}

async function proxyRoleResponse(response, role, payload, wantsStream, requestId) {
  const failures = [];
  for (const route of roleCandidates(role)) {
    if (isProviderCoolingDown(route.provider)) {
      failures.push(`${route.provider}: cooldown active`);
      recordRouterEvent({ phase: "skipped", requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model, failureClass: providerState(route.provider).lastFailureClass ?? "cooldown" });
      continue;
    }
    if (!(await providerAvailable(route))) {
      failures.push(`${route.provider}: unavailable`);
      cooldownProvider(route.provider);
      recordRouterEvent({ phase: "skipped", requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model, failureClass: "unavailable" });
      continue;
    }
    const attemptStartedAt = Date.now();
    recordRouterEvent({ phase: "selected", requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model });
    incrementActiveRequests(route.provider);
    try {
      const result = await fetchUpstream(route, { ...payload, model: route.model }, wantsStream);
      if (result.ok) {
        clearProviderCooldown(route.provider);
        try {
          await writeSuccessfulResponse(response, route, result, wantsStream, payload.model, requestId, route.model);
          recordRouterEvent({ phase: "result", requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model, outcome: "success", status: result.upstream.status, elapsedMs: Date.now() - attemptStartedAt });
        } catch (streamError) {
          cooldownProvider(route.provider);
          throw streamError;
        }
        return;
      }
      const failureClass = classifyProviderFailure(result.status, result.body);
      failures.push(`${route.provider}: HTTP ${result.status}`);
      recordRouterEvent({ phase: "result", requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model, outcome: "failure", status: result.status, failureClass, elapsedMs: Date.now() - attemptStartedAt });
      if (!fallbackable(result.status, result.body)) {
        response.writeHead(result.status, { "content-type": "application/json", "x-autodev-provider": route.provider, "x-autodev-model": route.model, "x-autodev-request-id": requestId });
        response.end(result.body);
        return;
      }
      cooldownProvider(route.provider);
    } catch (error) {
      const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
      failures.push(`${route.provider}: ${error instanceof Error ? error.message : String(error)}`);
      recordRouterEvent({ phase: "result", requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model, outcome: "failure", status: 502, failureClass, elapsedMs: Date.now() - attemptStartedAt });
      cooldownProvider(route.provider);
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
    } finally {
      decrementActiveRequests(route.provider);
    }
  }
  sendJson(response, 503, errorBody(`No available provider completed role ${role}. ${failures.join("; ")}`, "router_provider_exhausted"), { "x-autodev-request-id": requestId });
}

async function handle(request, response) {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", router: "codex-model-router" });
    return;
  }
  if (pathname === "/dashboard" && request.method === "GET") {
    await sendDashboard(response);
    return;
  }
  if (pathname === "/status" && request.method === "GET") {
    if (String(request.headers.accept ?? "").includes("text/html")) await sendDashboard(response);
    else sendJson(response, 200, getRouterStatus(), { "cache-control": "no-store" });
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
  try { payload = JSON.parse(await requestBody(request)); } catch { sendJson(response, 400, errorBody("request body must be valid JSON")); return; }
  const role = roleForModel(payload.model);
  const requestId = String(request.headers["x-request-id"] ?? randomUUID());
  const wantsStream = payload.stream !== false;
  if (role) {
    await proxyRoleResponse(response, role, payload, wantsStream, requestId);
    return;
  }
  const route = routeForModel(payload.model);
  if (!route) {
    sendJson(response, 400, errorBody(`No local route is configured for model ${String(payload.model)}`));
    return;
  }
  await proxyConcreteResponse(response, route, payload, wantsStream, requestId);
}

export { activeProviderRequests, catalogModelIds, classifyProviderFailure, clearProviderCooldown, cooldownProvider, decrementActiveRequests, fallbackable, getActiveRequests, getRouterStatus, incrementActiveRequests, isProviderCoolingDown, providerModelMetadata, recordRouterEvent, replaceModelFields, resetRouterTelemetry, responseTextFromSse, roleCandidates, roleForModel, routeForModel, transformSseEvent, validateRoutingConfig, handle };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer((request, response) => { void handle(request, response); }).listen(PORT, HOST, () => {
    console.error(`Codex model router listening at http://${HOST}:${PORT}`);
  });
}
