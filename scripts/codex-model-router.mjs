#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// The bridges resolve a turn's workspace with this module; the router labels
// the same turn for telemetry. Sharing the primitives is what keeps the label
// and the directory the agent actually runs in from drifting apart -- they
// were separate implementations, and they disagreed.
import { WORKSPACE_KEYS, isDirectory } from "./codex/lib/resolve-workspace.mjs";
import { INCOMPLETE_REASON_INTERRUPTED, INCOMPLETE_REASON_TIMEOUT, isHardLimitClass, LIMIT_HEADER_CLASS, LIMIT_HEADER_RESETS_AT, LIMIT_SOURCE_REPORTED, normalizeResetsAt, readLimitHeaders, terminalIncompleteEvents } from "./codex/lib/provider-limits.mjs";

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
  { provider: "antigravity", pattern: /^gemini-[A-Za-z0-9][A-Za-z0-9.-]*$/, baseUrl: "http://127.0.0.1:4002/v1", healthUrl: "http://127.0.0.1:4002/health/liveliness", envKey: "LITELLM_API_KEY" },
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
    if (!info.capabilities || typeof info.capabilities !== 'object' || typeof info.capabilities.subagentSpawn !== 'boolean') {
      throw new Error(`Routing config provider ${provider} must declare capabilities.subagentSpawn as a boolean.`);
    }
    // A CLI-delegation bridge spawns inside its own runtime, so the router can
    // only attribute those spawns if it knows which tool names to watch for.
    // The list lives here rather than in each bridge so one config edit keeps
    // the routing decision and the telemetry attribution in agreement.
    const spawnTools = info.capabilities.subagentSpawnTools;
    if (spawnTools !== undefined) {
      if (!Array.isArray(spawnTools) || spawnTools.length === 0 || spawnTools.some((tool) => typeof tool !== 'string' || !tool.trim())) {
        throw new Error(`Routing config provider ${provider} must declare capabilities.subagentSpawnTools as a non-empty array of tool names.`);
      }
      if (info.capabilities.subagentSpawn !== true) {
        throw new Error(`Routing config provider ${provider} declares capabilities.subagentSpawnTools but is not spawn-capable.`);
      }
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
  // The orchestrator's entire job is delegating, so every provider it can
  // degrade onto must have a delegation path. There are two, and both count:
  // Codex and MiniMax drive Codex's own `multi_agent_v1` spawn tool, which
  // reaches the router back as an `autodev/<role>` request; the Claude and
  // Antigravity bridges delegate inside their own CLI runtime (Claude's `Agent`
  // tool, Antigravity's `invoke_subagent`) and report those
  // spawns over /v1/agent-events. A provider with neither path silently turns
  // the root agent into a single-threaded chat model, so serving the
  // orchestrator from one fails closed at config load.
  for (const group of config.providerGroups[orchestrator.tier]) {
    for (const provider of group) {
      if (config.providers[provider].capabilities.subagentSpawn !== true) {
        throw new Error(
          `Routing config orchestrator tier ${orchestrator.tier} includes provider ${provider}, `
          + `which declares capabilities.subagentSpawn: false. Only spawn-capable providers may serve the `
          + `orchestrator; remove ${provider} from providerGroups.${orchestrator.tier} or make it spawn-capable.`,
        );
      }
    }
  }
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
// A provider that has told us it is out of usage until a stated time is not the
// same thing as one that blipped a 503, and backing both off on one 30s-doubling
// ladder meant a weekly quota was re-probed every ten minutes forever while a
// local bridge that flapped for a minute was taken out for the same ten. These
// are the three other cooldown shapes; `cooldownProvider` picks between them.
const HARD_COOLDOWN_MS = positiveDuration(process.env.CODEX_ROUTER_HARD_COOLDOWN_MS, 900_000);
const HARD_COOLDOWN_MAX_MS = Math.max(HARD_COOLDOWN_MS, positiveDuration(process.env.CODEX_ROUTER_HARD_COOLDOWN_MAX_MS, 21_600_000));
const PROBE_COOLDOWN_MS = positiveDuration(process.env.CODEX_ROUTER_PROBE_COOLDOWN_MS, 5_000);
const PROBE_COOLDOWN_MAX_MS = Math.max(PROBE_COOLDOWN_MS, positiveDuration(process.env.CODEX_ROUTER_PROBE_COOLDOWN_MAX_MS, 30_000));
const PROBE_TIMEOUT_MS = positiveDuration(process.env.CODEX_ROUTER_PROBE_TIMEOUT_MS, 700);
// A cooldown is load-shedding advice, not evidence a provider is dead. When
// every candidate is cooling the router would rather attempt a few of them than
// strand the caller, so it makes a bounded last-resort pass and, if a cooldown
// is about to lapse anyway, waits for it. Both budgets are small: a role request
// holds a subagent slot for the whole time, and the wait happens before response
// headers, so the client sees a slow request rather than an idle stream.
const LAST_RESORT_MAX_ATTEMPTS = positiveDuration(process.env.CODEX_ROUTER_LAST_RESORT_MAX_ATTEMPTS, 2);
const EXHAUSTION_WAIT_MS = Number.parseInt(process.env.CODEX_ROUTER_EXHAUSTION_WAIT_MS ?? "", 10) >= 0
  ? Number.parseInt(process.env.CODEX_ROUTER_EXHAUSTION_WAIT_MS, 10)
  : 20_000;
// Bounds how long the router may spend *looking* for a provider. Checked only
// before starting a candidate, never during one, so a legitimately long turn
// that lands on the last candidate still gets the full upstream timeout.
const CHAIN_SELECTION_DEADLINE_MS = positiveDuration(process.env.CODEX_ROUTER_CHAIN_SELECTION_DEADLINE_MS, 120_000);
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
// provider -> { until, kind, failureClass, resetsAt, since }. `kind` is what
// decides whether a cooling provider may still be attempted as a last resort.
const providerCooldowns = new Map();
const providerFailureStreaks = new Map();
// Probe failures ride their own ladder: a local bridge restarting must not
// escalate the backoff that describes the real provider's health.
const providerProbeStreaks = new Map();
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

function providerCapabilities(provider) {
  const capabilities = ROUTING.providers[provider]?.capabilities ?? {};
  const spawnTools = Array.isArray(capabilities.subagentSpawnTools) ? [...capabilities.subagentSpawnTools] : [];
  return { subagentSpawn: capabilities.subagentSpawn === true, subagentSpawnTools: spawnTools };
}

// Tool names whose invocation inside a provider bridge means "a subagent was
// spawned". Sent to the bridge as a request header so a bridge never has to
// know which provider it is or parse the routing config: it matches the tool
// names its CLI reports against the list the router handed it.
function subagentSpawnToolsFor(provider) {
  return providerCapabilities(provider).subagentSpawnTools;
}

// Subagent spawn telemetry, unified across every provider.
//
// Subagents reach existence by two different mechanisms and, before this, the
// router could only see one of them:
//
// - `router_alias`: Codex's native `multi_agent_v1` spawn tool (driven by the
//   Codex provider itself, or by MiniMax through the namespace-flattening
//   proxy) creates a child thread that asks this router for an
//   `autodev/<role>` alias. The router observes that request directly.
// - `bridge_native`: the Claude and Antigravity bridges delegate inside their
//   own CLI runtime -- Claude's `Agent` tool, Antigravity's
//   `invoke_subagent` -- and no router request is ever made
//   for the child. Those bridges report the spawn to /v1/agent-events instead.
//
// Counting only `router_alias` made a Claude- or Antigravity-served
// orchestrator look like it had never delegated at all, which is precisely the
// signal an operator uses to decide whether a provider is orchestrating.
const SUBAGENT_MECHANISMS = Object.freeze(["router_alias", "bridge_native"]);
const MAX_RECENT_SUBAGENT_SPAWNS = 50;
const subagentTelemetry = {
  total: 0,
  byMechanism: Object.fromEntries(SUBAGENT_MECHANISMS.map((mechanism) => [mechanism, 0])),
  byProvider: {},
  byRole: {},
  byStatus: {},
  recent: [],
};

// Which provider served the orchestrator turn for a session, so a later
// `autodev/<role>` request from that same session can be attributed to the
// parent that spawned it. Without this join every router-routed subagent is
// unattributed, because the child thread's request carries no trace of which
// provider ran the parent turn. Bounded so a long-lived router cannot grow it
// without limit.
const MAX_TRACKED_ORCHESTRATOR_SESSIONS = 256;
const orchestratorProviderBySession = new Map();

// Recorded when the attempt is dispatched, not when it succeeds: a parent
// spawns children mid-turn and waits for them, so the child's request arrives
// while the parent's response is still open. A chain that ends up failing over
// therefore leaves the last provider attempted, which the next attempt
// overwrites. Sessions the caller did not identify are excluded: they all
// share one fallback key (see requestSession), so joining on it would
// attribute an unrelated caller's subagent to whichever provider last ran an
// unidentified orchestrator turn.
function noteOrchestratorSession(sessionKey, provider) {
  if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY || !provider) return;
  orchestratorProviderBySession.delete(sessionKey);
  orchestratorProviderBySession.set(sessionKey, provider);
  while (orchestratorProviderBySession.size > MAX_TRACKED_ORCHESTRATOR_SESSIONS) {
    orchestratorProviderBySession.delete(orchestratorProviderBySession.keys().next().value);
  }
}

function orchestratorProviderForSession(sessionKey) {
  if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY) return null;
  return orchestratorProviderBySession.get(sessionKey) ?? null;
}

// Recent router requests, so an out-of-band bridge report naming a request id
// can be attributed to the provider, model, and workspace that request ran on.
// A bridge posts after its CLI has already invoked the spawn tool, which can
// land just after the response completed, so entries are retained for a while
// rather than deleted the moment the request finishes. The request id is a
// router-generated UUID the bridge only learns by serving the request, so
// matching against this map is also what authorizes the report.
const MAX_TRACKED_BRIDGE_REQUESTS = 256;
const bridgeRequestContext = new Map();

function noteBridgeRequest(requestId, context) {
  if (!requestId) return;
  bridgeRequestContext.delete(requestId);
  bridgeRequestContext.set(requestId, context);
  while (bridgeRequestContext.size > MAX_TRACKED_BRIDGE_REQUESTS) {
    bridgeRequestContext.delete(bridgeRequestContext.keys().next().value);
  }
}

// Usage accounting for `bridge_native` children.
//
// A CLI-delegated child never reaches the router as a request, so it used to
// exist only as a spawn count: the provider that actually did the work showed
// one turn in **Provider health and usage** no matter how wide it fanned out,
// and **Usage by orchestrator and subagents** showed no subagent row at all.
// The bridge's report is the only evidence those turns happened, so it is what
// opens and closes a usage bucket for each child here.
//
// These are deliberately *not* routed through recordRouterEvent: provider
// health, cooldown, and the fallback chain describe routing decisions this
// router made, and a child it never routed must not move them. Only the usage
// buckets -- which measure work done behind the router, not routing -- count
// them, tagged with the `subagent` origin.
const MAX_TRACKED_BRIDGE_SUBAGENTS = 512;
const bridgeSubagentUsage = new Map();

// A roleless CLI child cannot share the `unattributed` role bucket: that key is
// the roleless *orchestrator* traffic the dashboard renders as the Orchestrator
// row, and folding children into it would credit a delegation to its parent.
const UNATTRIBUTED_SUBAGENT_ROLE = "unattributed-subagent";

// A child model that names the parent's choice rather than one of its own.
const INHERITED_CHILD_MODELS = new Set(["inherit", "self", "default", "parent"]);

function bridgeSubagentKey(requestId, childId) {
  return `${requestId}\u0000${childId}`;
}

function openBridgeSubagentUsage({ requestId, context, role, childId, model }) {
  const key = bridgeSubagentKey(requestId, childId);
  // Both name the bucket, so neither can be missing; the spawn itself is
  // already counted whether or not a turn can be measured for it.
  if (!context.provider || !context.model || bridgeSubagentUsage.has(key)) return;
  // A bridge posts its report without awaiting it, so one can arrive after the
  // parent turn already ended. Such a child is still real work: open it and
  // settle it at once against the parent turn it ran inside.
  const settled = context.finished ?? null;
  // `inherit`/`self` is agy naming the parent's model rather than choosing one,
  // and a child with no model named ran on whatever the parent was routed to.
  const childModel = model && !INHERITED_CHILD_MODELS.has(model.toLowerCase()) ? model : context.model;
  const entry = {
    requestId,
    provider: context.provider,
    model: childModel,
    role: role ?? UNATTRIBUTED_SUBAGENT_ROLE,
    workspace: context.workspace ?? null,
    startedAt: Date.now(),
  };
  bridgeSubagentUsage.set(key, entry);
  recordUsageEvent({
    phase: "selected",
    requestId: key,
    role: entry.role,
    provider: entry.provider,
    model: entry.model,
    workspace: entry.workspace,
    origin: "subagent",
    timestamp: new Date().toISOString(),
  });
  if (settled) {
    closeBridgeSubagentUsage(key, { outcome: settled.outcome, failureClass: settled.outcome === "success" ? null : "parent_turn_failed", elapsedMs: settled.elapsedMs });
    return;
  }
  // A bridge that never closes its children must not grow this map without
  // bound; the oldest is closed out as a failure rather than dropped, which
  // would leave its `active` count raised forever.
  while (bridgeSubagentUsage.size > MAX_TRACKED_BRIDGE_SUBAGENTS) {
    closeBridgeSubagentUsage(bridgeSubagentUsage.keys().next().value, { outcome: "failure", failureClass: "subagent_result_missing" });
  }
}

function closeBridgeSubagentUsage(key, { outcome = "success", failureClass = null, elapsedMs = null, toolCalls = 0 } = {}) {
  const entry = bridgeSubagentUsage.get(key);
  if (!entry) return false;
  bridgeSubagentUsage.delete(key);
  recordUsageEvent({
    phase: "result",
    requestId: key,
    role: entry.role,
    provider: entry.provider,
    model: entry.model,
    workspace: entry.workspace,
    origin: "subagent",
    outcome,
    failureClass,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : Date.now() - entry.startedAt,
    toolCalls,
    timestamp: new Date().toISOString(),
  });
  return true;
}

// A CLI child cannot outlive the parent turn that spawned it, so the parent's
// result is the deadline for every child still open under it. This is what
// makes the bridge's `subagent_result` report an accuracy improvement rather
// than a requirement: without one the child is still counted, measured against
// the parent turn instead of its own.
function closeBridgeSubagentsForRequest(requestId, outcome, elapsedMs = null) {
  if (!requestId) return 0;
  const settled = { outcome: outcome === "success" ? "success" : "failure", elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : null };
  const context = bridgeRequestContext.get(requestId);
  // Remembered so a report that arrives after this point can still be settled;
  // a fallback chain re-registers the context per candidate, which clears it.
  if (context) context.finished = settled;
  let closed = 0;
  for (const [key, entry] of [...bridgeSubagentUsage]) {
    if (entry.requestId !== requestId) continue;
    closeBridgeSubagentUsage(key, { outcome: settled.outcome, failureClass: settled.outcome === "success" ? null : "parent_turn_failed" });
    closed += 1;
  }
  return closed;
}

function bumpCount(collection, key, amount) {
  collection[key] = (collection[key] ?? 0) + amount;
}

function recordSubagentSpawn({ mechanism, provider = null, role = null, status = "started", tool = null, requestId = null, workspace = null, count = 1 }) {
  if (!SUBAGENT_MECHANISMS.includes(mechanism) || !Number.isInteger(count) || count < 1) return null;
  const entry = {
    timestamp: new Date().toISOString(),
    mechanism,
    provider: provider ?? "unattributed",
    role: role ?? "unattributed",
    status,
    tool,
    requestId,
    workspace: workspace ?? null,
    count,
  };
  subagentTelemetry.total += count;
  bumpCount(subagentTelemetry.byMechanism, mechanism, count);
  bumpCount(subagentTelemetry.byProvider, entry.provider, count);
  bumpCount(subagentTelemetry.byRole, entry.role, count);
  bumpCount(subagentTelemetry.byStatus, entry.status, count);
  subagentTelemetry.recent.push(entry);
  while (subagentTelemetry.recent.length > MAX_RECENT_SUBAGENT_SPAWNS) subagentTelemetry.recent.shift();
  recordRouterEvent({
    phase: "subagent_spawn",
    requestId,
    role,
    requestedModel: null,
    provider: entry.provider === "unattributed" ? null : entry.provider,
    model: null,
    workspace,
    outcome: status,
  });
  scheduleRouterStatePersist();
  return entry;
}

function resetSubagentTelemetry() {
  subagentTelemetry.total = 0;
  subagentTelemetry.byMechanism = Object.fromEntries(SUBAGENT_MECHANISMS.map((mechanism) => [mechanism, 0]));
  subagentTelemetry.byProvider = {};
  subagentTelemetry.byRole = {};
  subagentTelemetry.byStatus = {};
  subagentTelemetry.recent = [];
  orchestratorProviderBySession.clear();
  bridgeRequestContext.clear();
  bridgeSubagentUsage.clear();
}

function subagentStatus() {
  return {
    total: subagentTelemetry.total,
    byMechanism: { ...subagentTelemetry.byMechanism },
    byProvider: { ...subagentTelemetry.byProvider },
    byRole: { ...subagentTelemetry.byRole },
    byStatus: { ...subagentTelemetry.byStatus },
    // Codex's own OTLP spawn counter, kept beside the router's count rather
    // than merged into it: it covers only Codex-exported threads, so adding
    // the two would double-count every `router_alias` spawn.
    codexNativeSpawns: otelTelemetry.threads.spawns.total,
    spawnCapableProviders: Object.keys(ROUTING.providers).filter((provider) => providerCapabilities(provider).subagentSpawn),
    recent: [...subagentTelemetry.recent].reverse(),
  };
}

// Ingests a provider bridge's report that its CLI invoked a subagent spawn
// tool. Only reports naming a request id this router actually issued are
// counted; anything else is a caller that never served a router request.
const INGESTED_AGENT_EVENTS = new Set(["subagent_spawn", "subagent_result", "subagent_tools_unavailable"]);

let anonymousChildSequence = 0;

// The children one report names, as `{ id, model }`. A bridge that assigns its
// own ids gets them back on the matching `subagent_result`; one that names no
// children at all still gets `count` distinct buckets rather than a single
// shared one, so a fan-out is never collapsed into one turn.
function reportedChildren(event) {
  const listed = (Array.isArray(event.children) ? event.children : []).filter((child) => child && typeof child === "object");
  const children = listed.map((child) => ({
    id: typeof child.id === "string" && child.id.trim() ? safeMetricLabel(child.id) : null,
    model: typeof child.model === "string" && child.model.trim() ? safeMetricLabel(child.model) : null,
  }));
  // `count` is the older, id-less form of the same statement, so a report that
  // names fewer children than it counts is padded rather than truncated: the
  // unnamed ones are real subagents that simply cannot be closed individually.
  const count = Number.isInteger(event.count) && event.count > 0 ? event.count : 1;
  while (children.length < count) children.push({ id: null, model: null });
  return children.map((child) => child.id ? child : { ...child, id: `anon${(anonymousChildSequence += 1)}` });
}

function ingestAgentEvents(payload) {
  const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
  const context = requestId ? bridgeRequestContext.get(requestId) : undefined;
  if (!context) return { accepted: 0, closed: 0, unavailable: 0, rejected: Array.isArray(payload?.events) ? payload.events.length : 0, reason: "unknown_request_id" };
  const events = Array.isArray(payload.events) ? payload.events : [];
  // `accepted` and `closed` count subagents; `rejected` counts events the
  // router did not recognize. They measure different things -- one batch event
  // is worth up to sixteen children -- so they are not each other's complement.
  let accepted = 0;
  let closed = 0;
  let unavailable = 0;
  let rejected = 0;
  for (const event of events) {
    if (!event || typeof event !== "object" || !INGESTED_AGENT_EVENTS.has(event.type)) {
      rejected += 1;
      continue;
    }
    if (event.type === "subagent_tools_unavailable") {
      // Not a spawn that failed to start, but a spawn that could never have
      // been attempted. It belongs with the other spawn failures so an
      // orchestrator that delegated nothing is distinguishable from one that
      // was never given the means to.
      recordSpawnFailure({ requestId, role: null, requestedModel: context.model ?? null, reason: "spawn_tool_unavailable" });
      unavailable += 1;
      continue;
    }
    const role = typeof event.role === "string" && event.role.trim() ? safeMetricLabel(event.role) : null;
    const children = reportedChildren(event);
    const count = children.length;
    if (event.type === "subagent_result") {
      // A close is not a new subagent: it only settles buckets an earlier
      // spawn opened, so it adds nothing to the spawn counts.
      const outcome = event.outcome === "failure" ? "failure" : "success";
      const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : null;
      for (const child of children) {
        if (closeBridgeSubagentUsage(bridgeSubagentKey(requestId, child.id), { outcome, elapsedMs: durationMs, failureClass: outcome === "failure" ? "subagent_failed" : null })) closed += 1;
      }
      continue;
    }
    recordSubagentSpawn({
      mechanism: "bridge_native",
      provider: context.provider,
      role,
      status: typeof event.status === "string" && event.status.trim() ? safeMetricLabel(event.status) : "started",
      tool: typeof event.tool === "string" && event.tool.trim() ? safeMetricLabel(event.tool) : null,
      requestId,
      workspace: context.workspace ?? null,
      count,
    });
    // Each child also becomes a turn in the usage tables, so the provider that
    // ran the delegation is credited with the work rather than with the single
    // request the router happened to see.
    for (const child of children) openBridgeSubagentUsage({ requestId, context, role, childId: child.id, model: child.model });
    accepted += count;
  }
  return { accepted, closed, unavailable, rejected, reason: null };
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

// A local bridge that did not answer its health check. Distinct from the
// classes below, which all describe something the provider itself said.
const PROBE_FAILURE_CLASS = "probe_unavailable";

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

function recordRouterEvent({ phase, requestId, role = null, requestedModel, provider, model, workspace = null, outcome = null, status = null, failureClass = null, denialReason = null, spawnFailureReason = null, elapsedMs = null, toolCalls = 0, errorName = null, errorCode = null, syscall = null, origin = null, selection = null }) {
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
    // "primary", "last_resort" or "exhaustion_wait": which selection pass chose
    // this provider. Phase stays as it was so every existing counter keeps
    // working; this only says how hard the router had to look.
    selection,
  };
  recentRouterEvents.push(event);
  while (recentRouterEvents.length > Math.max(1, MAX_RECENT_EVENTS)) recentRouterEvents.shift();

  if (provider && model && ["selected", "skipped", "result"].includes(phase)) {
    recordUsageEvent({ phase, requestId, role, provider, model, workspace: workspaceContext, outcome, failureClass, status, elapsedMs, toolCalls, timestamp, origin });
  }
  // Any CLI child still open under this request ends with it; see
  // closeBridgeSubagentsForRequest.
  if (phase === "result") closeBridgeSubagentsForRequest(requestId, outcome, elapsedMs);
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
  resetSubagentTelemetry();
  spawnFailureTelemetry.total = 0;
  spawnFailureTelemetry.byReason = {};
  spawnFailureTelemetry.recent = [];
  providerCooldowns.clear();
  providerFailureStreaks.clear();
  providerProbeStreaks.clear();
  scheduleRouterStatePersist();
}

function getRouterStatus(now = Date.now()) {
  const providers = Object.fromEntries(ROUTES.map((route) => {
    const state = providerState(route.provider);
    const cooldown = providerCooldown(route.provider, now);
    const activeRequests = getActiveRequests(route.provider);
    const coolingDown = cooldown !== null;
    return [route.provider, {
      status: coolingDown ? (cooldown.failureClass ?? state.lastFailureClass ?? "cooldown") : "ready",
      activeRequests,
      cooldownUntil: coolingDown ? new Date(cooldown.until).toISOString() : null,
      cooldownRemainingMs: coolingDown ? cooldown.until - now : 0,
      // Which policy is holding this provider back, and whether it can still be
      // tried as a last resort when every candidate is cooling at once.
      cooldownKind: coolingDown ? cooldown.kind : null,
      cooldownFailureClass: coolingDown ? cooldown.failureClass ?? null : null,
      cooldownResetsAt: coolingDown ? cooldown.resetsAt ?? null : null,
      lastResortEligible: coolingDown ? cooldownAllowsLastResort(cooldown, now) : true,
      failureStreak: providerFailureStreaks.get(route.provider) ?? 0,
      probeFailureStreak: providerProbeStreaks.get(route.provider) ?? 0,
      configuredModels: ROUTING.providers[route.provider]?.models ?? {},
      capabilities: providerCapabilities(route.provider),
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
    subagents: subagentStatus(),
    spawnFailures: spawnFailureStatus(),
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

// The persisted-state file's envelope identity. The trailing version names the
// envelope, not the sections inside it: a version stamp that changed whenever
// any section was added used to invalidate the whole file, so adding one field
// threw away every counter the router had accumulated -- provider telemetry,
// usage, subagent spawns, spawn failures, the event log. Sections are restored
// individually below and each validates its own shape, so a section whose
// format really did change is the only thing dropped when it changes.
const PERSISTED_STATE_SCHEMA = "autodev-router-persisted-state";

function serializeRouterState() {
  return JSON.stringify({
    schema: `${PERSISTED_STATE_SCHEMA}-v2`,
    updatedAt: new Date().toISOString(),
    providerTelemetry: Object.fromEntries(providerTelemetry),
    usage: usagePersistenceSnapshot(),
    concurrency: concurrencyTelemetry,
    subagents: {
      total: subagentTelemetry.total,
      byMechanism: subagentTelemetry.byMechanism,
      byProvider: subagentTelemetry.byProvider,
      byRole: subagentTelemetry.byRole,
      byStatus: subagentTelemetry.byStatus,
      recent: subagentTelemetry.recent,
    },
    spawnFailures: spawnFailureTelemetry,
    // Only hard cooldowns survive a restart. A provider that stated it is out
    // of usage until Tuesday is still out of usage on Tuesday, and the router
    // restarts often enough (launchd KeepAlive) that dropping that would put it
    // straight back to re-probing an exhausted account. Transient and probe
    // cooldowns are the router's own guesses about a moment that has passed, so
    // a restart is a legitimate reason to go and look again.
    providerCooldowns: [...providerCooldowns.entries()]
      .filter(([, entry]) => entry.kind === "hard")
      .map(([provider, entry]) => ({ provider, ...entry })),
    recentEvents: [...recentRouterEvents],
    otelTelemetry: otelPersistenceSnapshot(),
  }, null, 2);
}

function loadRouterState(file = STATE_FILE) {
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // Envelope check only. Every section below restores itself and rejects a
    // shape it does not recognise, which is what decides whether that section
    // survives -- not a global stamp that discards the file over an unrelated
    // addition.
    if (typeof parsed?.schema !== "string" || !parsed.schema.startsWith(PERSISTED_STATE_SCHEMA)) return false;
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
    if (parsed.subagents && typeof parsed.subagents === "object") {
      const saved = parsed.subagents;
      if (Number.isInteger(saved.total) && saved.total >= 0) subagentTelemetry.total = saved.total;
      for (const section of ["byMechanism", "byProvider", "byRole", "byStatus"]) {
        if (!saved[section] || typeof saved[section] !== "object") continue;
        for (const [key, count] of Object.entries(saved[section])) {
          if (typeof count === "number" && Number.isFinite(count) && count >= 0) subagentTelemetry[section][safeMetricLabel(key)] = count;
        }
      }
      if (Array.isArray(saved.recent)) {
        subagentTelemetry.recent = saved.recent.filter((entry) => entry && typeof entry === "object").slice(-MAX_RECENT_SUBAGENT_SPAWNS);
      }
    }
    if (Array.isArray(parsed.providerCooldowns)) {
      const now = Date.now();
      for (const entry of parsed.providerCooldowns) {
        if (!entry || typeof entry !== "object" || entry.kind !== "hard") continue;
        if (!providerTelemetry.has(entry.provider)) continue;
        const until = Number(entry.until);
        // Re-clamp on the way back in: a persisted deadline is only as good as
        // the clock that wrote it, and one far in the future would strand a
        // provider that has long since recovered.
        if (!Number.isFinite(until) || until <= now) continue;
        providerCooldowns.set(entry.provider, {
          until: Math.min(until, now + HARD_COOLDOWN_MAX_MS),
          kind: "hard",
          failureClass: typeof entry.failureClass === "string" ? entry.failureClass : null,
          resetsAt: normalizeResetsAt(entry.resetsAt),
          since: typeof entry.since === "number" ? entry.since : now,
        });
      }
    }
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

const CLIENT_DISCONNECT_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

function isClientDisconnectError(error) {
  if (!error || typeof error !== "object") return false;
  if (CLIENT_DISCONNECT_CODES.has(error.code)) return true;
  const cause = error.cause;
  if (cause && typeof cause === "object" && CLIENT_DISCONNECT_CODES.has(cause.code)) return true;
  return false;
}

let fatalExitPromise = null;

function handleFatalProcessError(phase, reason) {
  if (fatalExitPromise) return;
  const info = transportErrorInfo(reason);
  if (phase === "uncaught_exception" && isClientDisconnectError(reason)) {
    console.error(JSON.stringify({
      schema: "autodev-router-event-v1",
      timestamp: new Date().toISOString(),
      routerInstanceId: ROUTER_INSTANCE_ID,
      requestId: null,
      phase: "client_disconnect_ignored",
      errorName: info.name,
      errorCode: info.code,
      syscall: info.syscall,
    }));
    return;
  }
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

function providerCooldown(provider, now = Date.now()) {
  const entry = providerCooldowns.get(provider);
  if (!entry) return null;
  if (entry.until > now) return entry;
  providerCooldowns.delete(provider);
  return null;
}

function isProviderCoolingDown(provider, now = Date.now()) {
  return providerCooldown(provider, now) !== null;
}

/**
 * Back a provider off, for a duration that depends on *why* it failed.
 *
 * - `config` (authentication, invalid model): a deterministic misconfiguration.
 *   Fixed and short, with no streak escalation, and never retried as a last
 *   resort -- re-sending a request against a broken credential cannot work.
 * - `probe`: the local bridge did not answer its health check. Its own short
 *   ladder, because a bridge restarting says nothing about the provider behind
 *   it and must not push the real backoff toward its ceiling.
 * - `hard`: the provider itself reported that it is out of usage. Held until the
 *   reset time it stated, with no escalation -- that time is authoritative, and
 *   guessing a longer one helps nobody.
 * - `transient`: everything else, on the original 30s-doubling ladder.
 *
 * A hard class requires `structured` corroboration: a provider *reporting* the
 * limit, not this router matching keywords in prose. Bridges ship stderr tails
 * in error messages, and one stray "quota" in an unrelated crash must not take a
 * provider out for the hard window.
 */
function cooldownProvider(provider, { now = Date.now(), failureClass = null, resetsAt = null, structured = false } = {}) {
  const record = (kind, durationMs, streak = 0, until = now + durationMs) => {
    const entry = { until, kind, failureClass, resetsAt: kind === "hard" ? resetsAt : null, since: now };
    // A cooldown only ever moves later. Otherwise a short one -- a health probe
    // failing while the provider is already out of usage for the week -- would
    // silently shorten the long one and put the router straight back into the
    // hammering the long one exists to prevent. The later deadline keeps its own
    // kind and reset, because that is the one still describing the provider.
    const existing = providerCooldowns.get(provider);
    const kept = existing && existing.until > until ? existing : entry;
    providerCooldowns.set(provider, kept);
    return { provider, kind, streak, durationMs: until - now, cooldownUntil: kept.until, resetsAt: kept.resetsAt };
  };
  if (failureClass === "authentication" || failureClass === "invalid_model") {
    return record("config", PROVIDER_COOLDOWN_MS);
  }
  if (failureClass === PROBE_FAILURE_CLASS) {
    const streak = (providerProbeStreaks.get(provider) ?? 0) + 1;
    providerProbeStreaks.set(provider, streak);
    return record("probe", Math.min(PROBE_COOLDOWN_MAX_MS, PROBE_COOLDOWN_MS * (2 ** (streak - 1))), streak);
  }
  if (structured && isHardLimitClass(failureClass)) {
    const declared = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    // A stated reset is taken at face value, including an imminent one -- the
    // whole point of asking for it is to stop guessing. A reset already in the
    // past means the provider is wrong or its clock is, so that falls back to
    // the short transient window rather than to no cooldown at all. The ceiling
    // caps how long one declaration can strand a provider.
    const until = Number.isNaN(declared)
      ? now + HARD_COOLDOWN_MS
      : declared <= now
        ? now + PROVIDER_COOLDOWN_MS
        : Math.min(declared, now + HARD_COOLDOWN_MAX_MS);
    return record("hard", until - now, 0, until);
  }
  const streak = (providerFailureStreaks.get(provider) ?? 0) + 1;
  providerFailureStreaks.set(provider, streak);
  return record("transient", Math.min(PROVIDER_COOLDOWN_MAX_MS, PROVIDER_COOLDOWN_MS * (2 ** (streak - 1))), streak);
}

function clearProviderCooldown(provider) {
  providerCooldowns.delete(provider);
  providerFailureStreaks.delete(provider);
  providerProbeStreaks.delete(provider);
}

function nextProviderRetryMs(providers, now = Date.now()) {
  let earliest = null;
  for (const provider of providers) {
    const entry = providerCooldowns.get(provider);
    if (entry && entry.until > now && (earliest === null || entry.until < earliest)) earliest = entry.until;
  }
  return earliest === null ? 0 : earliest - now;
}

/**
 * A provider is worth one more attempt while cooling when the cooldown is our
 * own guess rather than something the provider stated. A deterministic config
 * failure is excluded, and so is a hard limit with a reset time still in the
 * future: the provider has said it will not serve until then, and attempting it
 * anyway is guaranteed to fail and is exactly the hammering cooldowns exist to
 * prevent. A hard cooldown with no stated reset stays eligible, because that
 * floor is this router's guess and not the provider's word.
 */
function cooldownAllowsLastResort(entry, now = Date.now()) {
  if (!entry) return true;
  if (entry.kind === "config") return false;
  if (entry.kind === "hard" && entry.resetsAt && Date.parse(entry.resetsAt) > now) return false;
  return true;
}

/** Per-provider cooldown state for the structured exhaustion body and /status. */
function providerCooldownSummary(providers, now = Date.now()) {
  return [ ...new Set(providers) ].map((provider) => {
    const entry = providerCooldowns.get(provider);
    const cooling = entry && entry.until > now;
    return {
      provider,
      state: cooling ? entry.kind : "available",
      failureClass: cooling ? entry.failureClass ?? null : providerState(provider).lastFailureClass ?? null,
      resetsAt: cooling ? entry.resetsAt ?? null : null,
      retryAfterMs: cooling ? entry.until - now : 0,
    };
  });
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

const FLATTENED_NAMESPACES = Object.freeze([
  ["multi_agent_v1", "multi_agent_v1__"],
  ["collaboration", "collaboration__"],
  ["agents", "agents__"],
]);

function getNamespacePrefix(ns) {
  const match = FLATTENED_NAMESPACES.find(([namespace]) => namespace === ns);
  return match ? match[1] : `${ns}__`;
}

function flattenOutboundTool(tool, defaultNamespace = null) {
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

function rewriteToolNamespaces(value) {
  if (Array.isArray(value)) {
    return value.map(rewriteToolNamespaces);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = rewriteToolNamespaces(child);
  }

  if (typeof result.name === "string" && (result.namespace === undefined || result.namespace === null)) {
    const match = FLATTENED_NAMESPACES.find(([, prefix]) => result.name.startsWith(prefix));
    if (match) {
      result.namespace = match[0];
      result.name = result.name.slice(match[1].length);
    }
  }
  return result;
}

function transformSseEvent(event, publicModel) {
  return event.split(/(\r?\n)/).map((line) => {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") return line;
    try {
      const parsed = JSON.parse(line.slice(6));
      const rewritten = rewriteToolNamespaces(replaceModelFields(parsed, publicModel));
      return `data: ${JSON.stringify(rewritten)}`;
    } catch {
      return line;
    }
  }).join("");
}

function responseWasNotCompleted(response) {
  return response?.status != null && response.status !== "completed";
}

/** The reason and declared limit a non-streamed incomplete response carries. */
function incompleteFromResponse(parsed) {
  const details = parsed?.incomplete_details;
  const declared = details?.provider_limit;
  return {
    incompleteReason: details?.reason ?? null,
    limit: declared?.class
      ? {
        limitClass: String(declared.class).toLowerCase(),
        limitType: declared.type ? String(declared.type).toLowerCase() : null,
        resetsAt: normalizeResetsAt(declared.resets_at),
        source: declared.source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : "inferred",
      }
      : null,
  };
}

async function writeResponseStream(response, upstream, publicModel, signal = null) {
  const decoder = new TextDecoder();
  const seenToolCalls = new Set();
  let toolCalls = 0;
  let buffer = "";
  let terminal = null;
  // Enough of the turn to close it properly if the stream dies mid-flight. The
  // bridges flush their own partial work when they can see the failure coming;
  // this is the backstop for what they cannot -- the bridge process being
  // killed, or the socket dropping under them.
  const streamState = { sawCreated: false, responseId: null, model: publicModel, itemId: null, reasoningId: null, text: "", reasoning: "" };
  let incompleteReason = null;
  let reportedLimit = null;
  const onResponseError = () => {
    // Absorb client disconnect socket errors (EPIPE, ECONNRESET, etc.)
  };
  response.on("error", onResponseError);
  const isWritable = () => !response.writableEnded && !response.destroyed && !response.closed && !signal?.aborted;
  const safeWrite = (chunk) => {
    if (!isWritable()) return false;
    try {
      return response.write(chunk);
    } catch {
      return false;
    }
  };
  const keepAlive = setInterval(() => {
    safeWrite(": codex-router keep-alive\n\n");
  }, 2000);
  const inspectEvent = (event) => {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.type === "response.created") {
          streamState.sawCreated = true;
          streamState.responseId = parsed.response?.id ?? streamState.responseId;
        } else if (parsed.type === "response.output_item.added") {
          if (parsed.item?.type === "reasoning") streamState.reasoningId = parsed.item.id ?? streamState.reasoningId;
          if (parsed.item?.type === "message") streamState.itemId = parsed.item.id ?? streamState.itemId;
        } else if (parsed.type === "response.output_text.delta") {
          streamState.text += String(parsed.delta ?? "");
          streamState.itemId = parsed.item_id ?? streamState.itemId;
        } else if (parsed.type === "response.reasoning_summary_text.delta") {
          streamState.reasoning += String(parsed.delta ?? "");
          streamState.reasoningId = parsed.item_id ?? streamState.reasoningId;
        } else if (parsed.type === "response.failed") {
          terminal = "failed";
        } else if (parsed.type === "response.completed") {
          terminal = responseWasNotCompleted(parsed.response) ? "failed" : "completed";
          // A bridge that closed a turn as incomplete already said why and, for
          // a limit, until when. Carry both back to the chain so the provider is
          // cooled on what it actually reported rather than a generic
          // upstream_error.
          const details = parsed.response?.incomplete_details;
          if (details?.reason) incompleteReason = details.reason;
          const declared = details?.provider_limit;
          if (declared?.class) {
            reportedLimit = {
              limitClass: String(declared.class).toLowerCase(),
              limitType: declared.type ? String(declared.type).toLowerCase() : null,
              resetsAt: normalizeResetsAt(declared.resets_at),
              source: declared.source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : "inferred",
            };
          }
        }
      } catch {
        // Preserve the existing tolerant behavior for malformed provider lines.
      }
    }
  };
  const flushEvents = (flush = false) => {
    while (isWritable()) {
      const boundary = buffer.match(/\r?\n\r?\n/);
      if (!boundary) break;
      const end = boundary.index + boundary[0].length;
      const event = buffer.slice(0, end);
      inspectEvent(event);
      toolCalls += countToolCallsFromSse(event, seenToolCalls);
      safeWrite(transformSseEvent(event, publicModel));
      buffer = buffer.slice(end);
    }
    if (flush && buffer && isWritable()) {
      inspectEvent(buffer);
      toolCalls += countToolCallsFromSse(buffer, seenToolCalls);
      safeWrite(transformSseEvent(buffer, publicModel));
      buffer = "";
    }
  };
  // Close a stream the upstream abandoned. Whatever it had already sent is what
  // the caller keeps -- so it is closed as an incomplete turn carrying that
  // work, rather than a bare failure that throws it away and leaves the caller
  // parsing an error string for a result it can no longer see.
  const closeIncomplete = (reason, message) => {
    if (!isWritable()) return;
    if (!streamState.sawCreated) {
      // Nothing to close: no turn was ever opened on the wire.
      safeWrite(responseFailureEvent(message));
      return;
    }
    incompleteReason = incompleteReason ?? reason;
    for (const [eventName, body] of terminalIncompleteEvents({
      responseId: streamState.responseId ?? `router_${Date.now()}`,
      itemId: streamState.itemId ?? `msg_${Date.now()}`,
      reasoningId: streamState.reasoningId ?? `rs_${Date.now()}`,
      text: streamState.text,
      reasoningText: streamState.reasoning,
      reason,
      limit: reportedLimit,
      response: { id: streamState.responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: publicModel },
    })) {
      safeWrite(`event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`);
    }
  };
  const streamResult = () => ({ toolCalls, failed: terminal === "completed" ? false : true, incompleteReason, limit: reportedLimit });
  if (!upstream.body) {
    clearInterval(keepAlive);
    safeWrite(responseFailureEvent("Upstream provider returned no response body."));
    response.removeListener("error", onResponseError);
    return streamResult();
  }
  try {
    for await (const chunk of upstream.body) {
      if (!isWritable()) break;
      buffer += decoder.decode(chunk, { stream: true });
      flushEvents();
    }
    if (isWritable()) {
      buffer += decoder.decode();
      flushEvents(true);
    }
  } catch (error) {
    if (isWritable()) {
      const timedOut = signal?.aborted && signal.reason?.name === "TimeoutError";
      const message = timedOut
        ? `Upstream provider exceeded the ${Math.ceil(UPSTREAM_TIMEOUT_MS / 1000)}s response timeout.`
        : error instanceof Error ? error.message : String(error);
      closeIncomplete(timedOut ? INCOMPLETE_REASON_TIMEOUT : INCOMPLETE_REASON_INTERRUPTED, message);
    }
    return streamResult();
  } finally {
    clearInterval(keepAlive);
    response.removeListener("error", onResponseError);
  }
  if (terminal === null) {
    closeIncomplete(INCOMPLETE_REASON_INTERRUPTED, "Upstream provider closed the stream before response.completed.");
  }
  return streamResult();
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
      // Structured detail for a caller that can act on it -- which providers
      // are out, until when, and whether waiting or yielding is the right move.
      // Validated as a plain object so nothing unexpected reaches the wire.
      details: context.details && typeof context.details === "object" && !Array.isArray(context.details) ? context.details : null,
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

function bridgeTelemetryHeaders(route, requestId) {
  // Only a bridge that can spawn inside its own runtime has anything to
  // report, and only the orchestrator-capable ones ever do. Sending the
  // watchlist and the report endpoint per request means a bridge needs no
  // routing config, no provider identity, and no router address of its own.
  const spawnTools = subagentSpawnToolsFor(route.provider);
  if (spawnTools.length === 0 || !requestId) return {};
  return {
    [REQUEST_ID_HEADER]: requestId,
    [SUBAGENT_SPAWN_TOOLS_HEADER]: spawnTools.join(","),
    [AGENT_EVENTS_URL_HEADER]: AGENT_EVENTS_URL,
  };
}

function downstreamHeaders(route, auth, turnMetadataHeader, agentRole = null, requestId = null) {
  const headers = { "content-type": "application/json", accept: "text/event-stream", ...bridgeTelemetryHeaders(route, requestId) };
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
  // Router-classified, not client-supplied: the value comes from this router's
  // own alias dispatch, so a bridge can trust it to select role instructions.
  if (agentRole) headers[AGENT_ROLE_HEADER] = agentRole;
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

function upstreamPayload(route, payload, wantsStream) {
  // `extra_headers` is an SDK escape hatch a proxy consumes as outbound HTTP
  // headers. Never pass the caller's value through the router: doing so would
  // bypass the router's credential and header allowlist. Every provider now
  // sits behind a local adapter the router calls directly, so the router's own
  // headers travel as real headers (see downstreamHeaders) and nothing needs to
  // ride in the body.
  const { extra_headers: _discardedExtraHeaders, ...safePayload } = payload;
  if (route.provider !== "codex" && Array.isArray(safePayload.tools)) {
    safePayload.tools = flattenOutboundTools(safePayload.tools);
  }
  return route.provider === "codex" ? { ...safePayload, stream: true, store: false } : { ...safePayload, stream: wantsStream };
}

async function fetchUpstream(route, payload, wantsStream, turnMetadataHeader, clientSignal = null, agentRole = null, requestId = null) {
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
  const requestPayload = upstreamPayload(route, payload, wantsStream);
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = clientSignal ? AbortSignal.any([clientSignal, timeoutSignal]) : timeoutSignal;
  const upstream = await fetch(`${route.baseUrl}/responses`, {
    method: "POST",
    headers: downstreamHeaders(route, auth, turnMetadataHeader, agentRole, requestId),
    signal,
    body: JSON.stringify(requestPayload),
  });
  if (!upstream.ok) {
    const body = await upstream.text();
    return {
      ok: false,
      status: upstream.status,
      body,
      // What the provider said about its own limit, if anything. A declared
      // limit is the only thing that corroborates a long hard cooldown; without
      // it the router is left matching keywords in prose, which is exactly the
      // guess that used to lock a provider out over an unrelated stderr tail.
      limit: declaredLimit(upstream.headers, body),
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
    if (!response.writableEnded && !response.destroyed && !response.closed) {
      try { response.end(); } catch {}
    }
    return streamResult;
  }
  const body = await upstream.text();
  if (route.provider === "codex") {
    const toolCalls = countToolCallsFromSse(body);
    const parsed = replaceModelFields(responseTextFromSse(body), publicModel);
    sendJson(response, upstream.status, parsed, responseHeaders);
    return { toolCalls, failed: responseWasNotCompleted(parsed), ...incompleteFromResponse(parsed) };
  }
  try {
    const parsed = JSON.parse(body);
    const toolCalls = countToolCallsInResponse(parsed);
    const rewritten = rewriteToolNamespaces(replaceModelFields(parsed, publicModel));
    sendJson(response, upstream.status, rewritten, responseHeaders);
    return { toolCalls, failed: responseWasNotCompleted(rewritten), ...incompleteFromResponse(rewritten) };
  } catch {
    response.writeHead(upstream.status, { ...responseHeaders, "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
    return { toolCalls: 0, failed: false };
  }
}

/**
 * The limit a provider declared, from its response headers or, failing that,
 * from an `error.limit` field in its body. Returns null when it declared none,
 * so a caller can tell "no limit reported" from "reported without a reset".
 */
function declaredLimit(headers, body) {
  const fromHeaders = readLimitHeaders(headers);
  if (fromHeaders) return fromHeaders;
  try {
    const declared = JSON.parse(String(body ?? ""))?.error?.limit;
    if (!declared?.class) return null;
    return {
      limitClass: String(declared.class).toLowerCase(),
      limitType: declared.type ? String(declared.type).toLowerCase() : null,
      resetsAt: normalizeResetsAt(declared.resets_at),
      source: declared.source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : "inferred",
    };
  } catch {
    return null;
  }
}

/** Cooldown options describing a failed attempt, for `cooldownProvider`. */
function cooldownFor(failureClass, limit = null) {
  return {
    failureClass: limit?.limitClass ?? failureClass,
    resetsAt: limit?.resetsAt ?? null,
    structured: limit?.source === LIMIT_SOURCE_REPORTED,
  };
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
    const result = await fetch(route.healthUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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
    if (response.headersSent) {
      // Never leave a caller holding a stream with no terminal event; a
      // truncated SSE body is indistinguishable from a hung provider.
      try { response.write(responseFailureEvent(`Direct request to ${payload.model} failed with HTTP ${status}.`)); } catch {}
      response.end();
      return;
    }
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
  // A pinned provider model is a bridge request like any other. The Antigravity
  // CLI has no flag that removes its subagent tools, so even a leaf turn there
  // can delegate; register the attribution context so such a spawn is counted
  // rather than rejected as an unknown request.
  noteBridgeRequest(requestId, { provider: route.provider, model: payload.model, role: null, workspace: workspace?.key ?? null });
  try {
    while (attempts < maxAttempts) {
      try {
        const result = await fetchUpstream(route, payload, wantsStream, turnMetadataHeader, clientSignal, null, requestId);
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
          if (result.retryable) cooldownProvider(route.provider, cooldownFor(failureClass, result.limit));
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
        cooldownProvider(route.provider, cooldownFor(failureClass));
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
      if (response.headersSent) {
        try { response.write(responseFailureEvent(`Direct request to ${payload.model} could not be completed.`)); } catch {}
        response.end();
      } else sendJson(response, 502, errorBody(`Direct concrete request to ${payload.model} (${route.provider}) could not be completed.`, "router_upstream_error", { code: "router_upstream_error", retryable: true, failureClass, provider: route.provider, model: payload.model, requestId }), { "x-autodev-provider": route.provider, "x-autodev-model": payload.model, "x-autodev-request-id": requestId });
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
async function proxyFallbackChain(response, { candidates, role = null, origin = null, subject, agentRole = null, sessionKey = null }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null) {
  const failures = [];
  const attempted = new Set();
  const skipped = [];
  const startedAt = Date.now();
  // Bounds how long the router spends *looking* for a provider, not how long a
  // turn may run: checked before starting a candidate and never during one, so
  // a long turn on the last candidate still gets the full upstream timeout.
  const selectionDeadline = startedAt + CHAIN_SELECTION_DEADLINE_MS;
  let deadlineReached = false;
  let lastResortAttempts = 0;

  const noteSkip = (route, why, failureClass) => {
    failures.push(`${route.provider}: ${why}`);
    skipped.push(route);
    recordRouterEvent({ phase: "skipped", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, failureClass });
  };

  // One attempt against one provider. Returns "served" when a response was
  // written, "terminal" when the provider's own error was passed through
  // verbatim, or "fallback" when the next candidate should be tried.
  const attemptCandidate = async (route, selection) => {
    const attemptStartedAt = Date.now();
    attempted.add(route.provider);
    recordRouterEvent({ phase: "selected", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, selection });
    // A bridge report names only the request id, so record which provider and
    // workspace this attempt resolved to before the upstream call begins.
    noteBridgeRequest(requestId, { provider: route.provider, model: route.model, role, workspace: workspace?.key ?? null });
    if (agentRole === ORCHESTRATOR_AGENT_ROLE) noteOrchestratorSession(sessionKey, route.provider);
    incrementActiveRequests(route.provider);
    try {
      const result = await fetchUpstream(route, payloadForCandidate(payload, route), wantsStream, turnMetadataHeader, clientSignal, agentRole, requestId);
      if (result.ok) {
        try {
          const responseResult = await writeSuccessfulResponse(response, route, result, wantsStream, payload.model, requestId, route.model);
          if (responseResult.failed) {
            // A turn the provider closed as incomplete already said why, and for
            // a limit, until when. Cool it on what it reported rather than on a
            // generic upstream_error -- that report is the whole reason the
            // bridges now carry one.
            const failureClass = responseResult.limit?.limitClass ?? (responseResult.incompleteReason ? "unavailable" : "upstream_error");
            cooldownProvider(route.provider, cooldownFor(failureClass, responseResult.limit));
            recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "failure", status: result.upstream.status, failureClass, elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls, selection });
            return "served";
          }
          clearProviderCooldown(route.provider);
          recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "success", status: result.upstream.status, elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls, selection });
        } catch (streamError) {
          cooldownProvider(route.provider, cooldownFor("upstream_error"));
          throw streamError;
        }
        return "served";
      }
      const failureClass = result.limit?.limitClass ?? classifyProviderFailure(result.status, result.body);
      failures.push(`${route.provider}: HTTP ${result.status}`);
      recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "failure", status: result.status, failureClass, elapsedMs: Date.now() - attemptStartedAt, selection });
      if (!fallbackable(result.status, result.body)) {
        response.writeHead(result.status, { "content-type": "application/json", "x-autodev-provider": route.provider, "x-autodev-model": route.model, "x-autodev-request-id": requestId, "x-autodev-router-instance-id": ROUTER_INSTANCE_ID });
        response.end(result.body);
        return "terminal";
      }
      cooldownProvider(route.provider, cooldownFor(failureClass, result.limit));
      return "fallback";
    } catch (error) {
      // A missing credential is deterministic, not a transient network failure:
      // it gets the short config cooldown and is never retried as a last
      // resort, because re-sending against a broken credential cannot work.
      const isAuthFailure = error?.code === "router_auth_unavailable";
      const failureClass = isAuthFailure ? "authentication" : classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
      if (!isAuthFailure) logTransportError({ requestId, role, requestedModel: payload.model, provider: route.provider, model: route.model, error, workspace });
      // Keep provider-specific exception text private; the structured event
      // carries the safe failure class and the response needs only a stable
      // provider summary for fallback diagnostics.
      failures.push(`${route.provider}: ${failureClass}`);
      recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "failure", status: 502, failureClass, elapsedMs: Date.now() - attemptStartedAt, selection });
      cooldownProvider(route.provider, cooldownFor(failureClass));
      if (response.headersSent) {
        // The stream already closed itself as incomplete on the way out of
        // writeResponseStream; this is the backstop for a throw that happened
        // anywhere else with headers already on the wire. Never leave a caller
        // holding a stream with no terminal event.
        if (!response.writableEnded) {
          try { response.write(responseFailureEvent(`Router could not complete ${subject}: ${failureClass}.`)); } catch {}
          response.end();
        }
        return "served";
      }
      return "fallback";
    } finally {
      decrementActiveRequests(route.provider);
    }
  };

  // "unavailable" is distinct from "fallback": nothing was sent, so it does not
  // count against a pass that is budgeted in attempts.
  const tryCandidate = async (route, selection) => {
    if (!(await providerAvailable(route))) {
      // A health probe says the local bridge did not answer. That is real, but
      // it says nothing about the provider behind it, so it rides its own short
      // ladder rather than escalating the provider's own backoff.
      cooldownProvider(route.provider, { failureClass: PROBE_FAILURE_CLASS });
      noteSkip(route, "unavailable", PROBE_FAILURE_CLASS);
      return "unavailable";
    }
    return attemptCandidate(route, selection);
  };
  const served = (outcome) => outcome === "served" || outcome === "terminal";

  // Pass 1: the candidates that are not cooling at all.
  for (const route of candidates) {
    if (Date.now() > selectionDeadline) { deadlineReached = true; break; }
    if (isProviderCoolingDown(route.provider)) {
      noteSkip(route, "cooldown active", providerCooldown(route.provider)?.failureClass ?? providerState(route.provider).lastFailureClass ?? "cooldown");
      continue;
    }
    if (served(await tryCandidate(route, "primary"))) return;
  }

  // Pass 2: a cooldown is load-shedding advice, not proof a provider is dead.
  // Rather than strand the caller, try a bounded number of the ones we skipped,
  // soonest-to-lapse first. Excluded: anything already attempted, a
  // deterministic config failure, a provider that stated a reset time still in
  // the future (it has told us it will not serve, and attempting it anyway is
  // the hammering cooldowns exist to prevent), and any provider already serving
  // another request -- so concurrent exhausted requests do not all pile onto
  // the same cooling provider at once.
  if (!deadlineReached) {
    const eligible = skipped
      .filter((route) => !attempted.has(route.provider) && cooldownAllowsLastResort(providerCooldown(route.provider)) && getActiveRequests(route.provider) === 0)
      .sort((a, b) => (providerCooldown(a.provider)?.until ?? 0) - (providerCooldown(b.provider)?.until ?? 0))
      .slice(0, LAST_RESORT_MAX_ATTEMPTS);
    for (const route of eligible) {
      if (Date.now() > selectionDeadline) { deadlineReached = true; break; }
      lastResortAttempts += 1;
      if (served(await tryCandidate(route, "last_resort"))) return;
    }
  }

  // Pass 3: if a cooldown is about to lapse anyway, wait for it rather than
  // handing back a 503 that ends the caller's turn. Bounded and pre-header, so
  // the client sees a slow request rather than a stalled stream -- and a role
  // request holds its subagent slot throughout, which is why the budget is
  // small.
  const waitCandidates = candidates.filter((route) => !attempted.has(route.provider));
  const waitMs = nextProviderRetryMs(waitCandidates.map(({ provider }) => provider));
  if (!deadlineReached && EXHAUSTION_WAIT_MS > 0 && waitMs > 0 && waitMs <= EXHAUSTION_WAIT_MS && !clientSignal?.aborted && !response.headersSent) {
    recordRouterEvent({ phase: "exhaustion_wait", requestId, role, origin, requestedModel: payload.model, provider: null, model: null, workspace, elapsedMs: waitMs });
    await delay(waitMs, clientSignal);
    if (!clientSignal?.aborted) {
      // One attempt, not one candidate: a provider whose local bridge is down
      // was never asked anything, so it must not consume the single try the
      // wait bought.
      for (const route of waitCandidates) {
        if (isProviderCoolingDown(route.provider)) continue;
        const outcome = await tryCandidate(route, "exhaustion_wait");
        if (served(outcome)) return;
        if (outcome !== "unavailable") break;
      }
    }
  }

  recordSpawnFailure({ requestId, role, requestedModel: payload.model, reason: deadlineReached ? "selection_deadline" : "provider_exhausted" });
  // This is the one path that never emits a `result` event, so the bridge rows
  // opened for this request would otherwise stay open forever.
  closeBridgeSubagentsForRequest(requestId, "failure");
  const summary = providerCooldownSummary(candidates.map(({ provider }) => provider));
  sendJson(response, 503, exhaustionBody({ subject, summary, failures, model: payload.model, requestId, lastResortAttempts, deadlineReached }), exhaustionHeaders({ summary, requestId }));
}

/** Sleep, cut short if the client gives up on the request. */
function delay(ms, signal = null) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    }
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

/** The soonest-resetting provider in a cooldown summary, or null. */
function soonestReset(summary) {
  return summary
    .filter((entry) => entry.resetsAt)
    .sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))[0] ?? null;
}

/**
 * The body returned when no provider could serve the turn.
 *
 * The consumer is a model reading an error string, so the prose has to carry as
 * much as the JSON: which providers are out, until when, and what to do about
 * it. "cooldown active" four times over told the caller nothing it could act on
 * and ended the session.
 */
function exhaustionBody({ subject, summary, failures, model, requestId, lastResortAttempts, deadlineReached }) {
  const now = Date.now();
  const retryAfterMs = summary.reduce((soonest, entry) => (entry.retryAfterMs > 0 && (soonest === 0 || entry.retryAfterMs < soonest) ? entry.retryAfterMs : soonest), 0);
  const hard = summary.filter((entry) => entry.state === "hard");
  const everyCandidateHardLimited = hard.length > 0 && hard.length === summary.length;
  const reset = soonestReset(summary);
  const described = summary.map((entry) => {
    if (entry.state === "available") return `${entry.provider}: available but did not complete the turn`;
    if (entry.resetsAt) return `${entry.provider}: ${entry.failureClass ?? entry.state}, resets at ${entry.resetsAt}`;
    return `${entry.provider}: ${entry.failureClass ?? entry.state}, retry in ${Math.ceil(entry.retryAfterMs / 1000)}s`;
  });
  const action = everyCandidateHardLimited ? "summarize_and_yield" : "retry_after";
  const guidance = everyCandidateHardLimited
    ? `Every provider is out of usage${reset ? ` until at least ${reset.resetsAt}` : ""}. Return a summary of the work completed so far rather than retrying.`
    : `Retry after approximately ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`;
  const reason = deadlineReached
    ? `No available provider completed ${subject} within the ${Math.ceil(CHAIN_SELECTION_DEADLINE_MS / 1000)}s provider-selection budget.`
    : `No available provider completed ${subject}.`;
  return errorBody(`${reason} ${described.join("; ")}. ${guidance}`, "router_provider_exhausted", {
    code: "router_provider_exhausted",
    retryable: true,
    failureClass: everyCandidateHardLimited ? (hard[0].failureClass ?? "quota_exhausted") : "unavailable",
    model,
    requestId,
    details: {
      retryAfterMs,
      resetsAt: reset?.resetsAt ?? null,
      recommendedAction: action,
      lastResortAttempts,
      selectionDeadlineReached: deadlineReached,
      providers: summary,
      failures,
      now: new Date(now).toISOString(),
    },
  });
}

function exhaustionHeaders({ summary, requestId }) {
  const retryAfterMs = summary.reduce((soonest, entry) => (entry.retryAfterMs > 0 && (soonest === 0 || entry.retryAfterMs < soonest) ? entry.retryAfterMs : soonest), 0);
  const headers = { "x-autodev-request-id": requestId, "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
  const reset = soonestReset(summary);
  if (reset) {
    headers[LIMIT_HEADER_RESETS_AT] = reset.resetsAt;
    if (reset.failureClass) headers[LIMIT_HEADER_CLASS] = reset.failureClass;
  }
  return headers;
}

async function proxyRoleResponse(response, role, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null, sessionKey = null) {
  return proxyFallbackChain(response, { candidates: roleCandidates(role), role, agentRole: role, subject: `role ${role}`, sessionKey }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal);
}

async function proxyOrchestratorResponse(response, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null, sessionKey = null) {
  return proxyFallbackChain(response, { candidates: orchestratorCandidates(), role: null, origin: "orchestrator", agentRole: ORCHESTRATOR_AGENT_ROLE, subject: "the orchestrator", sessionKey }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal);
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

// Router-generated (never forwarded from the client) header naming the agent
// role each outbound provider request is serving. Provider bridges use it to
// pick their role instructions: the root orchestrator must receive the
// orchestrator policy, not the leaf policy that forbids spawning subagents.
const AGENT_ROLE_HEADER = "x-autodev-agent-role";
const ORCHESTRATOR_AGENT_ROLE = "orchestrator";

// Router-generated headers that let a CLI-delegation bridge report the
// subagents it spawns inside its own runtime. The router owns all three
// values, so a bridge needs no configuration of its own: the request id is the
// correlation key (and, being an unguessable per-request UUID the bridge only
// learns by serving the request, the thing that authorizes the report), the
// tool list is the watchlist of tool names that mean "a subagent was spawned"
// for the provider serving this request, and the URL is where to post them.
const REQUEST_ID_HEADER = "x-autodev-request-id";
const SUBAGENT_SPAWN_TOOLS_HEADER = "x-autodev-subagent-spawn-tools";
const AGENT_EVENTS_URL_HEADER = "x-autodev-agent-events-url";
const AGENT_EVENTS_PATH = "/v1/agent-events";
const AGENT_EVENTS_URL = `http://${HOST}:${PORT}${AGENT_EVENTS_PATH}`;

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
  // Must match how the bridges resolve the same map (resolveWorkspaceFromTurnMetadata):
  // a key that is not a directory on this host is not the workspace the agent
  // will run in, so labelling a turn with one made telemetry name a different
  // repository than the one actually edited. Ambiguity is left unresolved here
  // rather than guessed -- the bridge refuses such a turn anyway, and a label
  // is not worth inventing an answer the executing side declined to give.
  const resolvableKeys = Object.keys(workspaces).filter((value) => typeof value === "string" && value.trim() && isDirectory(value));
  const path = explicitPaths.find((value) => typeof value === "string" && value.trim())
    ?? (resolvableKeys.length === 1 ? resolvableKeys[0] : null)
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
  if (pathname === AGENT_EVENTS_PATH && request.method === "POST") {
    try {
      const result = ingestAgentEvents(JSON.parse(await requestBody(request)));
      if (result.reason === "unknown_request_id") {
        sendJson(response, 404, errorBody("No router request matches the reported request id.", "router_unknown_request", { code: "router_unknown_request" }));
        return;
      }
      sendJson(response, 200, result);
    } catch {
      sendJson(response, 400, errorBody("Agent event request must be valid JSON"));
    }
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
      // primary provider is out of usage or otherwise unavailable. Its session
      // is still resolved so a later role request from the same session can be
      // attributed to the provider that ran the parent turn.
      const orchestratorSession = requestSession(request, payload, turnMetadataHeader);
      await proxyOrchestratorResponse(response, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientAbort.signal, orchestratorSession.key);
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
      // Everything after the slot is acquired runs inside the try that releases
      // it. Recording the spawn used to sit outside, so anything thrown there
      // leaked the slot permanently -- and with a per-session limit of two, two
      // leaks end delegation for that session until the router restarts.
      try {
        // An `autodev/<role>` request *is* a spawned subagent: the parent's own
        // spawn tool created the child thread that sent it. Recorded here rather
        // than in the fallback chain so one spawn counts once, not once per
        // provider attempted.
        recordSubagentSpawn({
          mechanism: "router_alias",
          provider: orchestratorProviderForSession(session.key),
          role,
          tool: "multi_agent_v1.spawn",
          requestId,
          workspace: workspace?.key ?? null,
        });
        await proxyRoleResponse(response, role, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientAbort.signal, session.key);
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
      if (response.headersSent) {
        try { response.write(responseFailureEvent("The router could not complete the request.")); } catch {}
        response.end();
      } else sendJson(response, 502, errorBody("The router could not complete the request.", "router_internal_error", { code: "router_internal_error", retryable: true }));
    } catch {
      // The client may have disconnected between the state check and the write.
    }
  }
}

export {
  activeProviderRequests,
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
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
  cooldownAllowsLastResort,
  cooldownProvider,
  providerCooldownSummary,
  declaredLimit,
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
  isClientDisconnectError,
  isDraining,
  isProviderCoolingDown,
  loadRouterState,
  nextProviderRetryMs,
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
  tryAcquireSubagentSlot,
  responseTextFromSse,
  transformSseEvent,
  flattenOutboundTools,
  rewriteToolNamespaces,
  FLATTENED_NAMESPACES,
  providerCapabilities,
  subagentSpawnToolsFor,
  bridgeTelemetryHeaders,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  subagentStatus,
  ingestAgentEvents,
  noteBridgeRequest,
  closeBridgeSubagentsForRequest,
  UNATTRIBUTED_SUBAGENT_ROLE,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  AGENT_EVENTS_URL_HEADER,
  AGENT_EVENTS_PATH,
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
