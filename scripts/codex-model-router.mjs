#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_MODEL_ROUTER_PORT ?? "4100", 10);
const CODEX_HOME = process.env.CODEX_HOME ?? "/Users/henrykirk/.codex";
const AUTH_FILE = process.env.CODEX_ROUTER_AUTH_FILE ?? `${CODEX_HOME}/auth.json`;
const CATALOG_FILE = process.env.CODEX_ROUTER_CATALOG_FILE ?? `${CODEX_HOME}/codex-model-catalog.json`;
const GPT_BASE_URL = process.env.CODEX_ROUTER_GPT_BASE_URL ?? "https://chatgpt.com/backend-api/codex";
const DASHBOARD_FILE = new URL("./codex-model-router-dashboard.html", import.meta.url);
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const STATE_FILE = process.env.CODEX_ROUTER_STATE_FILE ?? `${CODEX_HOME}/codex-router-state.json`;

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

function validateTierGroups(config, tier) {
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

function validateRoutingConfig(config) {
  if (!config.providerGroups || typeof config.providerGroups !== 'object') throw new Error(`Routing config requires providerGroups: ${ROUTING_CONFIG_FILE}`);
  if (!config.providers || typeof config.providers !== 'object') throw new Error(`Routing config requires providers: ${ROUTING_CONFIG_FILE}`);
  if (!config.roles || typeof config.roles !== 'object') throw new Error(`Routing config requires roles: ${ROUTING_CONFIG_FILE}`);
  if (!config.orchestrator || typeof config.orchestrator !== 'object') throw new Error(`Routing config requires an orchestrator block: ${ROUTING_CONFIG_FILE}`);
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
    validateTierGroups(config, tier);
  }
  const orchestrator = config.orchestrator;
  if (typeof orchestrator.alias !== 'string' || !/^autodev\/[a-z0-9-]+$/.test(orchestrator.alias.trim())) {
    throw new Error(`Routing config orchestrator.alias must be an autodev/<name> alias.`);
  }
  if (typeof orchestrator.tier !== 'string' || !orchestrator.tier) throw new Error(`Routing config orchestrator must define a tier.`);
  validateTierGroups(config, orchestrator.tier);
  if (orchestrator.reasoningEffort !== undefined) {
    if (!orchestrator.reasoningEffort || typeof orchestrator.reasoningEffort !== 'object') {
      throw new Error(`Routing config orchestrator.reasoningEffort must be an object mapping providers to effort strings.`);
    }
    for (const [provider, effort] of Object.entries(orchestrator.reasoningEffort)) {
      if (!config.providers[provider]) throw new Error(`Routing config orchestrator.reasoningEffort references unknown provider ${provider}.`);
      if (typeof effort !== 'string' || !effort.trim()) throw new Error(`Routing config orchestrator.reasoningEffort.${provider} must be a non-empty string.`);
    }
  }
  return config;
}

const ROUTING = validateRoutingConfig(ROUTING_CONFIG);
const ORCHESTRATOR_ALIAS = ROUTING.orchestrator.alias.trim();
const ORCHESTRATOR_TIER = ROUTING.orchestrator.tier;
const ORCHESTRATOR_REASONING_EFFORT = Object.freeze({ ...(ROUTING.orchestrator.reasoningEffort ?? {}) });
function positiveDuration(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PROVIDER_COOLDOWN_MS = positiveDuration(process.env.CODEX_ROUTER_PROVIDER_COOLDOWN_MS, 30_000);
const PROVIDER_COOLDOWN_MAX_MS = Math.max(PROVIDER_COOLDOWN_MS, positiveDuration(process.env.CODEX_ROUTER_PROVIDER_COOLDOWN_MAX_MS, 600_000));
// Keep the router's total upstream lifetime longer than the provider bridge
// defaults. The caller still owns cancellation, and the timeout aborts an
// in-flight response body as well as a connection that never produces headers.
const UPSTREAM_TIMEOUT_MS = positiveDuration(process.env.CODEX_ROUTER_UPSTREAM_TIMEOUT_MS, 900_000);
// Bounded retry budget for direct concrete provider requests. A completed
// upstream HTTP 502/503/504 response is real signal from the provider, so it
// gets a single bounded retry to avoid hammering something that is already
// struggling. A pre-response transport failure has no usable response signal,
// so it gets a slightly larger but still bounded budget. The request may have
// reached the provider before the connection failed, so this is deliberately
// not an unbounded or generally idempotent retry policy.
// chatgpt.com's Codex backend has been observed recycling the pooled
// keep-alive connection out from under an in-flight reuse attempt (ECONNRESET/
// EPIPE/UND_ERR_SOCKET writing the *next* request), including immediately
// after a prior request on that same connection completed; a single retry
// can still land on another connection from the same batch that is equally
// stale, so transport failures get one extra attempt. Never retries after the
// response stream has started or when the client signal is aborted.
const CONCRETE_RETRY_BASE_MS = positiveDuration(process.env.CODEX_ROUTER_CONCRETE_RETRY_MS, 200);
const CONCRETE_RETRY_MAX_MS = Math.max(CONCRETE_RETRY_BASE_MS, positiveDuration(process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS, 2_000));
const CONCRETE_STATUS_MAX_ATTEMPTS = 2;
const CONCRETE_TRANSPORT_MAX_ATTEMPTS = Math.max(
  CONCRETE_STATUS_MAX_ATTEMPTS,
  positiveDuration(process.env.CODEX_ROUTER_CONCRETE_TRANSPORT_RETRY_LIMIT, 3),
);
// Time the router will wait for in-flight response requests to drain after a
// shutdown signal before forcibly aborting them and exiting.
const SHUTDOWN_DRAIN_TIMEOUT_MS = positiveDuration(process.env.CODEX_ROUTER_SHUTDOWN_DRAIN_MS, 30_000);
const providerCooldowns = new Map();
const providerFailureStreaks = new Map();
const activeProviderRequests = new Map();
const ROUTER_STARTED_AT = new Date().toISOString();
const ROUTER_INSTANCE_ID = randomUUID();
// Router lifecycle: "ready" accepts new response requests; "draining" rejects
// them with a structured 503 while existing requests get a bounded time to
// finish. Liveness probes remain unconditional 200 regardless of state.
let lifecycleState = "ready";
let lifecycleStateChangedAt = ROUTER_STARTED_AT;
// Active /v1/responses request aborters, so SIGTERM can cancel every
// in-flight upstream call when the drain timeout elapses. A Set avoids losing
// one request when callers reuse the same x-request-id concurrently.
const activeRequestAborters = new Set();
let shutdownPromise = null;
const MAX_RECENT_EVENTS = Number.parseInt(process.env.CODEX_ROUTER_MAX_RECENT_EVENTS ?? "100", 10);
const recentRouterEvents = [];
let persistedStateUpdatedAt = null;
let persistTimeout = null;
let persistChain = Promise.resolve();
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


function emptyUsageBucket() {
  return { attempts: 0, successes: 0, failures: 0, skipped: 0, active: 0, durationMs: 0, maxDurationMs: 0, toolCalls: 0, lastUsedAt: null, lastFailure: null };
}

const usageTelemetry = {
  totals: emptyUsageBucket(),
  byRole: Object.fromEntries(ROLE_NAMES.map((role) => [role, emptyUsageBucket()])),
  byModel: {},
  byOrigin: {},
  byWorkspace: {},
};
const inFlightUsage = new Map();

function usageBucket(collection, key) {
  if (!collection[key]) collection[key] = emptyUsageBucket();
  return collection[key];
}

function usageOrigin(role, provider) {
  if (role) return "subagent";
  if (provider === "codex") return "orchestrator";
  return "direct";
}

function usageKey(requestId, provider, model) {
  return `${requestId}\0${provider}\0${model}`;
}

function workspaceBucket(collection, key, cwd = null) {
  if (!collection[key]) collection[key] = { ...emptyUsageBucket(), cwd, byRole: {}, byModel: {}, byProvider: {} };
  if (cwd && !collection[key].cwd) collection[key].cwd = cwd;
  return collection[key];
}

function workspaceDimensionBuckets(bucket, { role, provider, model }) {
  return [
    role ? usageBucket(bucket.byRole, role) : usageBucket(bucket.byRole, "unattributed"),
    usageBucket(bucket.byModel, `${provider}/${model}`),
    usageBucket(bucket.byProvider, provider),
  ];
}

function recordUsageEvent({ phase, requestId, role, provider, model, workspace = null, outcome, failureClass = null, status = null, elapsedMs, toolCalls = 0, timestamp, origin: originOverride = null }) {
  const workspaceContext = typeof workspace === "string" ? { key: workspace, cwd: null } : workspace;
  const origin = originOverride ?? usageOrigin(role, provider);
  const roleKey = role ?? "unattributed";
  const modelKey = `${provider}/${model}`;
  const buckets = [usageTelemetry.totals, usageBucket(usageTelemetry.byRole, roleKey), usageBucket(usageTelemetry.byModel, modelKey), usageBucket(usageTelemetry.byOrigin, origin)];
  if (workspaceContext?.key) {
    const workspaceUsage = workspaceBucket(usageTelemetry.byWorkspace, workspaceContext.key, workspaceContext.cwd);
    buckets.push(workspaceUsage, ...workspaceDimensionBuckets(workspaceUsage, { role, provider, model }));
  }
  const key = usageKey(requestId, provider, model);
  if (phase === "selected") {
    inFlightUsage.set(key, { startedAt: Date.now(), buckets });
    for (const bucket of buckets) {
      bucket.attempts += 1;
      bucket.active += 1;
      bucket.lastUsedAt = timestamp;
    }
    return;
  }
  if (phase === "skipped") {
    for (const bucket of buckets) bucket.skipped += 1;
    return;
  }
  if (phase !== "result") return;
  const active = inFlightUsage.get(key);
  const duration = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : active ? Math.max(0, Date.now() - active.startedAt) : 0;
  const resultBuckets = active?.buckets ?? buckets;
  for (const bucket of resultBuckets) {
    bucket.active = Math.max(0, bucket.active - 1);
    if (outcome === "success") bucket.successes += 1;
    else bucket.failures += 1;
    bucket.durationMs += duration;
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, duration);
    bucket.toolCalls += Number.isInteger(toolCalls) && toolCalls > 0 ? toolCalls : 0;
    if (outcome !== "success") bucket.lastFailure = { timestamp, class: failureClass, status };
  }
  inFlightUsage.delete(key);
}

function resetUsageTelemetry() {
  usageTelemetry.totals = emptyUsageBucket();
  usageTelemetry.byRole = Object.fromEntries(ROLE_NAMES.map((role) => [role, emptyUsageBucket()]));
  usageTelemetry.byModel = {};
  usageTelemetry.byOrigin = {};
  usageTelemetry.byWorkspace = {};
  inFlightUsage.clear();
}

function usageSnapshot(collection) {
  return Object.fromEntries(Object.entries(collection).map(([key, bucket]) => [key, {
    ...bucket,
    averageDurationMs: bucket.successes + bucket.failures > 0 ? Math.round(bucket.durationMs / (bucket.successes + bucket.failures)) : 0,
  }]));
}

function usageStatus() {
  return {
    totals: { ...usageTelemetry.totals, averageDurationMs: usageTelemetry.totals.successes + usageTelemetry.totals.failures > 0 ? Math.round(usageTelemetry.totals.durationMs / (usageTelemetry.totals.successes + usageTelemetry.totals.failures)) : 0 },
    byRole: usageSnapshot(usageTelemetry.byRole),
    byModel: usageSnapshot(usageTelemetry.byModel),
    byOrigin: usageSnapshot(usageTelemetry.byOrigin),
    byWorkspace: Object.fromEntries(Object.entries(usageTelemetry.byWorkspace).map(([key, bucket]) => [key, {
      ...bucket,
      averageDurationMs: bucket.successes + bucket.failures > 0 ? Math.round(bucket.durationMs / (bucket.successes + bucket.failures)) : 0,
      byRole: usageSnapshot(bucket.byRole),
      byModel: usageSnapshot(bucket.byModel),
      byProvider: usageSnapshot(bucket.byProvider),
    }])),
  };
}

function restoreUsageBucket(target, saved) {
  if (!saved || typeof saved !== "object") return;
  for (const field of ["attempts", "successes", "failures", "skipped", "durationMs", "maxDurationMs", "toolCalls"]) {
    if (Number.isInteger(saved[field]) && saved[field] >= 0) target[field] = saved[field];
  }
  if (saved.lastUsedAt === null || typeof saved.lastUsedAt === "string") target.lastUsedAt = saved.lastUsedAt;
  if (saved.lastFailure === null || (saved.lastFailure && typeof saved.lastFailure === "object")) target.lastFailure = saved.lastFailure;
}

const OTEL_HEALTH_TTL_MS = Number.parseInt(process.env.CODEX_ROUTER_OTEL_HEALTH_TTL_MS ?? "120000", 10);
const otelTelemetry = {
  receiver: { logs: 0, traces: 0, metrics: 0, invalid: 0, lastReceivedAt: null },
  sessions: new Map(),
  mcpServers: new Map(),
  turns: { prompts: 0, completed: 0, promptLength: 0, ttftMs: 0, ttftCount: 0 },
  tokens: { input: 0, output: 0, cached: 0, reasoning: 0, tool: 0 },
  metricInventory: new Map(),
  tools: new Map(),
  hooks: new Map(),
  threads: {
    started: { total: 0, bySource: {} },
    spawns: { total: 0, byStatus: {}, byRole: {}, byModel: {} },
  },
  sqlite: {
    init: new Map(),
    initDurationMs: new Map(),
    fallbacks: new Map(),
  },
  skills: {
    injected: { total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {}, bySkill: new Map() },
    usage: { total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {}, bySkill: new Map() },
    selection: {
      catalogEntries: { count: 0, sum: 0 },
      selectedEntries: { count: 0, sum: 0 },
      queryTerms: { count: 0, sum: 0 },
      reductionBps: { count: 0, sum: 0 },
      durationMs: { count: 0, sum: 0 },
      durationSeconds: { count: 0, sum: 0 },
    },
    threads: {
      enabled: { count: 0, sum: 0 },
      kept: { count: 0, sum: 0 },
      truncated: { count: 0, sum: 0 },
      descriptionTruncatedChars: { count: 0, sum: 0 },
    },
  },
};
// Cumulative OTLP metric points resend the running total on every export, so
// each series (metric + attributes + startTimeUnixNano) is tracked here and
// only the delta since the last observed point/timestamp is applied.
const otelMetricSeries = new Map();

function otelAttributeValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "intValue")) return Number(value.intValue);
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "boolValue")) return value.boolValue;
  if (value.arrayValue?.values) return value.arrayValue.values.map(otelAttributeValue);
  return undefined;
}

function otelAttributes(attributes = []) {
  return Object.fromEntries((Array.isArray(attributes) ? attributes : []).map((item) => [item.key, otelAttributeValue(item.value)]).filter(([key, value]) => typeof key === "string" && value !== undefined));
}

function otelTimestamp(value) {
  if (value === undefined || value === null) return null;
  try {
    const nanos = BigInt(String(value));
    return new Date(Number(nanos / 1_000_000n)).toISOString();
  } catch {
    return null;
  }
}

function otelDurationMs(span) {
  try {
    const start = BigInt(String(span.startTimeUnixNano));
    const end = BigInt(String(span.endTimeUnixNano));
    return Math.max(0, Number(end - start) / 1_000_000);
  } catch {
    return 0;
  }
}

function numberAttribute(attributes, ...keys) {
  for (const key of keys) {
    const value = Number(attributes[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function mcpServer(name) {
  if (!otelTelemetry.mcpServers.has(name)) {
    otelTelemetry.mcpServers.set(name, { name, lastSeenAt: null, initAttempts: 0, toolDiscoveryAttempts: 0, failures: 0, durationMs: 0, durationCount: 0, lastStatus: "unknown" });
  }
  return otelTelemetry.mcpServers.get(name);
}

function noteMcpServer(name, span, attributes) {
  if (typeof name !== "string" || !name.trim()) return;
  const server = mcpServer(name.trim());
  const durationMs = otelDurationMs(span);
  const timestamp = otelTimestamp(span.endTimeUnixNano) ?? otelTimestamp(span.startTimeUnixNano) ?? new Date().toISOString();
  const statusCode = span.status?.code;
  server.lastSeenAt = timestamp;
  server.durationMs += durationMs;
  server.durationCount += 1;
  if (span.name === "make_rmcp_client" || span.name === "start_server_task" || span.name === "new") server.initAttempts += 1;
  if (span.name === "list_tools_for_client_uncached" || span.name === "list_tools_with_connector_ids") server.toolDiscoveryAttempts += 1;
  if (statusCode === 2 || statusCode === "ERROR") {
    server.failures += 1;
    server.lastStatus = "error";
  } else if (span.name === "list_tools_for_client_uncached" || span.name === "list_tools_with_connector_ids" || span.name === "initialize") {
    server.lastStatus = "ready";
  } else if (server.lastStatus === "unknown") {
    server.lastStatus = "observed";
  }
  if (attributes["error.type"] || attributes["error.message"]) server.lastStatus = "error";
}

function noteConversation(attributes, resourceAttributes = {}) {
  const id = attributes["conversation.id"] ?? resourceAttributes["conversation.id"];
  if (typeof id !== "string" || !id) return null;
  const session = otelTelemetry.sessions.get(id) ?? { id, model: null, mcpServers: new Set(), lastSeenAt: null };
  session.model = attributes.model ?? resourceAttributes.model ?? session.model;
  session.lastSeenAt = attributes["event.timestamp"] ?? new Date().toISOString();
  const names = resourceAttributes.mcp_servers;
  if (typeof names === "string") {
    for (const name of names.split(",").map((item) => item.trim()).filter(Boolean)) {
      session.mcpServers.add(name);
      const server = mcpServer(name);
      if (server.lastStatus === "unknown") server.lastStatus = "configured";
    }
  }
  otelTelemetry.sessions.set(id, session);
  return session;
}

function ingestOtelLogs(payload) {
  for (const resourceLog of payload.resourceLogs ?? []) {
    const resource = otelAttributes(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const attributes = otelAttributes(record.attributes);
        const eventName = attributes["event.name"];
        noteConversation(attributes, resource);
        if (eventName === "codex.conversation_starts") {
          noteConversation(attributes, resource);
        } else if (eventName === "codex.user_prompt") {
          otelTelemetry.turns.prompts += 1;
          otelTelemetry.turns.promptLength += numberAttribute(attributes, "prompt_length");
        } else if (eventName === "codex.turn_ttft") {
          const duration = numberAttribute(attributes, "duration_ms");
          otelTelemetry.turns.ttftMs += duration;
          otelTelemetry.turns.ttftCount += duration > 0 ? 1 : 0;
        } else if (eventName === "codex.sse_event" && attributes["event.kind"] === "response.completed") {
          otelTelemetry.turns.completed += 1;
          otelTelemetry.tokens.input += numberAttribute(attributes, "input_token_count");
          otelTelemetry.tokens.output += numberAttribute(attributes, "output_token_count");
          otelTelemetry.tokens.cached += numberAttribute(attributes, "cached_token_count");
          otelTelemetry.tokens.reasoning += numberAttribute(attributes, "reasoning_token_count");
          otelTelemetry.tokens.tool += numberAttribute(attributes, "tool_token_count");
        }
      }
    }
  }
}

function ingestOtelTraces(payload) {
  for (const resourceSpan of payload.resourceSpans ?? []) {
    const resource = otelAttributes(resourceSpan.resource?.attributes);
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const attributes = otelAttributes(span.attributes);
        noteConversation(attributes, resource);
        noteMcpServer(attributes.server_name, span, attributes);
      }
    }
  }
}

function otelSeriesKey(seriesName, attributes, startTimeUnixNano) {
  // Keep raw OTLP attributes out of the in-memory/persisted series key. Some
  // exporters attach high-cardinality IDs or paths to data points.
  const identity = JSON.stringify(Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))));
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${seriesName}::${digest}::${startTimeUnixNano ?? ""}`;
}

function otelNanoTimestamp(value) {
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

// OTLP represents DELTA temporality as enum value 1, either as the raw
// number or (in some protojson encodings) the enum name; anything else is
// treated as CUMULATIVE, which is the Codex exporter's default.
const OTEL_DELTA_TEMPORALITY_VALUES = new Set([1, "1", "AGGREGATION_TEMPORALITY_DELTA"]);

function isDeltaTemporality(temporality) {
  return OTEL_DELTA_TEMPORALITY_VALUES.has(temporality);
}

// Applies an OTLP data point to `otelMetricSeries`, returning only the value
// to add to a running aggregate for that series. Cumulative points resend
// the running total on every export, so the delta since the last observed
// point/timestamp is applied; a value lower than the last observed one is
// treated as a counter reset and reported in full. Delta points already
// report the increment for their window, so the value is applied as-is.
// Either way, duplicate resends of the same timestamp yield a zero delta.
function otelSeriesDelta(seriesKey, timeUnixNano, value, temporality) {
  const timestamp = otelNanoTimestamp(timeUnixNano);
  const previous = otelMetricSeries.get(seriesKey);
  if (previous && timestamp > 0n && timestamp <= previous.timestamp) return 0;
  const delta = !isDeltaTemporality(temporality) && previous && value >= previous.value ? value - previous.value : value;
  otelMetricSeries.set(seriesKey, { timestamp, value });
  return Math.max(0, delta);
}

function otelSumDataPointValue(dataPoint) {
  if (dataPoint.asInt !== undefined) return numberAttribute({ value: dataPoint.asInt }, "value");
  if (dataPoint.asDouble !== undefined) return numberAttribute({ value: dataPoint.asDouble }, "value");
  return 0;
}

function skillBucket(name) {
  if (!otelTelemetry.skills.injected.bySkill.has(name)) {
    otelTelemetry.skills.injected.bySkill.set(name, { skill: name, total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {} });
  }
  return otelTelemetry.skills.injected.bySkill.get(name);
}

function skillAgentKind(attributes) {
  const sessionSource = typeof attributes.session_source === "string" ? attributes.session_source.trim() : "";
  if (!sessionSource) return "unknown";
  return sessionSource.startsWith("subagent_thread_spawn_") ? "subagent" : "root";
}

function noteSkillInjected(metricName, attributes, dataPoint, temporality) {
  const delta = otelSeriesDelta(otelSeriesKey(metricName, attributes, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
  if (delta === 0) return;
  const skill = safeMetricLabel(attributes.skill);
  const status = safeMetricLabel(attributes.status);
  // Some Codex versions attach `invoke_type` instead of, or alongside,
  // `status`; tolerate its absence and aggregate it separately when present.
  const invokeType = typeof attributes.invoke_type === "string" && attributes.invoke_type ? safeMetricLabel(attributes.invoke_type) : null;
  const agentKind = skillAgentKind(attributes);
  const model = safeMetricLabel(attributes.model_slug ?? attributes.model, "unknown");
  const plugin = safeMetricLabel(attributes.plugin_id, "none");
  const injected = otelTelemetry.skills.injected;
  injected.total += delta;
  injected.byStatus[status] = (injected.byStatus[status] ?? 0) + delta;
  if (invokeType) injected.byInvokeType[invokeType] = (injected.byInvokeType[invokeType] ?? 0) + delta;
  injected.byAgentKind[agentKind] = (injected.byAgentKind[agentKind] ?? 0) + delta;
  injected.byModel[model] = (injected.byModel[model] ?? 0) + delta;
  injected.byPlugin[plugin] = (injected.byPlugin[plugin] ?? 0) + delta;
  const bucket = skillBucket(skill);
  bucket.total += delta;
  bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
  if (invokeType) bucket.byInvokeType[invokeType] = (bucket.byInvokeType[invokeType] ?? 0) + delta;
  bucket.byAgentKind[agentKind] = (bucket.byAgentKind[agentKind] ?? 0) + delta;
  bucket.byModel[model] = (bucket.byModel[model] ?? 0) + delta;
  bucket.byPlugin[plugin] = (bucket.byPlugin[plugin] ?? 0) + delta;
}

function skillUsageBucket(name) {
  if (!otelTelemetry.skills.usage.bySkill.has(name)) {
    otelTelemetry.skills.usage.bySkill.set(name, { skill: name, total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {} });
  }
  return otelTelemetry.skills.usage.bySkill.get(name);
}

function noteSkillUsage(target, bucketForSkill, metricName, attributes, dataPoint, temporality, value = otelSumDataPointValue(dataPoint)) {
  const delta = otelSeriesDelta(otelSeriesKey(metricName, attributes, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, value, temporality);
  if (delta === 0) return;
  const skill = safeMetricLabel(attributes.skill ?? attributes.skill_name, "unknown-skill");
  const status = safeMetricLabel(attributes.status);
  const invokeType = typeof attributes.invoke_type === "string" && attributes.invoke_type ? safeMetricLabel(attributes.invoke_type) : null;
  const agentKind = skillAgentKind(attributes);
  const model = safeMetricLabel(attributes.model_slug ?? attributes.model, "unknown");
  const plugin = safeMetricLabel(attributes.plugin_id, "none");
  target.total += delta;
  target.byStatus[status] = (target.byStatus[status] ?? 0) + delta;
  if (invokeType) target.byInvokeType[invokeType] = (target.byInvokeType[invokeType] ?? 0) + delta;
  target.byAgentKind[agentKind] = (target.byAgentKind[agentKind] ?? 0) + delta;
  target.byModel[model] = (target.byModel[model] ?? 0) + delta;
  target.byPlugin[plugin] = (target.byPlugin[plugin] ?? 0) + delta;
  const bucket = bucketForSkill(skill);
  bucket.total += delta;
  bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
  if (invokeType) bucket.byInvokeType[invokeType] = (bucket.byInvokeType[invokeType] ?? 0) + delta;
  bucket.byAgentKind[agentKind] = (bucket.byAgentKind[agentKind] ?? 0) + delta;
  bucket.byModel[model] = (bucket.byModel[model] ?? 0) + delta;
  bucket.byPlugin[plugin] = (bucket.byPlugin[plugin] ?? 0) + delta;
}

function noteSkillSelectionHistogram(bucket, metricName, attributes, dataPoint, temporality) {
  noteThreadSkillsHistogram(bucket, metricName, attributes, dataPoint, temporality);
}

function noteThreadSkillsHistogram(bucket, metricName, attributes, dataPoint, temporality) {
  const countDelta = otelSeriesDelta(otelSeriesKey(`${metricName}#count`, attributes, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, "count"), temporality);
  const sumDelta = otelSeriesDelta(otelSeriesKey(`${metricName}#sum`, attributes, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, "sum"), temporality);
  bucket.count += countDelta;
  bucket.sum += sumDelta;
}

function metricDataPointCount(metric) {
  return (metric.sum?.dataPoints?.length ?? 0)
    + (metric.histogram?.dataPoints?.length ?? 0)
    + (metric.gauge?.dataPoints?.length ?? 0)
    + (metric.exponentialHistogram?.dataPoints?.length ?? 0);
}

function noteMetricInventory(metric) {
  if (typeof metric.name !== "string" || !metric.name) return;
  const entry = otelTelemetry.metricInventory.get(metric.name) ?? { name: metric.name, exports: 0, dataPoints: 0 };
  entry.exports += 1;
  entry.dataPoints += metricDataPointCount(metric);
  otelTelemetry.metricInventory.set(metric.name, entry);
}

function safeMetricLabel(value, fallback = "unknown") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) || fallback;
}

function sqliteKey(attributes) {
  return `${safeMetricLabel(attributes.db)}::${safeMetricLabel(attributes.status)}`;
}

function sqliteBucket(collection, attributes) {
  const key = sqliteKey(attributes);
  if (!collection.has(key)) collection.set(key, { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status), count: 0 });
  return collection.get(key);
}

function sqliteDurationBucket(attributes) {
  const key = sqliteKey(attributes);
  if (!otelTelemetry.sqlite.initDurationMs.has(key)) {
    otelTelemetry.sqlite.initDurationMs.set(key, { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status), count: 0, sum: 0 });
  }
  return otelTelemetry.sqlite.initDurationMs.get(key);
}

function noteSqliteCounter(collection, metricName, attributes, dataPoint, temporality) {
  const value = otelSumDataPointValue(dataPoint);
  const delta = otelSeriesDelta(otelSeriesKey(metricName, { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status) }, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, value, temporality);
  sqliteBucket(collection, attributes).count += delta;
}

function toolKey(attributes) {
  return [safeMetricLabel(attributes.tool_name, "unknown-tool"), safeMetricLabel(attributes.source), safeMetricLabel(attributes.server_name, "")].join("::");
}

function toolBucket(attributes) {
  const tool = safeMetricLabel(attributes.tool_name, "unknown-tool");
  const source = safeMetricLabel(attributes.source);
  const server = safeMetricLabel(attributes.server_name, "");
  const key = toolKey(attributes);
  if (!otelTelemetry.tools.has(key)) otelTelemetry.tools.set(key, { tool, source, server, count: 0, byStatus: {}, durationCount: 0, durationMs: 0 });
  return otelTelemetry.tools.get(key);
}

function noteToolCounter(metricName, attributes, dataPoint, temporality) {
  const delta = otelSeriesDelta(otelSeriesKey(metricName, { tool_name: safeMetricLabel(attributes.tool_name, "unknown-tool"), source: safeMetricLabel(attributes.source), server_name: safeMetricLabel(attributes.server_name, "") }, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
  if (delta === 0) return;
  const bucket = toolBucket(attributes);
  const status = safeMetricLabel(attributes.status);
  bucket.count += delta;
  bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
}

function noteToolDuration(metricName, attributes, dataPoint, temporality) {
  const identity = { tool_name: safeMetricLabel(attributes.tool_name, "unknown-tool"), source: safeMetricLabel(attributes.source), server_name: safeMetricLabel(attributes.server_name, "") };
  const count = otelSeriesDelta(otelSeriesKey(`${metricName}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, "count"), temporality);
  const sum = otelSeriesDelta(otelSeriesKey(`${metricName}#sum`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, "sum"), temporality);
  const bucket = toolBucket(attributes);
  bucket.durationCount += count;
  bucket.durationMs += sum;
}

function hookKey(attributes) {
  return [safeMetricLabel(attributes.hook_name, "unknown-hook"), safeMetricLabel(attributes.hook_source), safeMetricLabel(attributes.handler_type, "")].join("::");
}

function hookBucket(attributes) {
  const hook = safeMetricLabel(attributes.hook_name, "unknown-hook");
  const source = safeMetricLabel(attributes.hook_source);
  const handlerType = safeMetricLabel(attributes.handler_type, "");
  const key = hookKey(attributes);
  if (!otelTelemetry.hooks.has(key)) otelTelemetry.hooks.set(key, { hook, source, handlerType, count: 0, byStatus: {}, durationCount: 0, durationMs: 0 });
  return otelTelemetry.hooks.get(key);
}

function noteHookCounter(metricName, attributes, dataPoint, temporality) {
  const identity = { hook_name: safeMetricLabel(attributes.hook_name, "unknown-hook"), hook_source: safeMetricLabel(attributes.hook_source), handler_type: safeMetricLabel(attributes.handler_type, "") };
  const delta = otelSeriesDelta(otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
  if (delta === 0) return;
  const bucket = hookBucket(attributes);
  const status = safeMetricLabel(attributes.status);
  bucket.count += delta;
  bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
}

function noteHookDuration(metricName, attributes, dataPoint, temporality) {
  const identity = { hook_name: safeMetricLabel(attributes.hook_name, "unknown-hook"), hook_source: safeMetricLabel(attributes.hook_source), handler_type: safeMetricLabel(attributes.handler_type, "") };
  const count = otelSeriesDelta(otelSeriesKey(`${metricName}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, "count"), temporality);
  const sum = otelSeriesDelta(otelSeriesKey(`${metricName}#sum`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, "sum"), temporality);
  const bucket = hookBucket(attributes);
  bucket.durationCount += count;
  bucket.durationMs += sum;
}

function noteHookHistogramCount(metricName, attributes, dataPoint, temporality) {
  const identity = { hook_name: safeMetricLabel(attributes.hook_name, "unknown-hook"), hook_source: safeMetricLabel(attributes.hook_source), handler_type: safeMetricLabel(attributes.handler_type, "") };
  const delta = otelSeriesDelta(otelSeriesKey(`${metricName}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, "count"), temporality);
  if (delta === 0) return;
  const bucket = hookBucket(attributes);
  const status = safeMetricLabel(attributes.status);
  bucket.count += delta;
  bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
}

function noteThreadStarted(metricName, attributes, dataPoint, temporality) {
  const source = safeMetricLabel(attributes.source ?? attributes.thread_source ?? attributes.origin);
  const delta = otelSeriesDelta(otelSeriesKey(metricName, { source }, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
  otelTelemetry.threads.started.total += delta;
  otelTelemetry.threads.started.bySource[source] = (otelTelemetry.threads.started.bySource[source] ?? 0) + delta;
}

function noteHistogramCount(target, metricName, attributes, dataPoint, temporality) {
  const source = safeMetricLabel(attributes.source ?? attributes.thread_source ?? attributes.origin);
  const delta = otelSeriesDelta(otelSeriesKey(`${metricName}#count`, { source }, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, "count"), temporality);
  target.total += delta;
  target.bySource[source] = (target.bySource[source] ?? 0) + delta;
}

function noteThreadSpawn(metricName, attributes, dataPoint, temporality) {
  const role = safeMetricLabel(attributes.agent_role ?? attributes.role);
  const model = safeMetricLabel(attributes.requested_model ?? attributes.model);
  const identity = { agent_role: role, requested_model: model };
  const delta = otelSeriesDelta(otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
  if (delta === 0) return;
  const status = safeMetricLabel(attributes.status ?? attributes.spawned);
  const spawns = otelTelemetry.threads.spawns;
  spawns.total += delta;
  spawns.byStatus[status] = (spawns.byStatus[status] ?? 0) + delta;
  spawns.byRole[role] = (spawns.byRole[role] ?? 0) + delta;
  spawns.byModel[model] = (spawns.byModel[model] ?? 0) + delta;
}

// Canonical full OTLP metric names for thread-level skill histograms. Codex
// reports `description_truncated_chars` as its own histogram (distribution
// of trimmed-description sizes across truncated skills), not an attribute.
const SKILL_SELECTION_HISTOGRAMS = {
  "codex.skills.shadow_selection.catalog_entries": "catalogEntries",
  "codex.skills.shadow_selection.selected_entries": "selectedEntries",
  "codex.skills.shadow_selection.query_terms": "queryTerms",
  "codex.skills.shadow_selection.reduction_bps": "reductionBps",
  "codex.skills.shadow_selection.duration_ms": "durationMs",
  "codex.skill.turn.duration_seconds": "durationSeconds",
};

const THREAD_SKILLS_HISTOGRAMS = {
  "codex.thread.skills.enabled_total": "enabled",
  "codex.thread.skills.kept_total": "kept",
  "codex.thread.skills.truncated": "truncated",
  "codex.thread.skills.description_truncated_chars": "descriptionTruncatedChars",
};

function ingestOtelMetrics(payload) {
  for (const resourceMetric of payload.resourceMetrics ?? []) {
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        noteMetricInventory(metric);
        if (metric.name === "codex.skill.injected") {
          const temporality = metric.sum?.aggregationTemporality;
          const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
          for (const dataPoint of metric.sum?.dataPoints ?? []) {
            noteSkillInjected(metric.name, { ...resourceAttributes, ...otelAttributes(dataPoint.attributes) }, dataPoint, temporality);
          }
        } else if (metric.name === "codex.skills.shadow_selection.invocation") {
          const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
          const attributesForMetric = (dataPoint) => ({ ...resourceAttributes, ...otelAttributes(dataPoint.attributes) });
          const temporality = metric.sum?.aggregationTemporality;
          for (const dataPoint of metric.sum?.dataPoints ?? []) noteSkillUsage(otelTelemetry.skills.usage, skillUsageBucket, metric.name, attributesForMetric(dataPoint), dataPoint, temporality);
          const histogramTemporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) noteSkillUsage(otelTelemetry.skills.usage, skillUsageBucket, metric.name, attributesForMetric(dataPoint), dataPoint, histogramTemporality, numberAttribute({ count: dataPoint.count }, "count"));
        } else if (SKILL_SELECTION_HISTOGRAMS[metric.name]) {
          const bucket = otelTelemetry.skills.selection[SKILL_SELECTION_HISTOGRAMS[metric.name]];
          const temporality = metric.histogram?.aggregationTemporality;
          const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
          for (const dataPoint of metric.histogram?.dataPoints ?? []) noteSkillSelectionHistogram(bucket, metric.name, { ...resourceAttributes, ...otelAttributes(dataPoint.attributes) }, dataPoint, temporality);
        } else if (THREAD_SKILLS_HISTOGRAMS[metric.name]) {
          const bucket = otelTelemetry.skills.threads[THREAD_SKILLS_HISTOGRAMS[metric.name]];
          const temporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) {
            noteThreadSkillsHistogram(bucket, metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
          }
        } else if (metric.name === "codex.sqlite.init.count" || metric.name === "codex.sqlite.fallback.count") {
          const collection = metric.name.endsWith("fallback.count") ? otelTelemetry.sqlite.fallbacks : otelTelemetry.sqlite.init;
          const temporality = metric.sum?.aggregationTemporality;
          for (const dataPoint of metric.sum?.dataPoints ?? []) noteSqliteCounter(collection, metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
        } else if (metric.name === "codex.sqlite.init.duration_ms") {
          const temporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) {
            const attributes = otelAttributes(dataPoint.attributes);
            const identity = { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status) };
            const count = otelSeriesDelta(otelSeriesKey(`${metric.name}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, "count"), temporality);
            const sum = otelSeriesDelta(otelSeriesKey(`${metric.name}#sum`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, "sum"), temporality);
            const bucket = sqliteDurationBucket(attributes);
            bucket.count += count;
            bucket.sum += sum;
          }
        } else if (metric.name === "codex.tool.call") {
          const temporality = metric.sum?.aggregationTemporality;
          for (const dataPoint of metric.sum?.dataPoints ?? []) noteToolCounter(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
        } else if (metric.name === "codex.tool.call.duration_ms") {
          const temporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) noteToolDuration(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
        } else if (metric.name === "codex.hooks.run") {
          const temporality = metric.sum?.aggregationTemporality;
          for (const dataPoint of metric.sum?.dataPoints ?? []) noteHookCounter(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
          const histogramTemporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) noteHookHistogramCount(metric.name, otelAttributes(dataPoint.attributes), dataPoint, histogramTemporality);
        } else if (metric.name === "codex.hooks.run.duration_ms") {
          const temporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) noteHookDuration(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
        } else if (metric.name === "codex.thread.started") {
          const temporality = metric.sum?.aggregationTemporality;
          for (const dataPoint of metric.sum?.dataPoints ?? []) noteThreadStarted(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
          const histogramTemporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) noteHistogramCount(otelTelemetry.threads.started, metric.name, otelAttributes(dataPoint.attributes), dataPoint, histogramTemporality);
        } else if (metric.name === "codex.multi_agent.spawn") {
          const temporality = metric.sum?.aggregationTemporality;
          for (const dataPoint of metric.sum?.dataPoints ?? []) noteThreadSpawn(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
          const histogramTemporality = metric.histogram?.aggregationTemporality;
          for (const dataPoint of metric.histogram?.dataPoints ?? []) noteThreadSpawn(metric.name, otelAttributes(dataPoint.attributes), { ...dataPoint, asInt: dataPoint.count }, histogramTemporality);
        }
      }
    }
  }
}

function ingestOtelSignal(signal, payload) {
  otelTelemetry.receiver[signal] += 1;
  otelTelemetry.receiver.lastReceivedAt = new Date().toISOString();
  if (signal === "logs") ingestOtelLogs(payload);
  if (signal === "traces") ingestOtelTraces(payload);
  if (signal === "metrics") ingestOtelMetrics(payload);
  scheduleRouterStatePersist();
}

function resetOtelTelemetry() {
  otelTelemetry.receiver = { logs: 0, traces: 0, metrics: 0, invalid: 0, lastReceivedAt: null };
  otelTelemetry.sessions.clear();
  otelTelemetry.mcpServers.clear();
  otelTelemetry.turns = { prompts: 0, completed: 0, promptLength: 0, ttftMs: 0, ttftCount: 0 };
  otelTelemetry.tokens = { input: 0, output: 0, cached: 0, reasoning: 0, tool: 0 };
  otelTelemetry.metricInventory.clear();
  otelTelemetry.tools.clear();
  otelTelemetry.hooks.clear();
  otelTelemetry.threads = { started: { total: 0, bySource: {} }, spawns: { total: 0, byStatus: {}, byRole: {}, byModel: {} } };
  otelTelemetry.sqlite = { init: new Map(), initDurationMs: new Map(), fallbacks: new Map() };
  otelTelemetry.skills.injected = { total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {}, bySkill: new Map() };
  otelTelemetry.skills.usage = { total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {}, bySkill: new Map() };
  otelTelemetry.skills.selection = {
    catalogEntries: { count: 0, sum: 0 }, selectedEntries: { count: 0, sum: 0 }, queryTerms: { count: 0, sum: 0 },
    reductionBps: { count: 0, sum: 0 }, durationMs: { count: 0, sum: 0 }, durationSeconds: { count: 0, sum: 0 },
  };
  otelTelemetry.skills.threads = {
    enabled: { count: 0, sum: 0 },
    kept: { count: 0, sum: 0 },
    truncated: { count: 0, sum: 0 },
    descriptionTruncatedChars: { count: 0, sum: 0 },
  };
  otelMetricSeries.clear();
}

function codexTelemetryStatus(now = Date.now()) {
  const mcpServers = [...otelTelemetry.mcpServers.values()].map((server) => {
    const lastSeenMs = server.lastSeenAt ? Date.parse(server.lastSeenAt) : NaN;
    const fresh = Number.isFinite(lastSeenMs) && now - lastSeenMs <= OTEL_HEALTH_TTL_MS;
    return { ...server, health: fresh ? server.lastStatus : "stale", averageDurationMs: server.durationCount ? Math.round(server.durationMs / server.durationCount) : 0 };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const sessions = [...otelTelemetry.sessions.values()];
  const mcpSummary = mcpServers.reduce((summary, server) => {
    summary.observed += 1;
    if (server.health === "ready") summary.ready += 1;
    if (server.health === "error") summary.error += 1;
    if (server.health === "stale") summary.stale += 1;
    return summary;
  }, { observed: 0, ready: 0, error: 0, stale: 0 });
  const skillsInjected = otelTelemetry.skills.injected;
  const globalSkillInvokeTypes = Object.entries(skillsInjected.byInvokeType);
  const skillRows = [...skillsInjected.bySkill.values()].map((bucket) => {
    const byInvokeType = { ...bucket.byInvokeType };
    // Older persisted OTEL state recorded invoke_type only at the global
    // level. If that aggregate contains exactly one type for every injection,
    // applying it to each skill row is lossless; mixed aggregates remain
    // un-attributed rather than being guessed.
    if (!Object.keys(byInvokeType).length && globalSkillInvokeTypes.length === 1 && globalSkillInvokeTypes[0][1] === skillsInjected.total) {
      byInvokeType[globalSkillInvokeTypes[0][0]] = bucket.total;
    }
    return { ...bucket, byStatus: { ...bucket.byStatus }, byInvokeType, byAgentKind: { ...bucket.byAgentKind }, byModel: { ...bucket.byModel }, byPlugin: { ...bucket.byPlugin } };
  });
  const skillsUsage = otelTelemetry.skills.usage;
  const usageRows = [...skillsUsage.bySkill.values()].map((bucket) => ({ ...bucket, byStatus: { ...bucket.byStatus }, byInvokeType: { ...bucket.byInvokeType }, byAgentKind: { ...bucket.byAgentKind }, byModel: { ...bucket.byModel }, byPlugin: { ...bucket.byPlugin } })).sort((a, b) => a.skill.localeCompare(b.skill));
  const threadHistogram = (bucket) => ({ ...bucket, average: bucket.count ? bucket.sum / bucket.count : 0 });
  const sqliteBuckets = (collection) => [...collection.values()].map((bucket) => ({ ...bucket, ...(Object.hasOwn(bucket, "sum") ? { average: bucket.count ? bucket.sum / bucket.count : 0 } : {}) })).sort((a, b) => `${a.db}/${a.status}`.localeCompare(`${b.db}/${b.status}`));
  return {
    receiver: { ...otelTelemetry.receiver },
    sessionsObserved: sessions.length,
    sessionsRecent: sessions.filter((session) => session.lastSeenAt && now - Date.parse(session.lastSeenAt) <= OTEL_HEALTH_TTL_MS).length,
    turns: { ...otelTelemetry.turns, averageTtftMs: otelTelemetry.turns.ttftCount ? Math.round(otelTelemetry.turns.ttftMs / otelTelemetry.turns.ttftCount) : 0 },
    tokens: { ...otelTelemetry.tokens, total: Object.values(otelTelemetry.tokens).reduce((sum, value) => sum + value, 0) },
    mcpSummary,
    mcpServers,
    metrics: {
      observed: [...otelTelemetry.metricInventory.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    tools: {
      byTool: [...otelTelemetry.tools.values()].map((tool) => ({ ...tool, averageDurationMs: tool.durationCount ? tool.durationMs / tool.durationCount : 0, byStatus: { ...tool.byStatus } })).sort((a, b) => `${a.tool}/${a.source}/${a.server}`.localeCompare(`${b.tool}/${b.source}/${b.server}`)),
    },
    hooks: {
      byHook: [...otelTelemetry.hooks.values()].map((hook) => ({ ...hook, averageDurationMs: hook.durationCount ? hook.durationMs / hook.durationCount : 0, byStatus: { ...hook.byStatus } })).sort((a, b) => `${a.hook}/${a.source}/${a.handlerType}`.localeCompare(`${b.hook}/${b.source}/${b.handlerType}`)),
    },
    threads: {
      started: { total: otelTelemetry.threads.started.total, bySource: { ...otelTelemetry.threads.started.bySource } },
      spawns: { ...otelTelemetry.threads.spawns, byStatus: { ...otelTelemetry.threads.spawns.byStatus }, byRole: { ...otelTelemetry.threads.spawns.byRole }, byModel: { ...otelTelemetry.threads.spawns.byModel } },
    },
    sqlite: {
      init: { byDbStatus: sqliteBuckets(otelTelemetry.sqlite.init), total: [...otelTelemetry.sqlite.init.values()].reduce((sum, bucket) => sum + bucket.count, 0) },
      initDurationMs: { byDbStatus: sqliteBuckets(otelTelemetry.sqlite.initDurationMs), totalCount: [...otelTelemetry.sqlite.initDurationMs.values()].reduce((sum, bucket) => sum + bucket.count, 0), totalSum: [...otelTelemetry.sqlite.initDurationMs.values()].reduce((sum, bucket) => sum + bucket.sum, 0) },
      fallbacks: { byDbStatus: sqliteBuckets(otelTelemetry.sqlite.fallbacks), total: [...otelTelemetry.sqlite.fallbacks.values()].reduce((sum, bucket) => sum + bucket.count, 0) },
    },
    skills: {
      injected: {
        total: skillsInjected.total,
        byStatus: { ...skillsInjected.byStatus },
        byInvokeType: { ...skillsInjected.byInvokeType },
        byAgentKind: { ...skillsInjected.byAgentKind },
        byModel: { ...skillsInjected.byModel },
        byPlugin: { ...skillsInjected.byPlugin },
        bySkill: skillRows.sort((a, b) => a.skill.localeCompare(b.skill)),
      },
      usage: {
        total: skillsUsage.total,
        byStatus: { ...skillsUsage.byStatus },
        byInvokeType: { ...skillsUsage.byInvokeType },
        byAgentKind: { ...skillsUsage.byAgentKind },
        byModel: { ...skillsUsage.byModel },
        byPlugin: { ...skillsUsage.byPlugin },
        bySkill: usageRows,
      },
      selection: {
        catalogEntries: threadHistogram(otelTelemetry.skills.selection.catalogEntries),
        selectedEntries: threadHistogram(otelTelemetry.skills.selection.selectedEntries),
        queryTerms: threadHistogram(otelTelemetry.skills.selection.queryTerms),
        reductionBps: threadHistogram(otelTelemetry.skills.selection.reductionBps),
        durationMs: threadHistogram(otelTelemetry.skills.selection.durationMs),
        durationSeconds: threadHistogram(otelTelemetry.skills.selection.durationSeconds),
      },
      threads: {
        enabledTotal: threadHistogram(otelTelemetry.skills.threads.enabled),
        keptTotal: threadHistogram(otelTelemetry.skills.threads.kept),
        truncated: threadHistogram(otelTelemetry.skills.threads.truncated),
        // Only reported by Codex when at least one skill description was
        // trimmed for a thread; count stays 0 when the metric is absent.
        descriptionTruncatedChars: threadHistogram(otelTelemetry.skills.threads.descriptionTruncatedChars),
      },
    },
  };
}

function parseConcurrencyConfig(file = CODEX_CONFIG_FILE) {
  const result = { file, maxConcurrentThreadsPerSession: null, maxThreads: null };
  if (!existsSync(file)) return result;
  try {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(max_concurrent_threads_per_session|max_threads)\s*=\s*(\d+)\s*$/gm)) {
      const value = Number.parseInt(match[2], 10);
      if (match[1] === "max_concurrent_threads_per_session") result.maxConcurrentThreadsPerSession = value;
      if (match[1] === "max_threads") result.maxThreads = value;
    }
  } catch (error) {
    console.error(`Warning: could not read Codex concurrency config from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

const CODEX_CONFIG_FILE = process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ?? `${CODEX_HOME}/config.toml`;
const CONCURRENCY_CONFIG = parseConcurrencyConfig();
// Shared bucket key for requests that carry no caller-identified session. All such
// requests are throttled together (see requestSession()), which trades an over-denial
// risk (unrelated unidentified callers can cap each other) for never silently granting
// unbounded concurrency when the router cannot tell sessions apart.
const PROCESS_FALLBACK_SESSION_KEY = "process-scope";
const activeSubagentSessions = new Map();
const concurrencyTelemetry = { denials: 0, denialsByReason: {}, lastDenial: null };
const spawnFailureTelemetry = { total: 0, byReason: {}, recent: [] };
const DEFAULT_CODEX_BIN = existsSync(`${CODEX_HOME}/packages/standalone/current/bin/codex`)
  ? `${CODEX_HOME}/packages/standalone/current/bin/codex`
  : "codex";
const CODEX_BIN = process.env.CODEX_ROUTER_CODEX_BIN ?? process.env.CODEX_BIN ?? DEFAULT_CODEX_BIN;
const CODEX_TASK_REFRESH_MS = Number.parseInt(process.env.CODEX_ROUTER_TASK_REFRESH_MS ?? "5000", 10);
const CODEX_TASK_MAX_PAGES = Number.parseInt(process.env.CODEX_ROUTER_TASK_MAX_PAGES ?? "5", 10);
let codexTaskSnapshot = { status: "pending", fetchedAt: null, error: null, pages: 0, countsByStatus: {}, tasks: [] };
let codexTaskRefreshPromise = null;

function effectivePerSessionLimit() {
  return CONCURRENCY_CONFIG.maxConcurrentThreadsPerSession ?? CONCURRENCY_CONFIG.maxThreads;
}

function activeSubagentThreads() {
  return [...activeSubagentSessions.values()].reduce((sum, value) => sum + value, 0);
}

function tryAcquireSubagentSlot(sessionKey) {
  const sessionActive = activeSubagentSessions.get(sessionKey) ?? 0;
  const perSessionLimit = effectivePerSessionLimit();
  if (perSessionLimit !== null && sessionActive >= perSessionLimit) return "max_concurrent_threads_per_session";
  activeSubagentSessions.set(sessionKey, sessionActive + 1);
  return null;
}

function releaseSubagentSlot(sessionKey) {
  const current = activeSubagentSessions.get(sessionKey) ?? 0;
  if (current <= 1) activeSubagentSessions.delete(sessionKey);
  else activeSubagentSessions.set(sessionKey, current - 1);
}

function resetConcurrencyTelemetry() {
  activeSubagentSessions.clear();
  concurrencyTelemetry.denials = 0;
  concurrencyTelemetry.denialsByReason = {};
  concurrencyTelemetry.lastDenial = null;
}

function concurrencyStatus() {
  // Exposed unconditionally (not only after a denial) so an operator can see the
  // per-session limit is currently being enforced as a single process-wide bucket
  // for any unidentified caller, rather than discovering it only once denials occur.
  const processFallbackActiveThreads = activeSubagentSessions.get(PROCESS_FALLBACK_SESSION_KEY) ?? 0;
  return {
    configFile: CONCURRENCY_CONFIG.file,
    maxConcurrentThreadsPerSession: effectivePerSessionLimit(),
    effectivePerSessionLimit: effectivePerSessionLimit(),
    activeSubagentThreads: activeSubagentThreads(),
    activeSessions: activeSubagentSessions.size,
    processFallbackActiveThreads,
    processFallbackEnforcement: processFallbackActiveThreads > 0,
    denials: concurrencyTelemetry.denials,
    denialsByReason: { ...concurrencyTelemetry.denialsByReason },
    lastDenial: concurrencyTelemetry.lastDenial,
  };
}

function recordConcurrencyDenial({ requestId, role, requestedModel, sessionScope, reason }) {
  concurrencyTelemetry.denials += 1;
  concurrencyTelemetry.denialsByReason[reason] = (concurrencyTelemetry.denialsByReason[reason] ?? 0) + 1;
  concurrencyTelemetry.lastDenial = { timestamp: new Date().toISOString(), requestId, role, requestedModel, sessionScope, reason };
  recordSpawnFailure({ requestId, role, requestedModel, reason });
  recordRouterEvent({ phase: "denied", requestId, role, requestedModel, provider: null, model: null, failureClass: "concurrency_limit", denialReason: reason });
}

function normalizeCodexTimestamp(value) {
  if (value == null) return null;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (Number.isFinite(numeric)) {
    // Codex app-server thread/list timestamps are Unix seconds, while browser
    // Date values are milliseconds. Keep this tolerant of millisecond values
    // from other clients or future protocol revisions.
    const milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeCodexTask(task) {
  const rawStatus = task?.status;
  const status = typeof rawStatus === "string" ? rawStatus : rawStatus?.type;
  return {
    id: task?.id ?? task?.sessionId ?? null,
    status: status ?? "unknown",
    name: task?.name ?? null,
    cwd: task?.cwd ?? null,
    createdAt: normalizeCodexTimestamp(task?.createdAt),
    updatedAt: normalizeCodexTimestamp(task?.updatedAt),
    modelProvider: task?.modelProvider ?? null,
    model: task?.model ?? null,
    agentRole: task?.agentRole ?? null,
    source: task?.source ?? null,
    parentThreadId: task?.parentThreadId ?? null,
    threadSource: task?.threadSource ?? null,
  };
}

function summarizeCodexTasks(tasks) {
  const normalized = Array.isArray(tasks) ? tasks.map(normalizeCodexTask).filter((task) => task.id) : [];
  const countsByStatus = {};
  for (const task of normalized) countsByStatus[task.status] = (countsByStatus[task.status] ?? 0) + 1;
  return { countsByStatus, tasks: normalized };
}

function refreshCodexTaskSnapshot() {
  if (!IS_MAIN || codexTaskRefreshPromise || (codexTaskSnapshot.fetchedAt && Date.now() - Date.parse(codexTaskSnapshot.fetchedAt) < CODEX_TASK_REFRESH_MS)) return;
  codexTaskRefreshPromise = new Promise((resolve) => {
    const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    let listRequestId = 2;
    let pageCount = 0;
    const tasks = [];
    const finish = (nextSnapshot) => {
      if (settled) return;
      settled = true;
      codexTaskSnapshot = nextSnapshot;
      child.kill();
      resolve();
    };
    const timer = setTimeout(() => finish({ ...codexTaskSnapshot, status: "unavailable", fetchedAt: new Date().toISOString(), error: "Codex app-server task listing timed out." }), 8000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ id: 2, method: "thread/list", params: { limit: 100, archived: false, sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"], useStateDbOnly: true } }) + "\n");
        } else if (message.id === listRequestId) {
          const result = message.result;
          tasks.push(...(result?.data ?? []));
          pageCount += 1;
          if (result?.nextCursor && pageCount < Math.max(1, CODEX_TASK_MAX_PAGES)) {
            listRequestId += 1;
            child.stdin.write(JSON.stringify({ id: listRequestId, method: "thread/list", params: { limit: 100, cursor: result.nextCursor, archived: false, sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"], useStateDbOnly: true } }) + "\n");
          } else {
            clearTimeout(timer);
            const summary = summarizeCodexTasks(tasks);
            finish({ status: "ready", fetchedAt: new Date().toISOString(), error: null, pages: pageCount, ...summary });
          }
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ...codexTaskSnapshot, status: "unavailable", fetchedAt: new Date().toISOString(), error: error.message });
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "autodev-router", title: "AutoDev router status", version: "1" }, capabilities: {} } }) + "\n");
  }).finally(() => { codexTaskRefreshPromise = null; });
}

function codexTaskStatus() {
  refreshCodexTaskSnapshot();
  return codexTaskSnapshot;
}

function recordSpawnFailure({ requestId, role, requestedModel, reason }) {
  const failure = { timestamp: new Date().toISOString(), requestId, role, requestedModel, reason };
  spawnFailureTelemetry.total += 1;
  spawnFailureTelemetry.byReason[reason] = (spawnFailureTelemetry.byReason[reason] ?? 0) + 1;
  spawnFailureTelemetry.recent.push(failure);
  while (spawnFailureTelemetry.recent.length > 50) spawnFailureTelemetry.recent.shift();
  recordRouterEvent({ phase: "spawn_failed", requestId, role, requestedModel, provider: null, model: null, failureClass: "spawn_failure", spawnFailureReason: reason });
}

function spawnFailureStatus() {
  return {
    total: spawnFailureTelemetry.total,
    byReason: { ...spawnFailureTelemetry.byReason },
    recent: [...spawnFailureTelemetry.recent].reverse(),
  };
}

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

function routeCredentialAvailable(route, environment = process.env) {
  return !route.envKey || Boolean(String(environment[route.envKey] ?? "").trim());
}

function classifyProviderFailure(status, body = "") {
  const text = String(body ?? "");
  if (/session.?limit|session.*(?:exhaust|capacity)|concurrent session/i.test(text)) return "session_limit";
  if (/quota|credit|billing|usage.?limit|usage exhausted|insufficient.*(?:fund|quota)/i.test(text)) return "quota_exhausted";
  if (status === 429 || /rate.?limit|weekly.?limit|throttl|too many requests/i.test(text)) return "throttled";
  if (/high.?demand|overloaded|capacity/i.test(text)) return "capacity";
  if (status === 408 || /timeout|timed.?out/i.test(text)) return "timeout";
  if ([502, 503, 504].includes(status) || /temporarily unavailable|unavailable/i.test(text)) return "unavailable";
  if (/invalid model|model name.*(?:invalid|not found)|unknown model/i.test(text)) return "invalid_model";
  if ([401, 403].includes(status)) return "authentication";
  if (typeof status === "number" && status >= 500) return "upstream_error";
  return "request_error";
}

function recordRouterEvent({ phase, requestId, role = null, requestedModel, provider, model, workspace = null, outcome = null, status = null, failureClass = null, denialReason = null, spawnFailureReason = null, elapsedMs = null, toolCalls = 0, errorName = null, errorCode = null, syscall = null, origin = null }) {
  const timestamp = new Date().toISOString();
  const workspaceContext = typeof workspace === "string" ? { key: workspace, cwd: null } : workspace;
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
    workspace: workspaceContext?.key ?? null,
    cwd: workspaceContext?.cwd ?? null,
    outcome,
    status,
    failureClass,
    denialReason,
    spawnFailureReason,
    elapsedMs,
    toolCalls,
    errorName,
    errorCode,
    syscall,
  };
  recentRouterEvents.push(event);
  while (recentRouterEvents.length > Math.max(1, MAX_RECENT_EVENTS)) recentRouterEvents.shift();

  if (provider && model && ["selected", "skipped", "result"].includes(phase)) {
    recordUsageEvent({ phase, requestId, role, provider, model, workspace: workspaceContext, outcome, failureClass, status, elapsedMs, toolCalls, timestamp, origin });
  }
  const state = provider ? providerState(provider) : null;
  if (state && phase === "selected") {
    state.attempts += 1;
    state.lastAttemptAt = timestamp;
  } else if (state && phase === "skipped") {
    state.skipped += 1;
    state.lastFailureClass = failureClass;
  } else if (state && phase === "result") {
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
  scheduleRouterStatePersist();
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
  resetUsageTelemetry();
  resetConcurrencyTelemetry();
  spawnFailureTelemetry.total = 0;
  spawnFailureTelemetry.byReason = {};
  spawnFailureTelemetry.recent = [];
  providerCooldowns.clear();
  providerFailureStreaks.clear();
  scheduleRouterStatePersist();
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
      failureStreak: providerFailureStreaks.get(route.provider) ?? 0,
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
    telemetryPersistence: { enabled: IS_MAIN, file: STATE_FILE, updatedAt: persistedStateUpdatedAt },
    usage: usageStatus(),
    codexTelemetry: codexTelemetryStatus(),
    concurrency: concurrencyStatus(),
    spawnFailures: spawnFailureStatus(),
    codexTasks: codexTaskStatus(),
    activeRequests: Object.fromEntries(activeProviderRequests),
    providers,
    recentEvents: [...recentRouterEvents].reverse(),
  };
}

function usagePersistenceSnapshot() {
  const withoutActive = (bucket) => {
    const copy = { ...bucket };
    delete copy.active;
    return copy;
  };
  return {
    schemaVersion: 4,
    totals: withoutActive(usageTelemetry.totals),
    byRole: Object.fromEntries(Object.entries(usageTelemetry.byRole).map(([key, bucket]) => [key, withoutActive(bucket)])),
    byModel: Object.fromEntries(Object.entries(usageTelemetry.byModel).map(([key, bucket]) => [key, withoutActive(bucket)])),
    byOrigin: Object.fromEntries(Object.entries(usageTelemetry.byOrigin).map(([key, bucket]) => [key, withoutActive(bucket)])),
    byWorkspace: Object.fromEntries(Object.entries(usageTelemetry.byWorkspace).map(([key, bucket]) => [key, {
      ...withoutActive(bucket),
      byRole: Object.fromEntries(Object.entries(bucket.byRole).map(([name, value]) => [name, withoutActive(value)])),
      byModel: Object.fromEntries(Object.entries(bucket.byModel).map(([name, value]) => [name, withoutActive(value)])),
      byProvider: Object.fromEntries(Object.entries(bucket.byProvider).map(([name, value]) => [name, withoutActive(value)])),
    }])),
  };
}

const OTEL_PERSISTENCE_SCHEMA_VERSION = 1;

function otelPersistenceSnapshot() {
  const telemetry = codexTelemetryStatus();
  return {
    schemaVersion: OTEL_PERSISTENCE_SCHEMA_VERSION,
    receiver: telemetry.receiver,
    turns: telemetry.turns,
    tokens: telemetry.tokens,
    mcpServers: [...otelTelemetry.mcpServers.values()],
    skills: telemetry.skills,
    metrics: telemetry.metrics,
    tools: telemetry.tools,
    hooks: telemetry.hooks,
    threads: telemetry.threads,
    sqlite: telemetry.sqlite,
    // Cumulative exports must resume from their previous point after a
    // restart, otherwise the first post-restart batch would be counted twice.
    series: [...otelMetricSeries.entries()].map(([key, value]) => ({ key, timestamp: value.timestamp.toString(), value: value.value })),
  };
}

function restoreOtelTelemetry(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.schemaVersion !== OTEL_PERSISTENCE_SCHEMA_VERSION) return;
  const isFiniteNonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const restoreNumberFields = (target, source, fields) => {
    for (const field of fields) if (isFiniteNonnegative(source?.[field])) target[field] = source[field];
  };
  restoreNumberFields(otelTelemetry.receiver, snapshot.receiver, ["logs", "traces", "metrics", "invalid"]);
  if (snapshot.receiver?.lastReceivedAt === null || typeof snapshot.receiver?.lastReceivedAt === "string") otelTelemetry.receiver.lastReceivedAt = snapshot.receiver.lastReceivedAt;
  restoreNumberFields(otelTelemetry.turns, snapshot.turns, ["prompts", "completed", "promptLength", "ttftMs", "ttftCount"]);
  restoreNumberFields(otelTelemetry.tokens, snapshot.tokens, ["input", "output", "cached", "reasoning", "tool"]);
  for (const server of Array.isArray(snapshot.mcpServers) ? snapshot.mcpServers : []) {
    if (!server || typeof server !== "object" || typeof server.name !== "string" || !server.name) continue;
    const restored = { name: safeMetricLabel(server.name), lastSeenAt: typeof server.lastSeenAt === "string" ? server.lastSeenAt : null, initAttempts: 0, toolDiscoveryAttempts: 0, failures: 0, durationMs: 0, durationCount: 0, lastStatus: safeMetricLabel(server.lastStatus) };
    restoreNumberFields(restored, server, ["initAttempts", "toolDiscoveryAttempts", "failures", "durationMs", "durationCount"]);
    otelTelemetry.mcpServers.set(restored.name, restored);
  }
  const skills = snapshot.skills;
  if (skills?.injected && typeof skills.injected === "object") {
    restoreNumberFields(otelTelemetry.skills.injected, skills.injected, ["total"]);
    for (const [status, count] of Object.entries(skills.injected.byStatus ?? {})) if (isFiniteNonnegative(count)) otelTelemetry.skills.injected.byStatus[safeMetricLabel(status)] = count;
    for (const [invokeType, count] of Object.entries(skills.injected.byInvokeType ?? {})) if (isFiniteNonnegative(count)) otelTelemetry.skills.injected.byInvokeType[safeMetricLabel(invokeType)] = count;
    for (const [agentKind, count] of Object.entries(skills.injected.byAgentKind ?? {})) if (isFiniteNonnegative(count)) otelTelemetry.skills.injected.byAgentKind[safeMetricLabel(agentKind)] = count;
    for (const [model, count] of Object.entries(skills.injected.byModel ?? {})) if (isFiniteNonnegative(count)) otelTelemetry.skills.injected.byModel[safeMetricLabel(model)] = count;
    for (const [plugin, count] of Object.entries(skills.injected.byPlugin ?? {})) if (isFiniteNonnegative(count)) otelTelemetry.skills.injected.byPlugin[safeMetricLabel(plugin)] = count;
    for (const entry of Array.isArray(skills.injected.bySkill) ? skills.injected.bySkill : []) {
      if (!entry || typeof entry.skill !== "string") continue;
      const bucket = skillBucket(safeMetricLabel(entry.skill));
      restoreNumberFields(bucket, entry, ["total"]);
      for (const [status, count] of Object.entries(entry.byStatus ?? {})) if (isFiniteNonnegative(count)) bucket.byStatus[safeMetricLabel(status)] = count;
      for (const [invokeType, count] of Object.entries(entry.byInvokeType ?? {})) if (isFiniteNonnegative(count)) bucket.byInvokeType[safeMetricLabel(invokeType)] = count;
      for (const [agentKind, count] of Object.entries(entry.byAgentKind ?? {})) if (isFiniteNonnegative(count)) bucket.byAgentKind[safeMetricLabel(agentKind)] = count;
      for (const [model, count] of Object.entries(entry.byModel ?? {})) if (isFiniteNonnegative(count)) bucket.byModel[safeMetricLabel(model)] = count;
      for (const [plugin, count] of Object.entries(entry.byPlugin ?? {})) if (isFiniteNonnegative(count)) bucket.byPlugin[safeMetricLabel(plugin)] = count;
    }
  }
  if (skills?.usage && typeof skills.usage === "object") {
    const usage = otelTelemetry.skills.usage;
    restoreNumberFields(usage, skills.usage, ["total"]);
    for (const [field, target] of [["byStatus", usage.byStatus], ["byInvokeType", usage.byInvokeType], ["byAgentKind", usage.byAgentKind], ["byModel", usage.byModel], ["byPlugin", usage.byPlugin]]) {
      for (const [key, count] of Object.entries(skills.usage[field] ?? {})) if (isFiniteNonnegative(count)) target[safeMetricLabel(key)] = count;
    }
    for (const entry of Array.isArray(skills.usage.bySkill) ? skills.usage.bySkill : []) {
      if (!entry || typeof entry.skill !== "string") continue;
      const bucket = skillUsageBucket(safeMetricLabel(entry.skill));
      restoreNumberFields(bucket, entry, ["total"]);
      for (const [field, target] of [["byStatus", bucket.byStatus], ["byInvokeType", bucket.byInvokeType], ["byAgentKind", bucket.byAgentKind], ["byModel", bucket.byModel], ["byPlugin", bucket.byPlugin]]) {
        for (const [key, count] of Object.entries(entry[field] ?? {})) if (isFiniteNonnegative(count)) target[safeMetricLabel(key)] = count;
      }
    }
  }
  if (skills?.selection && typeof skills.selection === "object") {
    const selection = otelTelemetry.skills.selection;
    for (const [field, source] of [["catalogEntries", skills.selection.catalogEntries], ["selectedEntries", skills.selection.selectedEntries], ["queryTerms", skills.selection.queryTerms], ["reductionBps", skills.selection.reductionBps], ["durationMs", skills.selection.durationMs], ["durationSeconds", skills.selection.durationSeconds]]) restoreNumberFields(selection[field], source, ["count", "sum"]);
  }
  for (const [targetKey, sourceKey] of [["enabled", "enabledTotal"], ["kept", "keptTotal"], ["truncated", "truncated"], ["descriptionTruncatedChars", "descriptionTruncatedChars"]]) {
    restoreNumberFields(otelTelemetry.skills.threads[targetKey], skills?.threads?.[sourceKey], ["count", "sum"]);
  }
  for (const entry of Array.isArray(snapshot.metrics?.observed) ? snapshot.metrics.observed : []) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    const restored = { name: safeMetricLabel(entry.name), exports: 0, dataPoints: 0 };
    restoreNumberFields(restored, entry, ["exports", "dataPoints"]);
    otelTelemetry.metricInventory.set(restored.name, restored);
  }
  for (const entry of Array.isArray(snapshot.tools?.byTool) ? snapshot.tools.byTool : []) {
    if (!entry || typeof entry.tool !== "string") continue;
    const restored = { tool: safeMetricLabel(entry.tool, "unknown-tool"), source: safeMetricLabel(entry.source), server: safeMetricLabel(entry.server, ""), count: 0, byStatus: {}, durationCount: 0, durationMs: 0 };
    restoreNumberFields(restored, entry, ["count", "durationCount", "durationMs"]);
    for (const [status, count] of Object.entries(entry.byStatus ?? {})) if (isFiniteNonnegative(count)) restored.byStatus[safeMetricLabel(status)] = count;
    otelTelemetry.tools.set(toolKey(restored), restored);
  }
  for (const entry of Array.isArray(snapshot.hooks?.byHook) ? snapshot.hooks.byHook : []) {
    if (!entry || typeof entry.hook !== "string") continue;
    const restored = { hook: safeMetricLabel(entry.hook, "unknown-hook"), source: safeMetricLabel(entry.source), handlerType: safeMetricLabel(entry.handlerType, ""), count: 0, byStatus: {}, durationCount: 0, durationMs: 0 };
    restoreNumberFields(restored, entry, ["count", "durationCount", "durationMs"]);
    for (const [status, count] of Object.entries(entry.byStatus ?? {})) if (isFiniteNonnegative(count)) restored.byStatus[safeMetricLabel(status)] = count;
    otelTelemetry.hooks.set(hookKey({ hook_name: restored.hook, hook_source: restored.source, handler_type: restored.handlerType }), restored);
  }
  restoreNumberFields(otelTelemetry.threads.started, snapshot.threads?.started, ["total"]);
  for (const [source, count] of Object.entries(snapshot.threads?.started?.bySource ?? {})) if (isFiniteNonnegative(count)) otelTelemetry.threads.started.bySource[safeMetricLabel(source)] = count;
  restoreNumberFields(otelTelemetry.threads.spawns, snapshot.threads?.spawns, ["total"]);
  for (const target of ["byStatus", "byRole", "byModel"]) for (const [key, count] of Object.entries(snapshot.threads?.spawns?.[target] ?? {})) if (isFiniteNonnegative(count)) otelTelemetry.threads.spawns[target][safeMetricLabel(key)] = count;
  const sqlite = snapshot.sqlite;
  for (const [target, source] of [[otelTelemetry.sqlite.init, sqlite?.init?.byDbStatus], [otelTelemetry.sqlite.fallbacks, sqlite?.fallbacks?.byDbStatus], [otelTelemetry.sqlite.initDurationMs, sqlite?.initDurationMs?.byDbStatus]]) {
    for (const entry of Array.isArray(source) ? source : []) {
      if (!entry || typeof entry.db !== "string" || typeof entry.status !== "string") continue;
      const restored = { db: safeMetricLabel(entry.db), status: safeMetricLabel(entry.status), count: 0 };
      restoreNumberFields(restored, entry, ["count"]);
      if (Object.hasOwn(entry, "sum")) { restored.sum = 0; restoreNumberFields(restored, entry, ["sum"]); }
      target.set(sqliteKey(restored), restored);
    }
  }
  for (const entry of Array.isArray(snapshot.series) ? snapshot.series : []) {
    if (!entry || typeof entry.key !== "string" || typeof entry.timestamp !== "string" || !isFiniteNonnegative(entry.value)) continue;
    try { otelMetricSeries.set(entry.key, { timestamp: BigInt(entry.timestamp), value: entry.value }); } catch { /* Ignore malformed cursors. */ }
  }
}

function serializeRouterState() {
  return JSON.stringify({
    schema: "autodev-router-persisted-state-v1",
    updatedAt: new Date().toISOString(),
    providerTelemetry: Object.fromEntries(providerTelemetry),
    usage: usagePersistenceSnapshot(),
    concurrency: concurrencyTelemetry,
    spawnFailures: spawnFailureTelemetry,
    recentEvents: [...recentRouterEvents],
    otelTelemetry: otelPersistenceSnapshot(),
  }, null, 2);
}

function loadRouterState(file = STATE_FILE) {
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.schema !== "autodev-router-persisted-state-v1") return false;
    for (const [provider, saved] of Object.entries(parsed.providerTelemetry ?? {})) {
      if (!providerTelemetry.has(provider) || !saved || typeof saved !== "object") continue;
      const current = providerState(provider);
      for (const field of ["attempts", "successes", "failures", "skipped"]) {
        if (Number.isInteger(saved[field]) && saved[field] >= 0) current[field] = saved[field];
      }
      for (const field of ["lastAttemptAt", "lastSuccessAt", "lastFailureAt", "lastFailureClass"]) {
        if (saved[field] === null || typeof saved[field] === "string") current[field] = saved[field];
      }
      if (saved.lastFailure === null || (saved.lastFailure && typeof saved.lastFailure === "object")) current.lastFailure = saved.lastFailure;
    }
    if (parsed.usage && typeof parsed.usage === "object") {
      for (const section of ["byRole", "byModel", "byOrigin"]) {
        if (!parsed.usage[section] || typeof parsed.usage[section] !== "object") continue;
        for (const [key, saved] of Object.entries(parsed.usage[section])) {
          if (!saved || typeof saved !== "object") continue;
          const current = usageBucket(usageTelemetry[section], key);
          restoreUsageBucket(current, saved);
        }
      }
      if (parsed.usage.byWorkspace && typeof parsed.usage.byWorkspace === "object") {
        for (const [key, saved] of Object.entries(parsed.usage.byWorkspace)) {
          if (!saved || typeof saved !== "object") continue;
          const current = workspaceBucket(usageTelemetry.byWorkspace, key, typeof saved.cwd === "string" ? saved.cwd : null);
          restoreUsageBucket(current, saved);
          for (const section of ["byRole", "byModel", "byProvider"]) {
            if (!saved[section] || typeof saved[section] !== "object") continue;
            for (const [name, value] of Object.entries(saved[section])) restoreUsageBucket(usageBucket(current[section], name), value);
          }
        }
      }
      const savedTotals = parsed.usage.totals;
      if (savedTotals && typeof savedTotals === "object") {
        restoreUsageBucket(usageTelemetry.totals, savedTotals);
      }
    }
    if (parsed.concurrency && typeof parsed.concurrency === "object") {
      if (Number.isInteger(parsed.concurrency.denials) && parsed.concurrency.denials >= 0) concurrencyTelemetry.denials = parsed.concurrency.denials;
      if (parsed.concurrency.denialsByReason && typeof parsed.concurrency.denialsByReason === "object") concurrencyTelemetry.denialsByReason = { ...parsed.concurrency.denialsByReason };
      if (parsed.concurrency.lastDenial === null || (parsed.concurrency.lastDenial && typeof parsed.concurrency.lastDenial === "object")) concurrencyTelemetry.lastDenial = parsed.concurrency.lastDenial;
    }
    if (parsed.spawnFailures && typeof parsed.spawnFailures === "object") {
      if (Number.isInteger(parsed.spawnFailures.total) && parsed.spawnFailures.total >= 0) spawnFailureTelemetry.total = parsed.spawnFailures.total;
      if (parsed.spawnFailures.byReason && typeof parsed.spawnFailures.byReason === "object") spawnFailureTelemetry.byReason = { ...parsed.spawnFailures.byReason };
      if (Array.isArray(parsed.spawnFailures.recent)) spawnFailureTelemetry.recent = parsed.spawnFailures.recent.filter((item) => item && typeof item === "object").slice(-50);
    }
    restoreOtelTelemetry(parsed.otelTelemetry);
    if (Array.isArray(parsed.recentEvents)) {
      recentRouterEvents.length = 0;
      recentRouterEvents.push(...parsed.recentEvents.filter((event) => event && typeof event === "object").slice(-Math.max(1, MAX_RECENT_EVENTS)));
      if (!parsed.usage) {
        resetUsageTelemetry();
        for (const event of recentRouterEvents) {
          if (event.provider && event.model && event.phase) recordUsageEvent(event);
        }
        inFlightUsage.clear();
      } else if ((parsed.usage.schemaVersion ?? 1) < 3) {
        for (const event of recentRouterEvents) {
          if (event.provider && event.model && event.phase === "skipped") recordUsageEvent(event);
        }
      }
    }
    persistedStateUpdatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    return true;
  } catch (error) {
    console.error(`Warning: could not load router state from ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function persistRouterStateNow(file = STATE_FILE) {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
    persistTimeout = null;
  }
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  persistChain = persistChain.catch(() => {}).then(async () => {
    await writeFile(temporaryFile, serializeRouterState(), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryFile, file);
    persistedStateUpdatedAt = new Date().toISOString();
  }).catch((error) => {
    console.error(`Warning: could not persist router state to ${file}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return persistChain;
}

function scheduleRouterStatePersist() {
  if (!IS_MAIN || persistTimeout) return;
  persistTimeout = setTimeout(() => {
    persistTimeout = null;
    void persistRouterStateNow();
  }, 500);
}

let fatalExitPromise = null;

function handleFatalProcessError(phase, reason) {
  if (fatalExitPromise) return;
  const info = transportErrorInfo(reason);
  console.error(JSON.stringify({
    schema: "autodev-router-event-v1",
    timestamp: new Date().toISOString(),
    routerInstanceId: ROUTER_INSTANCE_ID,
    requestId: null,
    phase,
    errorName: info.name,
    errorCode: info.code,
    syscall: info.syscall,
  }));
  // An uncaught exception or unhandled rejection leaves the process state
  // undefined. Log once, flush durable telemetry, and let launchd restart it;
  // continuing to serve requests would be less safe than a supervised exit.
  fatalExitPromise = persistRouterStateNow()
    .catch(() => undefined)
    .finally(() => process.exit(1));
}

if (IS_MAIN) {
  loadRouterState();
  // Only register these handlers for the executable entrypoint. Imports (for
  // tests and status tooling) must not install process-wide handlers.
  process.on("uncaughtException", (error) => handleFatalProcessError("uncaught_exception", error));
  process.on("unhandledRejection", (reason) => handleFatalProcessError("unhandled_rejection", reason));
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

function isDraining() {
  return lifecycleState !== "ready";
}

function getLifecycleStatus() {
  return {
    state: lifecycleState,
    draining: isDraining(),
    changedAt: lifecycleStateChangedAt,
    activeResponseRequests: activeRequestAborters.size,
  };
}

function registerActiveRequest(abortController) {
  if (!abortController) return;
  activeRequestAborters.add(abortController);
}

function unregisterActiveRequest(abortController) {
  if (!abortController) return;
  activeRequestAborters.delete(abortController);
}

function abortActiveResponseRequests() {
  for (const controller of activeRequestAborters.values()) {
    try { controller.abort(); } catch { /* best effort during shutdown */ }
  }
}

async function jitteredBackoff() {
  const floor = Math.min(CONCRETE_RETRY_BASE_MS, CONCRETE_RETRY_MAX_MS);
  const ceiling = Math.max(floor, Math.min(CONCRETE_RETRY_MAX_MS, CONCRETE_RETRY_BASE_MS * 2));
  const delayMs = floor + Math.floor(Math.random() * (ceiling - floor + 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}

function transportErrorInfo(error) {
  const cause = error && typeof error === "object" ? error.cause : null;
  return {
    name: error && typeof error.name === "string" ? error.name : "Error",
    code: error && typeof error.code === "string"
      ? error.code
      : cause && typeof cause.code === "string" ? cause.code : null,
    syscall: cause && typeof cause.syscall === "string" ? cause.syscall : null,
  };
}

function logTransportError({ requestId, role = null, provider, model, requestedModel = model, error, workspace }) {
  // Avoid leaking credentials, prompts, absolute paths, or raw upstream bodies
  // through stderr. Only the transport diagnostic code/name is captured here.
  const info = transportErrorInfo(error);
  return recordRouterEvent({
    phase: "transport_error",
    requestId,
    role,
    requestedModel,
    provider,
    model,
    workspace,
    errorName: info.name,
    errorCode: info.code,
    syscall: info.syscall,
  });
}

function setLifecycleState(next) {
  lifecycleState = next;
  lifecycleStateChangedAt = new Date().toISOString();
}

async function beginShutdown(signal, server, stateFile = STATE_FILE) {
  if (shutdownPromise) return shutdownPromise;
  setLifecycleState("draining");
  const drainingStartedAt = Date.now();
  const activeAtStart = activeRequestAborters.size;
  console.error(JSON.stringify({
    schema: "autodev-router-event-v1",
    timestamp: new Date().toISOString(),
    routerInstanceId: ROUTER_INSTANCE_ID,
    requestId: null,
    phase: "shutdown_started",
    signal,
    activeRequests: activeAtStart,
    drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
  }));
  shutdownPromise = (async () => {
    while (activeRequestAborters.size > 0 && Date.now() - drainingStartedAt < SHUTDOWN_DRAIN_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (activeRequestAborters.size > 0) abortActiveResponseRequests();
    try { await persistRouterStateNow(stateFile); } catch { /* already logged inside */ }
    if (server && typeof server.close === "function") {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    console.error(JSON.stringify({
      schema: "autodev-router-event-v1",
      timestamp: new Date().toISOString(),
      routerInstanceId: ROUTER_INSTANCE_ID,
      requestId: null,
      phase: "shutdown_complete",
      durationMs: Date.now() - drainingStartedAt,
      abortedInFlight: activeRequestAborters.size > 0,
    }));
    if (process.env.CODEX_ROUTER_TEST_NO_EXIT === "1") return;
    process.exit(0);
  })();
  return shutdownPromise;
}

function resetLifecycleForTests() {
  setLifecycleState("ready");
  activeRequestAborters.clear();
  shutdownPromise = null;
}

function shuffleGroup(group, random = Math.random) {
  const items = [...group];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  items.sort((a, b) => {
    const failureDifference = (providerFailureStreaks.get(a) ?? 0) - (providerFailureStreaks.get(b) ?? 0);
    return failureDifference || getActiveRequests(a) - getActiveRequests(b);
  });
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
  const streak = (providerFailureStreaks.get(provider) ?? 0) + 1;
  providerFailureStreaks.set(provider, streak);
  const durationMs = Math.min(PROVIDER_COOLDOWN_MAX_MS, PROVIDER_COOLDOWN_MS * (2 ** (streak - 1)));
  providerCooldowns.set(provider, now + durationMs);
  return { provider, streak, durationMs, cooldownUntil: now + durationMs };
}

function clearProviderCooldown(provider) {
  providerCooldowns.delete(provider);
  providerFailureStreaks.delete(provider);
}

function nextProviderRetryMs(providers, now = Date.now()) {
  let earliest = null;
  for (const provider of providers) {
    const cooldownUntil = providerCooldowns.get(provider);
    if (cooldownUntil > now && (earliest === null || cooldownUntil < earliest)) earliest = cooldownUntil;
  }
  return earliest === null ? 0 : earliest - now;
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

function tierCandidates(tier, random = Math.random) {
  if (!tier) return [];
  return providerPriority(tier, random).map((provider) => {
    const providerModels = ROUTING.providers[provider]?.models;
    const model = providerModels?.[tier] || providerModels?.default;
    if (typeof model !== 'string' || !model) return null;
    const route = routeForModel(model);
    return route ? { ...route, model } : null;
  }).filter(Boolean);
}

function roleCandidates(role, random = Math.random) {
  return tierCandidates(ROUTING.roles[role]?.tier, random);
}

// The root orchestrator degrades through the orchestrator tier the same way a
// role does, but it is not a leaf subagent: it keeps the parent reasoning
// effort for its primary provider and applies an explicit per-provider effort
// for each fallback provider so a downgraded run still reasons at the intended
// depth.
function orchestratorCandidates(random = Math.random) {
  return tierCandidates(ORCHESTRATOR_TIER, random).map((candidate) => ({
    ...candidate,
    reasoningEffort: ORCHESTRATOR_REASONING_EFFORT[candidate.provider] ?? null,
  }));
}

function providerModelMetadata(model) {
  const route = routeForModel(model);
  return { id: model, object: "model", owned_by: route?.provider ?? "local-router" };
}

function catalogModelIds(models, roles = [...ROLE_NAMES.map((role) => `autodev/${role}`), ORCHESTRATOR_ALIAS]) {
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

const TOOL_OUTPUT_TYPES = new Set(["function_call", "computer_call", "custom_tool_call", "code_interpreter_call"]);

function countToolCallsInResponse(response, seen = new Set()) {
  if (!response || typeof response !== "object" || !Array.isArray(response.output)) return 0;
  let count = 0;
  for (const item of response.output) {
    if (item && TOOL_OUTPUT_TYPES.has(item.type) && !seen.has(item.id)) {
      if (item.id) seen.add(item.id);
      count += 1;
    }
  }
  return count;
}

function countToolCallsFromSse(body, seen = new Set()) {
  let count = 0;
  for (const line of String(body).split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.output_item.added" && event.item && TOOL_OUTPUT_TYPES.has(event.item.type) && !seen.has(event.item.id)) {
        if (event.item.id) seen.add(event.item.id);
        count += 1;
      } else if (event.type === "response.completed") {
        count += countToolCallsInResponse(event.response, seen);
      }
    } catch {
      // Ignore malformed/non-JSON SSE lines.
    }
  }
  return count;
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

function responseWasNotCompleted(response) {
  return response?.status != null && response.status !== "completed";
}

async function writeResponseStream(response, upstream, publicModel, signal = null) {
  const decoder = new TextDecoder();
  const seenToolCalls = new Set();
  let toolCalls = 0;
  let buffer = "";
  let terminal = null;
  const inspectTerminal = (event) => {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.type === "response.failed") {
          terminal = "failed";
        } else if (parsed.type === "response.completed") {
          terminal = responseWasNotCompleted(parsed.response) || parsed.response?.metadata?.provider_error ? "failed" : "completed";
        }
      } catch {
        // Preserve the existing tolerant behavior for malformed provider lines.
      }
    }
  };
  const flushEvents = (flush = false) => {
    while (true) {
      const boundary = buffer.match(/\r?\n\r?\n/);
      if (!boundary) break;
      const end = boundary.index + boundary[0].length;
      const event = buffer.slice(0, end);
      inspectTerminal(event);
      toolCalls += countToolCallsFromSse(event, seenToolCalls);
      response.write(transformSseEvent(event, publicModel));
      buffer = buffer.slice(end);
    }
    if (flush && buffer) {
      inspectTerminal(buffer);
      toolCalls += countToolCallsFromSse(buffer, seenToolCalls);
      response.write(transformSseEvent(buffer, publicModel));
      buffer = "";
    }
  };
  if (!upstream.body) {
    response.write(responseFailureEvent("Upstream provider returned no response body."));
    return { toolCalls, failed: true };
  }
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      flushEvents();
    }
    buffer += decoder.decode();
    flushEvents(true);
  } catch (error) {
    if (!response.writableEnded) {
      const message = signal?.aborted && signal.reason?.name === "TimeoutError"
        ? `Upstream provider exceeded the ${Math.ceil(UPSTREAM_TIMEOUT_MS / 1000)}s response timeout.`
        : error instanceof Error ? error.message : String(error);
      response.write(responseFailureEvent(message));
      return { toolCalls, failed: true };
    }
    throw error;
  }
  if (terminal === "failed") return { toolCalls, failed: true };
  if (terminal !== "completed") {
    response.write(responseFailureEvent("Upstream provider closed the stream before response.completed."));
    return { toolCalls, failed: true };
  }
  return { toolCalls, failed: false };
}

function responseFailureEvent(message) {
  return `event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed",
    response: {
      id: `router_${Date.now()}`,
      object: "response",
      status: "failed",
      error: { type: "upstream_error", message },
    },
  })}\n\n`;
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
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    connection: "close",
    "x-autodev-router-instance-id": ROUTER_INSTANCE_ID,
    ...extraHeaders,
  });
  response.end(encoded);
}

async function sendDashboard(response) {
  const body = await readFile(DASHBOARD_FILE);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    connection: "close",
    "x-autodev-router-instance-id": ROUTER_INSTANCE_ID,
  });
  response.end(body);
}

function errorBody(message, type = "invalid_request_error", context = {}) {
  const pickString = (value) => typeof value === "string" && value ? value : null;
  const pickBool = (value) => typeof value === "boolean" ? value : null;
  return {
    error: {
      message,
      type,
      code: pickString(context.code) ?? (typeof type === "string" && type ? type : null),
      retryable: pickBool(context.retryable),
      failureClass: pickString(context.failureClass),
      provider: pickString(context.provider),
      model: pickString(context.model),
      requestId: pickString(context.requestId),
      routerInstanceId: ROUTER_INSTANCE_ID,
    },
  };
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

function downstreamHeaders(route, auth, turnMetadataHeader) {
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  if (route.envKey) {
    const key = process.env[route.envKey];
    if (key) headers.authorization = `Bearer ${key}`;
  } else {
    headers.authorization = `Bearer ${auth.token}`;
    headers["chatgpt-account-id"] = auth.accountId;
  }
  // chatgpt.com's Codex backend recycles pooled keep-alive connections out
  // from under an in-flight reuse attempt -- see the transport-retry note
  // near CONCRETE_TRANSPORT_MAX_ATTEMPTS -- which surfaces as ECONNRESET/
  // EPIPE/UND_ERR_SOCKET while writing the *next* request on a now-stale
  // socket. Every codex request therefore opens its own connection instead
  // of drawing from Node's global keep-alive pool, removing the race at its
  // source rather than retrying around it. Other providers run on the local
  // loopback and are unaffected, so they keep reusing pooled connections.
  if (route.provider === "codex") headers.connection = "close";
  // Allowlisted forward: only FORWARDED_REQUEST_HEADERS ever crosses from the
  // inbound client request to the outbound provider request. The provider
  // credential above is always sourced independently, never from the client.
  if (turnMetadataHeader) headers[FORWARDED_REQUEST_HEADERS[0]] = turnMetadataHeader;
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

function upstreamPayload(route, payload, wantsStream, turnMetadataHeader) {
  // `extra_headers` is an SDK escape hatch that LiteLLM consumes as outbound
  // HTTP headers. Never pass the caller's value through the router: doing so
  // would bypass the router's credential and header allowlist. Antigravity is
  // routed through LiteLLM, whose Responses API currently drops arbitrary
  // request fields and can also drop forwarded client headers. Carry the one
  // approved workspace header through its supported `extra_headers` field so
  // the local adapter can resolve the workspace without guessing.
  const { extra_headers: _discardedExtraHeaders, ...safePayload } = payload;
  if (route.provider === "antigravity" && turnMetadataHeader) {
    safePayload.extra_headers = { [FORWARDED_REQUEST_HEADERS[0]]: turnMetadataHeader };
  }
  return route.provider === "codex" ? { ...safePayload, stream: true, store: false } : { ...safePayload, stream: wantsStream };
}

async function fetchUpstream(route, payload, wantsStream, turnMetadataHeader, clientSignal = null) {
  let auth = null;
  if (route.provider === "codex") {
    try {
      auth = await loadCodexAuth();
    } catch (error) {
      // Authentication/configuration failures are deterministic and must not
      // be mistaken for retryable network failures or cool down Codex.
      const authError = new Error("Codex authentication is unavailable.");
      authError.code = "router_auth_unavailable";
      authError.cause = error;
      throw authError;
    }
  }
  const requestPayload = upstreamPayload(route, payload, wantsStream, turnMetadataHeader);
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = clientSignal ? AbortSignal.any([clientSignal, timeoutSignal]) : timeoutSignal;
  const upstream = await fetch(`${route.baseUrl}/responses`, {
    method: "POST",
    headers: downstreamHeaders(route, auth, turnMetadataHeader),
    signal,
    body: JSON.stringify(requestPayload),
  });
  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      body: await upstream.text(),
      // Only transient upstream statuses are eligible for a bounded retry on
      // the direct concrete path; auth/payload errors must not be retried.
      retryable: [502, 503, 504].includes(upstream.status),
    };
  }
  return { ok: true, upstream, signal };
}

async function writeSuccessfulResponse(response, route, result, wantsStream, publicModel, requestId, resolvedModel) {
  const responseHeaders = {
    "x-autodev-provider": route.provider,
    "x-autodev-model": resolvedModel,
    "x-autodev-request-id": requestId,
    "x-autodev-router-instance-id": ROUTER_INSTANCE_ID,
  };
  const upstream = result.upstream;
  if (wantsStream) {
    response.writeHead(upstream.status, { ...responseHeaders, "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache", connection: "close" });
    const streamResult = await writeResponseStream(response, upstream, publicModel, result.signal);
    response.end();
    return streamResult;
  }
  const body = await upstream.text();
  if (route.provider === "codex") {
    const toolCalls = countToolCallsFromSse(body);
    const parsed = replaceModelFields(responseTextFromSse(body), publicModel);
    sendJson(response, upstream.status, parsed, responseHeaders);
    return { toolCalls, failed: responseWasNotCompleted(parsed) };
  }
  try {
    const parsed = JSON.parse(body);
    const toolCalls = countToolCallsInResponse(parsed);
    const rewritten = replaceModelFields(parsed, publicModel);
    sendJson(response, upstream.status, rewritten, responseHeaders);
    return { toolCalls, failed: responseWasNotCompleted(rewritten) };
  } catch {
    response.writeHead(upstream.status, { ...responseHeaders, "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
    return { toolCalls: 0, failed: false };
  }
}

function fallbackable(status, body) {
  if ([401, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 400 && /invalid model|model name.*(invalid|not found)|unknown model/i.test(String(body ?? ""))) return true;
  return /(quota|rate.?limit|weekly.?limit|usage.?limit|usage exhausted|session|high.?demand|credit|timeout|timed.?out|overloaded|temporarily unavailable|unavailable)/i.test(String(body ?? ""));
}

async function providerAvailable(route) {
  if (!routeCredentialAvailable(route)) return false;
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

async function proxyConcreteResponse(response, route, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null) {
  const startedAt = Date.now();
  recordRouterEvent({ phase: "selected", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace });
  incrementActiveRequests(route.provider);
  // Direct concrete requests must not silently reroute to another provider.
  // A single bounded retry is permitted for HTTP 502/503/504 from the
  // upstream provider (real signal from a completed response); pre-response
  // transport failures get one additional attempt since they carry no usable
  // response signal -- see CONCRETE_TRANSPORT_MAX_ATTEMPTS. The request may
  // have reached the provider before the connection failed, so keep this
  // budget deliberately small.
  // Never retries after the response stream has begun or when the client
  // signal is aborted, and never on auth/payload errors.
  let attempts = 0;
  const maxAttempts = Math.max(CONCRETE_STATUS_MAX_ATTEMPTS, CONCRETE_TRANSPORT_MAX_ATTEMPTS);
  const sendFailureResponse = (status, failureClass) => {
    if (response.writableEnded) return;
    if (response.headersSent) { response.end(); return; }
    const errorType = status === 401
      ? "router_authentication_error"
      : status === 502 || status === 503 || status === 504 ? "router_provider_unavailable" : "router_upstream_error";
    const retryable = status === 502 || status === 503 || status === 504;
    const retryAfterMs = retryable ? nextProviderRetryMs([route.provider]) : 0;
    const retryAfterSeconds = retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
    sendJson(
      response,
      status,
      errorBody(
        status === 401
          ? `Direct concrete request to ${payload.model} (${route.provider}) could not authenticate.`
          : `Direct concrete request to ${payload.model} (${route.provider}) failed with HTTP ${status}.`,
        errorType,
        { code: errorType, retryable, failureClass, provider: route.provider, model: payload.model, requestId },
      ),
      {
        "x-autodev-provider": route.provider,
        "x-autodev-model": payload.model,
        "x-autodev-request-id": requestId,
        ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}),
      },
    );
  };
  try {
    while (attempts < maxAttempts) {
      try {
        const result = await fetchUpstream(route, payload, wantsStream, turnMetadataHeader, clientSignal);
        if (!result.ok) {
          const failureClass = classifyProviderFailure(result.status, result.body);
          const canRetry = result.retryable && attempts < CONCRETE_STATUS_MAX_ATTEMPTS - 1 && !clientSignal?.aborted && !response.headersSent;
          if (canRetry) {
            recordRouterEvent({ phase: "retry", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, status: result.status, failureClass, elapsedMs: Date.now() - startedAt });
            attempts += 1;
            await jitteredBackoff();
            if (clientSignal?.aborted) {
              recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 499, failureClass: "client_aborted", elapsedMs: Date.now() - startedAt });
              return;
            }
            continue;
          }
          recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: result.status, failureClass, elapsedMs: Date.now() - startedAt });
          if (result.retryable) cooldownProvider(route.provider, Date.now());
          sendFailureResponse(result.status, failureClass);
          return;
        }
        const responseResult = await writeSuccessfulResponse(response, route, result, wantsStream, payload.model, requestId, payload.model);
        recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: responseResult.failed ? "failure" : "success", status: result.upstream.status, failureClass: responseResult.failed ? "upstream_error" : null, elapsedMs: Date.now() - startedAt, toolCalls: responseResult.toolCalls });
        return;
      } catch (error) {
        logTransportError({ requestId, provider: route.provider, model: payload.model, error, workspace });
        if (error && typeof error === "object" && error.code === "router_auth_unavailable") {
          recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 401, failureClass: "authentication", elapsedMs: Date.now() - startedAt });
          sendFailureResponse(401, "authentication");
          return;
        }
        if (clientSignal?.aborted) {
          recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 499, failureClass: "client_aborted", elapsedMs: Date.now() - startedAt });
          return;
        }
        if (attempts < CONCRETE_TRANSPORT_MAX_ATTEMPTS - 1 && !response.headersSent) {
          const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
          recordRouterEvent({ phase: "retry", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, status: 502, failureClass, elapsedMs: Date.now() - startedAt });
          attempts += 1;
          await jitteredBackoff();
          if (clientSignal?.aborted) {
            recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 499, failureClass: "client_aborted", elapsedMs: Date.now() - startedAt });
            return;
          }
          continue;
        }
        const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
        recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 502, failureClass, elapsedMs: Date.now() - startedAt });
        cooldownProvider(route.provider, Date.now());
        sendFailureResponse(502, failureClass);
        return;
      }
    }
  } catch (error) {
    // Defensive: anything thrown outside the retry loop (e.g. while writing
    // the failure response) still produces a clean 502 with structured
    // diagnostics rather than a half-written body.
    const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
    recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 502, failureClass, elapsedMs: Date.now() - startedAt });
    if (!response.writableEnded) {
      if (response.headersSent) response.end();
      else sendJson(response, 502, errorBody(`Direct concrete request to ${payload.model} (${route.provider}) could not be completed.`, "router_upstream_error", { code: "router_upstream_error", retryable: true, failureClass, provider: route.provider, model: payload.model, requestId }), { "x-autodev-provider": route.provider, "x-autodev-model": payload.model, "x-autodev-request-id": requestId });
    }
  } finally {
    decrementActiveRequests(route.provider);
  }
}

// Applies a resolved fallback candidate to the outbound payload: always swaps
// in the concrete provider model, and overrides the reasoning effort when the
// candidate pins one (orchestrator fallback providers do; role candidates and
// the primary provider do not, so the caller's effort is preserved).
function payloadForCandidate(payload, candidate) {
  const next = { ...payload, model: candidate.model };
  if (candidate.reasoningEffort) {
    const base = payload.reasoning && typeof payload.reasoning === "object" && !Array.isArray(payload.reasoning) ? payload.reasoning : {};
    next.reasoning = { ...base, effort: candidate.reasoningEffort };
  }
  return next;
}

// Shared multi-provider fallback loop for role aliases and the root
// orchestrator alias. `role` is used for event attribution (null for the
// orchestrator); `origin` overrides usage-origin classification so orchestrator
// fallback traffic on a non-Codex provider is still counted as orchestrator
// rather than direct. `subject` is the human-readable label for the exhaustion
// error.
async function proxyFallbackChain(response, { candidates, role = null, origin = null, subject }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null) {
  const failures = [];
  for (const route of candidates) {
    if (isProviderCoolingDown(route.provider)) {
      failures.push(`${route.provider}: cooldown active`);
      recordRouterEvent({ phase: "skipped", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, failureClass: providerState(route.provider).lastFailureClass ?? "cooldown" });
      continue;
    }
    if (!(await providerAvailable(route))) {
      failures.push(`${route.provider}: unavailable`);
      cooldownProvider(route.provider);
      recordRouterEvent({ phase: "skipped", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, failureClass: "unavailable" });
      continue;
    }
    const attemptStartedAt = Date.now();
    recordRouterEvent({ phase: "selected", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace });
    incrementActiveRequests(route.provider);
    try {
      const result = await fetchUpstream(route, payloadForCandidate(payload, route), wantsStream, turnMetadataHeader, clientSignal);
      if (result.ok) {
        try {
          const responseResult = await writeSuccessfulResponse(response, route, result, wantsStream, payload.model, requestId, route.model);
          if (responseResult.failed) {
            cooldownProvider(route.provider);
            recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "failure", status: result.upstream.status, failureClass: "upstream_error", elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls });
            return;
          }
          clearProviderCooldown(route.provider);
          recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "success", status: result.upstream.status, elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls });
        } catch (streamError) {
          cooldownProvider(route.provider);
          throw streamError;
        }
        return;
      }
      const failureClass = classifyProviderFailure(result.status, result.body);
      failures.push(`${route.provider}: HTTP ${result.status}`);
      recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "failure", status: result.status, failureClass, elapsedMs: Date.now() - attemptStartedAt });
      if (!fallbackable(result.status, result.body)) {
        response.writeHead(result.status, { "content-type": "application/json", "x-autodev-provider": route.provider, "x-autodev-model": route.model, "x-autodev-request-id": requestId, "x-autodev-router-instance-id": ROUTER_INSTANCE_ID });
        response.end(result.body);
        return;
      }
      cooldownProvider(route.provider);
    } catch (error) {
      const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
      logTransportError({ requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model, error, workspace });
      // Keep provider-specific exception text private; the structured event
      // carries the safe failure class and the response needs only a stable
      // provider summary for fallback diagnostics.
      failures.push(`${route.provider}: ${failureClass}`);
      recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "failure", status: 502, failureClass, elapsedMs: Date.now() - attemptStartedAt });
      cooldownProvider(route.provider);
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
    } finally {
      decrementActiveRequests(route.provider);
    }
  }
  recordSpawnFailure({ requestId, role, requestedModel: payload.model, reason: "provider_exhausted" });
  const retryAfterMs = nextProviderRetryMs(candidates.map(({ provider }) => provider));
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const retryMessage = retryAfterMs > 0 ? ` Retry after approximately ${retryAfterSeconds}s.` : "";
  sendJson(
    response,
    503,
    errorBody(`No available provider completed ${subject}.${retryMessage} ${failures.join("; ")}`, "router_provider_exhausted", {
      code: "router_provider_exhausted",
      retryable: true,
      failureClass: "unavailable",
      model: payload.model,
      requestId,
    }),
    { "x-autodev-request-id": requestId, "retry-after": String(retryAfterSeconds) },
  );
}

async function proxyRoleResponse(response, role, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null) {
  return proxyFallbackChain(response, { candidates: roleCandidates(role), role, subject: `role ${role}` }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal);
}

async function proxyOrchestratorResponse(response, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null) {
  return proxyFallbackChain(response, { candidates: orchestratorCandidates(), role: null, origin: "orchestrator", subject: "the orchestrator" }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal);
}

function requestSession(request, payload, turnMetadataHeader = null) {
  const header = request.headers["x-codex-session-id"] ?? request.headers["x-session-id"] ?? request.headers["x-conversation-id"];
  const metadata = payload?.metadata;
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  const value = header
    ?? payload?.session_id
    ?? payload?.conversation_id
    ?? metadata?.session_id
    ?? metadata?.conversation_id
    ?? turnMetadata?.session_id
    ?? turnMetadata?.conversation_id;
  if (typeof value === "string" && value.trim()) return { key: value.trim(), scope: "identified" };
  return { key: PROCESS_FALLBACK_SESSION_KEY, scope: "process-fallback" };
}

// The only request header the router ever re-emits toward a provider bridge.
// Provider bridges resolve their own workspace `cwd` from this JSON turn
// metadata; the router itself never inspects `workspaces`, it only validates
// and relays. Everything else about the inbound request (in particular any
// client-supplied Authorization) is never forwarded: downstreamHeaders()
// always sets the outbound provider credential independently.
const FORWARDED_REQUEST_HEADERS = Object.freeze(["x-codex-turn-metadata"]);

function parseTurnMetadataJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Canonical Codex transport carries turn metadata (including the caller's
// `workspaces` map) as the `x-codex-turn-metadata` request header. Callers
// that cannot set custom headers may instead embed the same JSON under
// `client_metadata["x-codex-turn-metadata"]` in the body; that is normalized
// back into the canonical header shape so provider bridges only ever have to
// parse one form.
function resolveTurnMetadataHeader(request, payload) {
  const rawHeader = request.headers["x-codex-turn-metadata"];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (parseTurnMetadataJson(headerValue)) return headerValue;
  const clientMetadata = payload?.client_metadata;
  const embedded = clientMetadata && typeof clientMetadata === "object" ? clientMetadata["x-codex-turn-metadata"] : undefined;
  if (typeof embedded === "string" && parseTurnMetadataJson(embedded)) return embedded;
  if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) return JSON.stringify(embedded);
  return null;
}

const WORKSPACE_KEYS = ["cwd", "project_root", "working_directory"];

function workspacePathLabel(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const label = basename(value.trim());
  return label && label !== "." && label !== "/" ? label : null;
}

function repositoryIdentity(remote) {
  if (typeof remote !== "string" || !remote.trim()) return null;
  const normalized = remote.trim().replace(/^git@([^:]+):/, "https://$1/");
  let pathname;
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split(/[?#]/, 1)[0];
  }
  const parts = pathname.split("/").filter(Boolean).map((part) => part.replace(/\.git$/i, ""));
  if (parts.length < 2) return null;
  const owner = parts.at(-2).replace(/[^A-Za-z0-9._-]/g, "");
  const repo = parts.at(-1).replace(/[^A-Za-z0-9._-]/g, "");
  return owner && repo ? `${owner}/${repo}` : null;
}

function workspaceContextFromRequest(request, payload, turnMetadataHeader) {
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  const workspaces = turnMetadata?.workspaces && typeof turnMetadata.workspaces === "object" && !Array.isArray(turnMetadata.workspaces)
    ? turnMetadata.workspaces
    : {};
  const explicitPaths = [
    ...WORKSPACE_KEYS.map((key) => payload?.[key]),
    ...(payload?.metadata && typeof payload.metadata === "object" ? WORKSPACE_KEYS.map((key) => payload.metadata[key]) : []),
  ];
  const path = explicitPaths.find((value) => typeof value === "string" && value.trim())
    ?? Object.keys(workspaces).find((value) => typeof value === "string" && value.trim())
    ?? null;
  const matchingEntry = path && workspaces[path] ? workspaces[path] : Object.values(workspaces)[0];
  const remotes = matchingEntry?.associated_remote_urls;
  const repository = remotes && typeof remotes === "object"
    ? Object.values(remotes).map(repositoryIdentity).find(Boolean) ?? null
    : null;
  return {
    key: repository ?? workspacePathLabel(path) ?? "unknown",
    cwd: workspacePathLabel(path),
  };
}

async function handleRequest(request, response) {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  // Liveness is unconditional: a draining process is still alive and must
  // continue responding to liveness probes until the OS reaps it.
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", router: "codex-model-router" });
    return;
  }
  // Readiness reports router lifecycle readiness (not provider health). It
  // returns 503 once SIGINT/SIGTERM has put the process into drain mode so
  // orchestrators can stop routing new requests to it.
  if (pathname === "/health/readiness") {
    if (isDraining()) {
      sendJson(response, 503, errorBody("Router is draining for shutdown.", "router_draining", { code: "router_draining", retryable: true }));
      return;
    }
    sendJson(response, 200, { status: "ready", router: "codex-model-router", lifecycle: getLifecycleStatus() });
    return;
  }
  if (pathname === "/dashboard" && request.method === "GET") {
    await sendDashboard(response);
    return;
  }
  if (pathname === "/status" && request.method === "GET") {
    sendJson(response, 200, getRouterStatus(), { "cache-control": "no-store" });
    return;
  }
  if (pathname === "/v1/models" && request.method === "GET") {
    sendJson(response, 200, await loadCatalog());
    return;
  }
  const otelSignals = { "/v1/logs": "logs", "/v1/traces": "traces", "/v1/metrics": "metrics" };
  if (request.method === "POST" && otelSignals[pathname]) {
    try {
      const payload = JSON.parse(await requestBody(request));
      ingestOtelSignal(otelSignals[pathname], payload);
      sendJson(response, 200, {});
    } catch {
      otelTelemetry.receiver.invalid += 1;
      sendJson(response, 400, errorBody("OTLP request must be valid JSON"));
    }
    return;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, errorBody("not found"));
    return;
  }
  if (isDraining()) {
    sendJson(response, 503, errorBody("Router is draining for shutdown; please retry against another instance.", "router_draining", { code: "router_draining", retryable: true }), { "retry-after": "5" });
    return;
  }
  let payload;
  try { payload = JSON.parse(await requestBody(request)); } catch { sendJson(response, 400, errorBody("request body must be valid JSON")); return; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    sendJson(response, 400, errorBody("request body must be a JSON object"));
    return;
  }
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!model) {
    sendJson(response, 400, errorBody("request body requires a non-empty string model"));
    return;
  }
  payload = { ...payload, model };
  const role = roleForModel(model);
  const requestId = String(request.headers["x-request-id"] ?? randomUUID());
  const wantsStream = payload.stream !== false;
  const turnMetadataHeader = resolveTurnMetadataHeader(request, payload);
  const workspace = workspaceContextFromRequest(request, payload, turnMetadataHeader);
  const clientAbort = new AbortController();
  const abortForRequest = () => clientAbort.abort();
  const abortForRequestClose = () => { if (!request.complete) clientAbort.abort(); };
  const abortForResponseClose = () => { if (!response.writableEnded && !response.destroyed) clientAbort.abort(); };
  // Register this request's aborter so a shutdown signal can cancel any
  // in-flight upstream call when the drain timeout elapses.
  registerActiveRequest(clientAbort);
  request.once("aborted", abortForRequest);
  request.once("close", abortForRequestClose);
  response.once("close", abortForResponseClose);
  try {
    if (model === ORCHESTRATOR_ALIAS) {
      // The root orchestrator is not a leaf subagent: it does not consume a
      // per-session subagent slot. It degrades through the orchestrator tier
      // (primary provider pinned, remaining providers load-balanced) when its
      // primary provider is out of usage or otherwise unavailable.
      await proxyOrchestratorResponse(response, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientAbort.signal);
      return;
    }
    if (role) {
      const session = requestSession(request, payload, turnMetadataHeader);
      const denialReason = tryAcquireSubagentSlot(session.key);
      if (denialReason) {
        recordConcurrencyDenial({ requestId, role, requestedModel: payload.model, sessionScope: session.scope, reason: denialReason });
        sendJson(response, 429, errorBody(`Subagent denied by configured ${denialReason} limit.`, "router_concurrency_limit", {
          code: "router_concurrency_limit",
          retryable: true,
          failureClass: "concurrency_limit",
          model: payload.model,
          requestId,
        }), { "retry-after": "1", "x-autodev-request-id": requestId });
        return;
      }
      try {
        await proxyRoleResponse(response, role, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientAbort.signal);
      } finally {
        releaseSubagentSlot(session.key);
      }
      return;
    }
    const route = routeForModel(payload.model);
    if (!route) {
      sendJson(response, 400, errorBody(`No local route is configured for model ${String(payload.model)}`));
      return;
    }
    await proxyConcreteResponse(response, route, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientAbort.signal);
  } finally {
    unregisterActiveRequest(clientAbort);
    request.removeListener("aborted", abortForRequest);
    request.removeListener("close", abortForRequestClose);
    response.removeListener("close", abortForResponseClose);
  }
}

async function handle(request, response) {
  try {
    return await handleRequest(request, response);
  } catch (error) {
    // Keep internal messages and stacks out of both client responses and the
    // router log. The request ID and sanitized transport fields are enough to
    // correlate the failure without leaking credentials, paths, or payloads.
    const info = transportErrorInfo(error);
    console.error(JSON.stringify({
      schema: "autodev-router-event-v1",
      timestamp: new Date().toISOString(),
      routerInstanceId: ROUTER_INSTANCE_ID,
      requestId: null,
      phase: "router_error",
      errorName: info.name,
      errorCode: info.code,
      syscall: info.syscall,
    }));
    if (response.writableEnded || response.destroyed) return;
    try {
      if (response.headersSent) response.end();
      else sendJson(response, 502, errorBody("The router could not complete the request.", "router_internal_error", { code: "router_internal_error", retryable: true }));
    } catch {
      // The client may have disconnected between the state check and the write.
    }
  }
}

export {
  activeProviderRequests,
  beginShutdown,
  catalogModelIds,
  proxyConcreteResponse,
  proxyOrchestratorResponse,
  orchestratorCandidates,
  ORCHESTRATOR_ALIAS,
  payloadForCandidate,
  classifyProviderFailure,
  clearProviderCooldown,
  codexTelemetryStatus,
  cooldownProvider,
  countToolCallsFromSse,
  countToolCallsInResponse,
  concurrencyStatus,
  decrementActiveRequests,
  downstreamHeaders,
  fallbackable,
  FORWARDED_REQUEST_HEADERS,
  getActiveRequests,
  getLifecycleStatus,
  getRouterStatus,
  handle,
  incrementActiveRequests,
  ingestOtelLogs,
  ingestOtelMetrics,
  ingestOtelSignal,
  ingestOtelTraces,
  isDraining,
  isProviderCoolingDown,
  loadRouterState,
  nextProviderRetryMs,
  normalizeCodexTask,
  parseConcurrencyConfig,
  parseTurnMetadataJson,
  persistRouterStateNow,
  PROCESS_FALLBACK_SESSION_KEY,
  providerModelMetadata,
  recordConcurrencyDenial,
  recordRouterEvent,
  recordSpawnFailure,
  releaseSubagentSlot,
  replaceModelFields,
  requestSession,
  resetConcurrencyTelemetry,
  resetLifecycleForTests,
  resetOtelTelemetry,
  resetRouterTelemetry,
  resolveTurnMetadataHeader,
  ROUTER_INSTANCE_ID,
  spawnFailureStatus,
  routeCredentialAvailable,
  roleCandidates,
  roleForModel,
  routeForModel,
  serializeRouterState,
  summarizeCodexTasks,
  tryAcquireSubagentSlot,
  responseTextFromSse,
  transformSseEvent,
  validateRoutingConfig,
  workspaceContextFromRequest,
};

if (IS_MAIN) {
  const server = createServer((request, response) => { void handle(request, response); });
  const sigtermHandler = (signal) => { void beginShutdown(signal, server); };
  process.on("SIGINT", () => sigtermHandler("SIGINT"));
  process.on("SIGTERM", () => sigtermHandler("SIGTERM"));
  server.listen(PORT, HOST, () => {
    console.error(`Codex model router listening at http://${HOST}:${PORT}`);
  });
}
