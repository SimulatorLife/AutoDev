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
import { resolveCwd, WORKSPACE_KEYS, isDirectory } from "../src/shared/resolve-workspace.ts";
import {
  buildCompletedResponse,
  countToolCallsFromSse,
  countToolCallsInResponse,
  flattenOutboundTools,
  replaceModelFields,
  responseTextFromSse,
  rewriteResponseValue,
  setUpstreamShapeHooks,
  transformSseEvent,
  upstreamPayload,
} from "../src/router/responses.ts";
import { INCOMPLETE_REASON_INTERRUPTED, INCOMPLETE_REASON_TIMEOUT, isHardLimitClass, LIMIT_HEADER_CLASS, LIMIT_HEADER_RESETS_AT, LIMIT_SOURCE_REPORTED, normalizeResetsAt, readLimitHeaders, terminalIncompleteEvents } from "../src/shared/provider-limits.ts";
// Providers disagree about the Responses API's item-id contract, and Codex
// replays whatever it was handed on every later turn. Normalising outbound is
// what stops one lax turn from permanently poisoning a session.
import { dropUnresolvableReasoning, normalizeInputItemIds } from "../src/shared/responses-item-ids.ts";
import { CodexStateCollector, loadCodexStateCollectorConfig } from "../src/router/state-collector.ts";
import {
  COOLDOWN_CONFIG,
  COOLDOWNS,
  PROBE_FAILURE_CLASS,
} from "../src/router/cooldown.ts";
import {
  ORCHESTRATOR_ALIAS,
  ORCHESTRATOR_REASONING_EFFORT,
  ORCHESTRATOR_TIER,
  ROLE_NAMES,
  ROUTES,
  ROUTING_CONFIG as ROUTING,
  ROUTING_CONFIG_FILE,
  ROUTING_POLICY,
} from "../src/router/routing.ts";
// Session/agent activity that spans the gaps between requests -- waiting on a
// tool result, waiting on the next user turn, waiting on a spawned subagent.
// A single shared state machine backs both the usage-table "live activity"
// view and the concurrency table's subagent-slot accounting so the two never
// disagree about what "still active" means.
import { AGENT_ACTIVITY_KINDS, AGENT_ACTIVITY_STATES, createAgentActivityTracker, resolveAgentActivityTtlMs } from "../src/agents/agent-activity.ts";
import {
  ConcurrencyManager,
  PROCESS_FALLBACK_SESSION_KEY,
  SUBAGENT_SLOT_KIND,
  concurrencyStatus as getConcurrencyStatus,
  matchAgentsContext,
  parseConcurrencyConfig,
  recordConcurrencyDenial as recordManagerConcurrencyDenial,
  releaseSubagentSlot as releaseManagerSubagentSlot,
  resetConcurrencyTelemetry as resetManagerConcurrencyTelemetry,
  restoreConcurrencyTelemetry,
  setDefaultConcurrencyManager,
  touchOpenSubagentSlots as touchManagerOpenSubagentSlots,
  tryAcquireSubagentSlot as tryAcquireManagerSubagentSlot,
} from "../src/router/concurrency.ts";
import {
  RouterLifecycle,
  abortActiveResponseRequests as abortManagerActiveResponseRequests,
  beginShutdown as beginManagerShutdown,
  getLifecycleStatus as getManagerLifecycleStatus,
  isDraining as isManagerDraining,
  registerActiveRequest as registerManagerActiveRequest,
  resetLifecycleForTests as resetManagerLifecycleForTests,
  setDefaultRouterLifecycle,
  setLifecycleState as setManagerLifecycleState,
  unregisterActiveRequest as unregisterManagerActiveRequest,
} from "../src/router/lifecycle.ts";
import {
  authStatus,
  isLoopbackAddress,
  isRouterAuthEnabled,
  routerAuthorizationValid,
  setRouterAuthTokenForTests,
} from "../src/router/auth.ts";
import {
  RouterEventRecorder,
  classifyProviderFailure,
  setDefaultRouterEventRecorder,
} from "../src/router/events.ts";
import {
  SubagentRegistry,
  SUBAGENT_MECHANISMS,
  MAX_RECENT_SUBAGENT_SPAWNS,
  UNATTRIBUTED_SUBAGENT_ROLE,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  REQUEST_ID_HEADER,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  AGENT_EVENTS_URL_HEADER,
  AGENT_EVENTS_PATH,
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
  FORWARDED_REQUEST_HEADERS,
  bridgeSubagentKey,
  reportedChildren,
  providerCapabilities,
  roleCapabilityRequirements,
  subagentSpawnToolsFor,
  mcpContractForRole as subagentMcpContractForRole,
  bridgeTelemetryHeaders as subagentBridgeTelemetryHeaders,
  safeMetricLabel,
  bumpCount,
  setDefaultSubagentRegistry,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  noteBridgeRequest,
  noteBridgeSession,
  lookupBridgeSessionContext,
  recallBridgeSessionRequestId,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  subagentStatus,
  recordSpawnFailure,
  spawnFailureStatus,
  closeBridgeSubagentsForRequest,
  rememberWorkspaceMetadata,
  getWorkspaceMetadata,
  openBridgeSubagentUsage,
  closeBridgeSubagentUsage,
  getBridgeRequestContext,
  resetSpawnFailureTelemetry,
} from "../src/router/subagents.ts";
import {
  PERSISTED_STATE_SCHEMA,
  RouterPersistence,
  effectiveStateFile,
  restoreProviderTelemetrySection,
  setDefaultPersistenceManager,
} from "../src/router/persistence.ts";
import {
  UNATTRIBUTED_DIMENSION,
  MAX_UNKNOWN_WORKSPACE_IDS,
  emptyUsageBucket,
  usageOrigin,
  usageKey,
  safeWorkspaceId,
  safeAgentIdentity,
  safePrivacyWorkspace,
  extractWorkspaceIdWithAmbiguity,
  readNamedAttribute,
  toolServerAttribute,
  toolNameAttribute,
  toolKey,
  formatWorkspaceTools,
  formatWorkspaceSkills,
  formatWorkspaceMcpExposed,
  formatWorkspaceMcpUses,
  restoreUsageBucket,
  usageBucket,
  workspaceBucket,
  workspaceMcpBucket,
  workspaceToolBucket,
  workspaceSkillBucket,
  workspaceDimensionBuckets,
  matchesProjectedAgent,
  usageSnapshot,
  UsageTracker,
  getDefaultUsageTracker,
  setDefaultUsageTracker,
  usageTelemetry,
  inFlightUsage,
  workspaceIdRegistry,
  workspaceIdConflicts,
  attributionDiagnostics,
  registerWorkspaceId,
  attributionDiagnosticsStatus,
  resetAttributionDiagnostics,
  recordUsageEvent,
  projectLiveAgents,
  canonicalLiveAgentCount,
  countLiveAgentActivity,
  usageStatus,
  usagePersistenceSnapshot,
  restoreUsagePersistenceSnapshot,
  resetUsageTelemetry,
  clearWorkspaceCapabilities,
} from "../src/router/usage.ts";
import {
  OtelTracker,
  getDefaultOtelTracker,
  setDefaultOtelTracker,
  otelTelemetry,
  otelMetricSeries,
  pendingMcpModelAttribution,
  mcpServer,
  telemetryConversationId,
  resolveTelemetryContext,
  ingestOtelLogs,
  ingestOtelTraces,
  ingestOtelMetrics,
  ingestOtelSignal,
  recordBridgeToolObservation,
  recordMcpExposure,
  recordBridgeMcpExposure,
  recordBridgeSkillExposure,
  recordBridgeSkillUsed,
  resetOtelTelemetry,
  codexTelemetryStatus,
  otelPersistenceSnapshot,
  restoreOtelTelemetry,
  autodevEnrichOtlpPayload,
  isAutodevAttributesEnabled,
  OTEL_HEALTH_TTL_MS,
  OTEL_PERSISTENCE_SCHEMA_VERSION,
} from "../src/router/otel.ts";

const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_MODEL_ROUTER_PORT ?? "4100", 10);
const CODEX_HOME = process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;
const AUTH_FILE = process.env.CODEX_ROUTER_AUTH_FILE ?? `${CODEX_HOME}/auth.json`;
const CATALOG_FILE = process.env.CODEX_ROUTER_CATALOG_FILE ?? `${CODEX_HOME}/codex-model-catalog.json`;
const DASHBOARD_FILE = new URL("./codex-model-router-dashboard.html", import.meta.url);
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const STATE_FILE = effectiveStateFile();
const CODEX_STATE_DB_PATH = process.env.CODEX_STATE_DB_PATH ?? `${CODEX_HOME}/state_5.sqlite`;
// The collector is read-only: it never writes to the Codex-owned
// state_5.sqlite file or any other path inside $CODEX_HOME. Its derived
// snapshot is held in this process and surfaced through /status as
// `codexState`. A live poll is started only when the router is the
// main module, so test imports do not spin up an interval timer.
const codexState = {
  collector: new CodexStateCollector(loadCodexStateCollectorConfig()),
  lastSnapshot: null,
  livePollStarted: false,
};
async function refreshCodexState() {
  try {
    codexState.lastSnapshot = await codexState.collector.collectSnapshot();
  } catch (error) {
    codexState.lastSnapshot = {
      localTelemetry: {
        status: "error",
        pathConfigured: true,
        reason: error instanceof Error ? error.message : String(error),
        collectedAt: new Date().toISOString(),
      },
    };
  }
}
const EXECUTION_CONTRACT_FILE = process.env.CODEX_EXECUTION_CONTRACT_FILE
  ?? (existsSync(new URL('./codex/execution-contract.json', import.meta.url).pathname)
    ? new URL('./codex/execution-contract.json', import.meta.url).pathname
    : (existsSync(`${CODEX_HOME}/hooks/codex/execution-contract.json`)
      ? `${CODEX_HOME}/hooks/codex/execution-contract.json`
      : new URL('./codex/execution-contract.json', import.meta.url).pathname));
const EXECUTION_CONTRACT = JSON.parse(readFileSync(EXECUTION_CONTRACT_FILE, 'utf8'));
function positiveDuration(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
const activeProviderRequests = new Map();
// Read once at module load, matching every other env-derived constant here;
// a test that needs a different TTL builds its own tracker with
// createAgentActivityTracker({ ttlMs }) rather than mutating this one.
const AGENT_ACTIVITY_TTL_MS = resolveAgentActivityTtlMs(process.env);
const agentActivity = createAgentActivityTracker({ ttlMs: AGENT_ACTIVITY_TTL_MS });
getDefaultUsageTracker().setActivityTracker(agentActivity);
const ROUTER_STARTED_AT = new Date().toISOString();
const ROUTER_INSTANCE_ID = randomUUID();
// Router lifecycle: "ready" accepts new response requests; "draining" rejects
// them with a structured 503 while existing requests get a bounded time to
// finish. Liveness probes remain unconditional 200 regardless of state.
const routerLifecycle = new RouterLifecycle({
  startedAt: ROUTER_STARTED_AT,
  drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
  routerInstanceId: ROUTER_INSTANCE_ID,
});
setDefaultRouterLifecycle(routerLifecycle);
const MAX_RECENT_EVENTS = Number.parseInt(process.env.CODEX_ROUTER_MAX_RECENT_EVENTS ?? "100", 10);
const routerEvents = new RouterEventRecorder({
  maxRecentEvents: MAX_RECENT_EVENTS,
  routerInstanceId: ROUTER_INSTANCE_ID,
  resolveOrigin: (role, provider) => usageOrigin(role, provider),
  onEvent: (event, input, effectiveOrigin) => {
    const workspaceContext = typeof input.workspace === "string" ? { key: input.workspace, cwd: null } : (input.workspace ?? null);
    if (event.provider && event.model && ["selected", "skipped", "result"].includes(event.phase)) {
      recordUsageEvent({
        phase: event.phase,
        requestId: event.requestId,
        role: event.role,
        provider: event.provider,
        model: event.model,
        workspace: workspaceContext,
        outcome: event.outcome,
        failureClass: event.failureClass,
        status: event.status,
        elapsedMs: event.elapsedMs,
        toolCalls: event.toolCalls,
        timestamp: event.timestamp,
        origin: effectiveOrigin ?? usageOrigin(event.role, event.provider),
      });
    }
    // Any CLI child still open under this request ends with it; see
    // closeBridgeSubagentsForRequest.
    if (event.phase === "result") closeBridgeSubagentsForRequest(event.requestId, event.outcome, event.elapsedMs);
    const state = event.provider ? providerState(event.provider) : null;
    if (state && event.phase === "selected") {
      state.attempts += 1;
      state.lastAttemptAt = event.timestamp;
    } else if (state && event.phase === "skipped") {
      state.skipped += 1;
      state.lastFailureClass = event.failureClass;
    } else if (state && event.phase === "result") {
      if (event.outcome === "success") {
        state.successes += 1;
        state.lastSuccessAt = event.timestamp;
        state.lastFailureClass = null;
        state.lastFailure = null;
      } else {
        state.failures += 1;
        state.lastFailureAt = event.timestamp;
        state.lastFailureClass = event.failureClass;
        state.lastFailure = { timestamp: event.timestamp, class: event.failureClass, status: event.status };
      }
    }
    scheduleRouterStatePersist();
  },
});
setDefaultRouterEventRecorder(routerEvents);
const subagentRegistry = new SubagentRegistry({
  agentActivity,
  executionContract: EXECUTION_CONTRACT,
  onRecordRouterEvent: (event) => recordRouterEvent(event),
  onRecordUsageEvent: (event) => recordUsageEvent(event),
  onSchedulePersist: () => scheduleRouterStatePersist(),
  onMissingProviderDiagnostic: (count) => { attributionDiagnostics.byReason.missing_provider += count; },
  onMissingModelDiagnostic: (count) => { attributionDiagnostics.byReason.missing_model += count; },
  getCodexNativeSpawns: () => otelTelemetry.threads.spawns.total,
  getSpawnCapableProviders: () => Object.keys(ROUTING.providers).filter((provider) => providerCapabilities(provider, EXECUTION_CONTRACT).subagentSpawn),
});
setDefaultSubagentRegistry(subagentRegistry);
const subagentTelemetry = subagentRegistry.subagentTelemetry;
const spawnFailureTelemetry = subagentRegistry.spawnFailureTelemetry;
const bridgeRequestContext = {
  get: (id) => subagentRegistry.getBridgeRequestContext(id),
  set: (id, val) => subagentRegistry.noteBridgeRequest(id, val),
};
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

const otelTracker = new OtelTracker({
  healthTtlMs: OTEL_HEALTH_TTL_MS,
  usageTracker: getDefaultUsageTracker(),
  getConversationThread: (id) => codexState.lastSnapshot?.conversationThreads?.[id] ?? null,
  getBridgeRequestContext: (id) => subagentRegistry.getBridgeRequestContext(id),
  onSchedulePersist: () => scheduleRouterStatePersist(),
});
setDefaultOtelTracker(otelTracker);

const CODEX_CONFIG_FILE = process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ?? `${CODEX_HOME}/config.toml`;
const concurrencyManager = new ConcurrencyManager({
  agentActivity,
  configFile: CODEX_CONFIG_FILE,
  configSource: process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ? "env_override" : "default_codex_home",
});
setDefaultConcurrencyManager(concurrencyManager);

function effectivePerSessionLimit() {
  return concurrencyManager.effectivePerSessionLimit();
}

function activeSubagentThreads(at) {
  return concurrencyManager.activeSubagentThreads(at);
}

function tryAcquireSubagentSlot(sessionKey) {
  return concurrencyManager.tryAcquireSubagentSlot(sessionKey);
}

function releaseSubagentSlot(sessionKey) {
  concurrencyManager.releaseSubagentSlot(sessionKey);
}

function touchOpenSubagentSlots(sessionKey) {
  concurrencyManager.touchOpenSubagentSlots(sessionKey);
}

function resetConcurrencyTelemetry() {
  concurrencyManager.resetConcurrencyTelemetry();
}

function concurrencyStatus(at = Date.now()) {
  return concurrencyManager.concurrencyStatus(at);
}


/**
 * Derive the frozen `status.agents` reconciliation projection evaluated at
 * `at`. The dashboard and `getRouterStatus(now)` consume this exact shape;
 * see `tests/fixtures/contracts/agent-reconciliation-contract.json` for the
 * complete contract.
 *
 * `status.agents` is the canonical home for live-agent reconciliation:
 *   - `canonicalLiveCount` is the single live-agent count the dashboard's
 *     `Active agents` KPI reads -- `projection.canonicalTotal` evaluated at
 *     the same `at` the rest of the status payload was evaluated at.
 *   - `byState` is the full tracker state histogram including stale and
 *     terminal states, so an operator can see the activity backlog.
 *   - `liveBy*` partitions only count live (`AGENT_ACTIVITY_KINDS`) records
 *     and never include held `subagent_slot` admission bookkeeping.
 *   - `liveByProvider` / `liveByModel` include only concrete routed values;
 *     missing provider/model records are omitted from those maps and counted
 *     separately by `missingProvider` / `missingModel`.
 *   - `liveByRole`, `liveByOrigin`, and `liveByWorkspace` retain the
 *     `unattributed` residual as an explicit bucket.
 *   - `missingProvider` / `missingModel` are diagnostic counts of live
 *     agents that lack an attributed provider or model -- a known defect
 *     class already surfaced through `liveAgentAttribution`.
 *   - `slotVsAgent` reconciles the agent-tracking and admission-slot
 *     counters in one place so `status.agents` and `status.concurrency`
 *     can be compared directly:
 *       - `agentLive`           = projection.canonicalTotal
 *       - `admissionSlots`      = active subagent_slot count held anywhere
 *       - `activeAdmissionSessions` = distinct session-key tags holding
 *         admission slots
 *       - `processFallbackActiveThreads` = the shared process-fallback
 *         admission count (subset of `admissionSlots`)
 *   - `reconciledWithConcurrency` flags that the helper evaluated the
 *     agent tracker, the slot tracker, and the stale/terminal sweep at
 *     the same `at`, so downstream readers do not need to re-time the
 *     two projections themselves.
 */
function agentsStatus(at = Date.now()) {
  const projection = projectLiveAgents(at);
  const liveAgents = projection.allLiveAgents;
  const byState = agentActivity.snapshot(at).byState;
  const liveByKind = {};
  const liveByRole = {};
  const liveByOrigin = {};
  const liveByProvider = {};
  const liveByModel = {};
  const liveByWorkspace = {};
  for (const agent of liveAgents) {
    const kind = agent.kind ?? "session";
    liveByKind[kind] = (liveByKind[kind] ?? 0) + 1;
    if (agent.provider) liveByProvider[agent.provider] = (liveByProvider[agent.provider] ?? 0) + 1;
    if (agent.provider && agent.model) {
      const modelKey = agent.model.startsWith(`${agent.provider}/`) ? agent.model : `${agent.provider}/${agent.model}`;
      liveByModel[modelKey] = (liveByModel[modelKey] ?? 0) + 1;
    }
    const rKey = agent.role ?? UNATTRIBUTED_DIMENSION;
    liveByRole[rKey] = (liveByRole[rKey] ?? 0) + 1;
    const oKey = agent.origin ?? UNATTRIBUTED_DIMENSION;
    liveByOrigin[oKey] = (liveByOrigin[oKey] ?? 0) + 1;
    const wKey = agent.workspace ?? UNATTRIBUTED_DIMENSION;
    liveByWorkspace[wKey] = (liveByWorkspace[wKey] ?? 0) + 1;
  }
  // Provider/model dimensions reserve themselves for concrete routed
  // values: a missing provider/model is a diagnostic surfaced separately
  // (missingProvider / missingModel), never a bucket in the live-by map.
  return {
    schema: "autodev-agent-status-v1",
    canonicalLiveCount: projection.canonicalTotal,
    byState,
    liveByKind,
    liveByRole,
    liveByOrigin,
    liveByProvider,
    liveByModel,
    liveByWorkspace,
    missingProvider: projection.missingProvider,
    missingModel: projection.missingModel,
    slotVsAgent: {
      agentLive: projection.canonicalTotal,
      admissionSlots: agentActivity.countLive({ kind: SUBAGENT_SLOT_KIND }, at),
      activeAdmissionSessions: agentActivity.distinctTags({ kind: SUBAGENT_SLOT_KIND }, at).length,
      processFallbackActiveThreads: agentActivity.countLive({ kind: SUBAGENT_SLOT_KIND, tag: PROCESS_FALLBACK_SESSION_KEY }, at),
    },
    reconciledWithConcurrency: true,
  };
}

function recordConcurrencyDenial(denial) {
  concurrencyManager.recordConcurrencyDenial(denial);
  const info = typeof denial === "string" ? { reason: denial } : (denial ?? {});
  recordSpawnFailure({
    requestId: info.requestId ?? null,
    role: info.role ?? null,
    requestedModel: info.requestedModel ?? null,
    reason: info.reason ?? "unknown",
  });
  recordRouterEvent({
    phase: "denied",
    requestId: info.requestId ?? null,
    role: info.role ?? null,
    requestedModel: info.requestedModel ?? null,
    provider: null,
    model: null,
    failureClass: "concurrency_limit",
    denialReason: info.reason ?? "unknown",
  });
}



// Ingests a provider bridge's report that its CLI invoked a subagent spawn
// tool. Only reports naming a request id this router actually issued are
// counted; anything else is a caller that never served a router request.
const INGESTED_AGENT_EVENTS = new Set(["subagent_spawn", "subagent_result", "subagent_tools_unavailable", "tool_executed", "tool_requested", "tool_unavailable", "skill_exposed", "skill_used", "mcp_exposed", "activity", "heartbeat"]);

// States a bridge may report directly over the agent-events channel. This is
// deliberately narrower than AGENT_ACTIVITY_STATES: "active" and "stale" are
// derived by the router itself (from a request being served, and from the
// TTL) and are never something an external report can set.
const REPORTABLE_AGENT_ACTIVITY_STATES = new Set(["tool_wait", "user_wait", "subagent_wait", "resumed", "finished", "failed", "heartbeat"]);



function ingestAgentEvents(payload) {
  const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
  let context = requestId ? bridgeRequestContext.get(requestId) : undefined;
  // A Codex hook (PreToolUse) only carries a session id; resolve it to the
  // active parent request's context when one is open. Sessions with no
  // open request are rejected so a hook running between turns (or on a
  // session the router never served) cannot invent an unattributed
  // workspace row.
  if (!context && requestId) {
    const sessionKey = requestId;
    const sessionContext = lookupBridgeSessionContext(sessionKey);
    const sessionRequestId = recallBridgeSessionRequestId(sessionKey);
    if (sessionContext && sessionRequestId) {
      context = sessionContext;
    }
  }
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
    if (event.type === "tool_executed" || event.type === "tool_requested" || event.type === "tool_unavailable") {
      recordBridgeToolObservation({ event, context });
      const subject = context.sessionKey || `req:${requestId}`;
      agentActivity.touch(subject);
      if (context.sessionKey) touchOpenSubagentSlots(context.sessionKey);
      continue;
    }
    if (event.type === "skill_exposed") {
      recordBridgeSkillExposure({ event, context });
      continue;
    }
    if (event.type === "skill_used") {
      if (recordBridgeSkillUsed({ event, context })) accepted += 1;
      continue;
    }
    if (event.type === "mcp_exposed") {
      recordBridgeMcpExposure({ event, context, requestId });
      continue;
    }
    if (event.type === "heartbeat" || (event.type === "activity" && (event.state === "heartbeat" || event.state?.trim?.() === "heartbeat"))) {
      const subject = context.sessionKey || `req:${requestId}`;
      agentActivity.touch(subject);
      if (context.sessionKey) touchOpenSubagentSlots(context.sessionKey);
      accepted += 1;
      continue;
    }
    if (event.type === "activity") {
      // A CLI-delegated turn can tell the router things the response stream
      // never carries: that it is now waiting on its human, that a spawned
      // subagent it drove itself has reported back, or that the whole
      // activity is done. Normalized to the same subject convention every
      // router-driven begin/end uses, so a bridge report and a router-seen
      // continuation update the same record instead of two disagreeing ones.
      const state = typeof event.state === "string" ? event.state.trim() : "";
      if (!REPORTABLE_AGENT_ACTIVITY_STATES.has(state)) {
        rejected += 1;
        continue;
      }
      const subject = context.sessionKey || `req:${requestId}`;
      const activityRole = context.role ?? (context.provider === "codex" ? "orchestrator" : null);
      const eventId = typeof event.eventId === "string" && event.eventId.trim() ? event.eventId.trim() : null;
      if (agentActivity.applyLifecycleEvent(subject, { state, eventId, provider: context.provider, model: context.model, role: activityRole, origin: activityRole === "orchestrator" ? "orchestrator" : (context.role ? "subagent" : "direct"), workspace: context.workspace })) accepted += 1;
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

ROUTING_POLICY.setRuntime({
  providerFailureStreak: (provider) => COOLDOWNS.failureStreak(provider),
  liveProviderCount: (provider) => countLiveAgentActivity({ provider }),
});
COOLDOWNS.setRuntime({
  isProviderEnabled: (provider) => ROUTING_POLICY.isProviderEnabled(provider),
  isKnownProvider: (provider) => Object.hasOwn(ROUTING.providers, provider),
  lastFailureClass: (provider) => providerState(provider).lastFailureClass,
});
setUpstreamShapeHooks({
  dropUnresolvableReasoning: (input) => {
    const result = dropUnresolvableReasoning(input);
    return { input: result.input, dropped: result.dropped };
  },
  normalizeInputItemIds: (input) => {
    const result = normalizeInputItemIds(input);
    return { input: result.input, changed: result.changed };
  },
  shouldNormalizeItemIds: true,
  shouldDropUnresolvableReasoning: true,
  shouldNormalizeItemIds: true,
  recordEvent: (event) => {
    if (typeof event.requestId !== 'string' || event.requestId.length === 0) return;
    recordRouterEvent({
      phase: event.phase,
      requestId: event.requestId ?? null,
      requestedModel: event.requestedModel ?? null,
      provider: event.provider ?? null,
      model: event.model ?? null,
      droppedReasoningItems: event.droppedReasoningItems,
      normalizedItemIds: event.normalizedItemIds,
    });
  },
});

function recordRouterEvent(input) {
  return routerEvents.record(input);
}

function resetRouterTelemetry() {
  routerEvents.clear();
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
  resetSpawnFailureTelemetry();
  COOLDOWNS.clearAll();
  scheduleRouterStatePersist();
}

function routingStatus() {
  return {
    configSource: process.env.CODEX_ROUTER_CONFIG_FILE ? "env_override" : "default_codex_home",
    configFileExists: existsSync(ROUTING_CONFIG_FILE),
    orchestrator: {
      alias: ORCHESTRATOR_ALIAS,
      tier: ORCHESTRATOR_TIER,
      reasoningEffort: { ...ORCHESTRATOR_REASONING_EFFORT },
    },
    roles: { ...ROUTING.roles },
    providerGroups: { ...ROUTING.providerGroups },
    priorities: Object.fromEntries(ROUTES.map((route) => {
      const tierPrios = {};
      for (const [tier, groups] of Object.entries(ROUTING.providerGroups)) {
        if (Array.isArray(groups)) {
          for (let gIdx = 0; gIdx < groups.length; gIdx++) {
            const group = groups[gIdx];
            if (Array.isArray(group) && group.some((name) => name.toLowerCase() === route.provider.toLowerCase())) {
              tierPrios[tier] = `P${gIdx + 1}`;
              break;
            }
          }
        }
      }
      return [route.provider, tierPrios];
    })),
    configuredProviders: Object.keys(ROUTING.providers),
    enabledProviders: Object.keys(ROUTING.providers).filter((p) => ROUTING_POLICY.isProviderEnabled(p)),
    disabledProviders: ROUTING_POLICY.runtimeState().disabledProviders,
    routes: Object.fromEntries(ROUTES.map((route) => [
      route.provider,
      {
        pattern: route.pattern instanceof RegExp ? route.pattern.source : String(route.pattern),
        baseUrl: route.baseUrl,
        healthUrl: route.healthUrl ?? null,
        envKey: route.envKey ?? null,
        credentialConfigured: ROUTING_POLICY.routeCredentialAvailable(route),
      },
    ])),
  };
}

function limitsStatus() {
  return {
    providerCooldownMs: COOLDOWN_CONFIG.providerCooldownMs,
    providerCooldownMaxMs: COOLDOWN_CONFIG.providerCooldownMaxMs,
    hardCooldownMs: COOLDOWN_CONFIG.hardCooldownMs,
    hardCooldownMaxMs: COOLDOWN_CONFIG.hardCooldownMaxMs,
    probeCooldownMs: COOLDOWN_CONFIG.probeCooldownMs,
    probeCooldownMaxMs: COOLDOWN_CONFIG.probeCooldownMaxMs,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    lastResortMaxAttempts: LAST_RESORT_MAX_ATTEMPTS,
    exhaustionWaitMs: EXHAUSTION_WAIT_MS,
    chainSelectionDeadlineMs: CHAIN_SELECTION_DEADLINE_MS,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    concreteRetryBaseMs: CONCRETE_RETRY_BASE_MS,
    concreteRetryMaxMs: CONCRETE_RETRY_MAX_MS,
    concreteStatusMaxAttempts: CONCRETE_STATUS_MAX_ATTEMPTS,
    concreteTransportMaxAttempts: CONCRETE_TRANSPORT_MAX_ATTEMPTS,
    shutdownDrainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
    maxConcurrentThreadsPerSession: effectivePerSessionLimit(),
  };
}

function getRouterStatus(now = Date.now()) {
  const projection = projectLiveAgents(now);
  const providers = Object.fromEntries(ROUTES.map((route) => {
    const state = providerState(route.provider);
    const cooldown = COOLDOWNS.get(route.provider, now);
    const inFlightRequests = getActiveRequests(route.provider);
    const active = projection.byProvider[route.provider] ?? 0;
    const coolingDown = cooldown !== null;
    const enabled = ROUTING_POLICY.isProviderEnabled(route.provider);
    const tierPrios = [];
    for (const [tier, groups] of Object.entries(ROUTING.providerGroups)) {
      if (Array.isArray(groups)) {
        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
          const group = groups[gIdx];
          if (Array.isArray(group) && group.some((name) => name.toLowerCase() === route.provider.toLowerCase())) {
            tierPrios.push(`${tier}: P${gIdx + 1}`);
            break;
          }
        }
      }
    }
    return [route.provider, {
      enabled,
      status: !enabled ? "disabled" : (coolingDown ? (cooldown.failureClass ?? state.lastFailureClass ?? "cooldown") : "ready"),
      routingPriority: tierPrios.length ? tierPrios.join(" · ") : "—",
      limits: {
        cooldownKind: coolingDown ? cooldown.kind : null,
        cooldownFailureClass: coolingDown ? cooldown.failureClass ?? null : null,
        cooldownResetsAt: coolingDown ? cooldown.resetsAt ?? null : null,
        cooldownUntil: coolingDown ? new Date(cooldown.until).toISOString() : null,
        cooldownRemainingMs: coolingDown ? cooldown.until - now : 0,
        lastResortEligible: coolingDown ? COOLDOWNS.allowsLastResort(cooldown, now) : true,
      },
      active,
      inFlightRequests,
      cooldownUntil: coolingDown ? new Date(cooldown.until).toISOString() : null,
      cooldownRemainingMs: coolingDown ? cooldown.until - now : 0,
      // Which policy is holding this provider back, and whether it can still be
      // tried as a last resort when every candidate is cooling at once.
      cooldownKind: coolingDown ? cooldown.kind : null,
      cooldownFailureClass: coolingDown ? cooldown.failureClass ?? null : null,
      cooldownResetsAt: coolingDown ? cooldown.resetsAt ?? null : null,
      lastResortEligible: coolingDown ? COOLDOWNS.allowsLastResort(cooldown, now) : true,
      failureStreak: COOLDOWNS.failureStreak(route.provider) ?? 0,
      probeFailureStreak: COOLDOWNS.probeFailureStreak(route.provider) ?? 0,
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
    schema: "autodev-router-status-v2",
    router: "codex-model-router",
    routerInstanceId: ROUTER_INSTANCE_ID,
    startedAt: ROUTER_STARTED_AT,
    pid: process.pid,
    // The absolute state-file path is never surfaced on /status (a public,
    // unauthenticated endpoint); operators only need to know whether an
    // override is in play, whether the file is actually there, and when it
    // was last written.
    telemetryPersistence: {
      enabled: IS_MAIN,
      source: process.env.CODEX_ROUTER_STATE_FILE ? "env_override" : "default_codex_home",
      exists: existsSync(effectiveStateFile()),
      updatedAt: routerPersistence.getUpdatedAt(),
    },
    authentication: authStatus(),
    routing: routingStatus(),
    limits: limitsStatus(),
    disabledProviders: ROUTING_POLICY.runtimeState().disabledProviders,
    usage: usageStatus(now, projection),
    attributionDiagnostics: attributionDiagnosticsStatus(),
    liveAgentAttribution: {
      missingProvider: projection.missingProvider,
      missingModel: projection.missingModel,
    },
    codexTelemetry: codexTelemetryStatus(),
    // status.agents and status.concurrency share the same `now` so the two
    // projections describe the same instant: agentsStatus(now) and
    // concurrencyStatus(now) both pass it through to the tracker so slot
    // counts and the stale/terminal sweep agree with live agents.
    agents: agentsStatus(now),
    concurrency: concurrencyStatus(now),
    subagents: subagentStatus(),
    spawnFailures: spawnFailureStatus(),
    // Transport-layer counters only: how many upstream calls are literally
    // open right now, per provider. This is distinct from usage.activity,
    // which also covers the gaps between requests (tool_wait/user_wait/
    // subagent_wait) that this counter cannot see.
    inFlightRequests: Object.fromEntries(activeProviderRequests),
    // Total live agent activity (spans request gaps), independent of role/
    // provider dimension -- the same count usage.activity.live reports.
    // The dashboard's canonical KPI count comes from
    // status.agents.canonicalLiveCount; this existing top-level field remains
    // emitted for status consumers while the dashboard uses the frozen agent
    // projection directly.
    liveActivity: projection.canonicalTotal,
    providers,
    recentEvents: routerEvents.getRecentEvents(true),
    codexState: codexStateStatus(),
  };
}

function setCodexStateSnapshotForTests(snapshot) {
  codexState.lastSnapshot = snapshot && typeof snapshot === "object" ? snapshot : null;
}

function codexStateStatus() {
  const snapshot = codexState.lastSnapshot;
  if (!snapshot) {
    return {
      localTelemetry: {
        status: "pending",
        pathConfigured: true,
        schema: null,
        capabilities: { tables: {}, columnCount: 0 },
        threadCount: 0,
        projectCount: 0,
        edgeCount: 0,
        collectedAt: null,
        reason: "collector_initializing",
      },
    };
  }
  const { path: _path, ...safeLocalTelemetry } = snapshot.localTelemetry ?? {};
  return {
    localTelemetry: { ...safeLocalTelemetry, pathConfigured: Boolean(snapshot.localTelemetry?.path) },
    recentThreads: snapshot.recentThreads,
    projects: snapshot.projects,
    conversationThreads: snapshot.conversationThreads,
    spawnEdges: snapshot.spawnEdges,
    schema: snapshot.schema,
  };
}
const routerPersistence = new RouterPersistence({
  stateFile: () => effectiveStateFile(),
  isMain: IS_MAIN,
  debounceMs: 500,
  getSnapshot: () => ({
    disabledProviders: ROUTING_POLICY.runtimeState().disabledProviders,
    providerTelemetry: Object.fromEntries(providerTelemetry),
    usage: usagePersistenceSnapshot(),
    concurrency: concurrencyManager.telemetry,
    subagents: {
      total: subagentTelemetry.total,
      byMechanism: subagentTelemetry.byMechanism,
      byProvider: subagentTelemetry.byProvider,
      byRole: subagentTelemetry.byRole,
      byStatus: subagentTelemetry.byStatus,
      recent: subagentTelemetry.recent,
    },
    spawnFailures: spawnFailureTelemetry,
    providerCooldowns: COOLDOWNS.persistedHardEntries(),
    recentEvents: routerEvents.getRecentEvents(false),
    otelTelemetry: otelPersistenceSnapshot(),
  }),
  restoreSection: (section, value, parsed) => {
    if (section === "providerTelemetry") {
      restoreProviderTelemetrySection(providerTelemetry, value);
    } else if (section === "usage") {
      restoreUsagePersistenceSnapshot(value);
    } else if (section === "concurrency" && value && typeof value === "object") {
      concurrencyManager.restoreTelemetry(value);
    } else if (section === "spawnFailures" && value && typeof value === "object") {
      subagentRegistry.restoreSpawnFailureTelemetry(value);
    } else if (section === "otelTelemetry") {
      restoreOtelTelemetry(value);
    } else if (section === "subagents" && value && typeof value === "object") {
      subagentRegistry.restoreSubagentTelemetry(value);
    } else if (section === "providerCooldowns" && Array.isArray(value)) {
      COOLDOWNS.restoreHardEntries(value, Date.now());
    } else if (section === "disabledProviders") {
      ROUTING_POLICY.restoreRuntimeState({ disabledProviders: value });
    } else if (section === "recentEvents" && Array.isArray(value)) {
      routerEvents.restore(value);
      if (!parsed.usage) {
        resetUsageTelemetry();
        for (const event of routerEvents.getRecentEvents()) {
          if (event.provider && event.model && event.phase) recordUsageEvent(event);
        }
        inFlightUsage.clear();
      }
    }
  },
});
setDefaultPersistenceManager(routerPersistence);

function serializeRouterState() {
  return routerPersistence.serialize();
}

function loadRouterState(file = effectiveStateFile()) {
  return routerPersistence.load(file);
}

function persistRouterStateNow(file = effectiveStateFile()) {
  return routerPersistence.persistNow(file);
}

function scheduleRouterStatePersist() {
  routerPersistence.schedulePersist();
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
  // Take the first snapshot synchronously after restore so /status does not
  // return a "pending" envelope once the router has finished booting, and
  // start the debounced live poll that keeps it fresh.
  void refreshCodexState();
  if (!codexState.livePollStarted) {
    codexState.collector.startLivePoll();
    codexState.livePollStarted = true;
  }
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
  return routerLifecycle.isDraining();
}

function getLifecycleStatus() {
  return routerLifecycle.getLifecycleStatus();
}

function registerActiveRequest(abortController) {
  routerLifecycle.registerActiveRequest(abortController);
}

function unregisterActiveRequest(abortController) {
  routerLifecycle.unregisterActiveRequest(abortController);
}

function abortActiveResponseRequests() {
  routerLifecycle.abortActiveResponseRequests();
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
  routerLifecycle.setLifecycleState(next);
}

async function beginShutdown(signal, server, stateFile = effectiveStateFile()) {
  return routerLifecycle.beginShutdown({
    signal,
    server,
    persistState: () => persistRouterStateNow(stateFile),
    drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
    routerInstanceId: ROUTER_INSTANCE_ID,
  });
}

function resetLifecycleForTests() {
  routerLifecycle.resetLifecycleForTests();
}

/**
 * True when Codex is handing back the result of a tool call the provider made
 * on a previous request, which makes this the continuation of that turn.
 */
function carriesPendingToolResult(payload) {
  for (const item of Array.isArray(payload?.input) ? payload.input : []) {
    if (item?.type === "custom_tool_call_output" || item?.type === "function_call_output") return true;
  }
  return false;
}

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

async function writeResponseStream(response, upstream, publicModel, signal = null, onHeartbeat = null) {
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
    // The wire is still producing bytes for this turn -- a live heartbeat,
    // not a new transition -- so the caller's activity record must not go
    // stale out from under a genuinely long single turn (a slow model, a
    // large output) that simply outlasts the TTL between its begin and end.
    onHeartbeat?.();
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
  const streamResult = () => ({
    toolCalls,
    failed: terminal === "completed" ? false : true,
    incompleteReason,
    limit: reportedLimit,
    inputRequired: incompleteReason === "input_required" || incompleteReason === "requires_action",
  });
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

function mcpContractForRole(agentRole) {
  return subagentMcpContractForRole(agentRole, EXECUTION_CONTRACT);
}

function recordNativeMcpExposure({ route, agentRole, workspace, requestId, sessionKey }) {
  if (route?.provider !== "codex") return;
  const context = {
    provider: route.provider,
    model: route.model,
    role: agentRole === ORCHESTRATOR_AGENT_ROLE ? "orchestrator" : (agentRole ?? "default"),
    workspace: workspace?.key ?? UNATTRIBUTED_DIMENSION,
    agent: sessionKey ?? UNATTRIBUTED_DIMENSION,
    sessionKey,
  };
  for (const server of mcpContractForRole(agentRole)) {
    recordMcpExposure({ server, source: "role_contract", context, requestId });
  }
}

function bridgeTelemetryHeaders(route, requestId) {
  return subagentBridgeTelemetryHeaders(route, requestId, { executionContract: EXECUTION_CONTRACT, agentEventsUrl: AGENT_EVENTS_URL });
}

function downstreamHeaders(route, auth, turnMetadataHeader, agentRole = null, requestId = null, session = null) {
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
  // Codex serves its own children directly and never needs to be told which
  // conversation it is in, so this goes only to the bridges that do.
  if (session?.key && route.provider !== "codex") {
    headers[SESSION_ID_HEADER] = session.key;
    headers[SESSION_SCOPE_HEADER] = session.scope ?? "identified";
  }
  return headers;
}

async function fetchUpstream(route, payload, wantsStream, turnMetadataHeader, clientSignal = null, agentRole = null, requestId = null, session = null) {
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
  const requestPayload = upstreamPayload(route, payload, wantsStream, requestId, undefined, { normalizeItemIds: providerCapabilities(route.provider).normalizeItemIds });
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = clientSignal ? AbortSignal.any([clientSignal, timeoutSignal]) : timeoutSignal;
  const upstream = await fetch(`${route.baseUrl}/responses`, {
    method: "POST",
    headers: downstreamHeaders(route, auth, turnMetadataHeader, agentRole, requestId, session),
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

async function writeSuccessfulResponse(response, route, result, wantsStream, publicModel, requestId, resolvedModel, onHeartbeat = null) {
  const responseHeaders = {
    "x-autodev-provider": route.provider,
    "x-autodev-model": resolvedModel,
    "x-autodev-request-id": requestId,
    "x-autodev-router-instance-id": ROUTER_INSTANCE_ID,
  };
  const upstream = result.upstream;
  if (wantsStream) {
    response.writeHead(upstream.status, { ...responseHeaders, "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache", connection: "close" });
    const streamResult = await writeResponseStream(response, upstream, publicModel, result.signal, onHeartbeat);
    if (!response.writableEnded && !response.destroyed && !response.closed) {
      try { response.end(); } catch {}
    }
    return streamResult;
  }
  const body = await upstream.text();
  const hasInputRequired = (parsed, incomplete) => parsed?.status === "requires_action"
    || parsed?.status === "input_required"
    || incomplete?.incompleteReason === "input_required"
    || incomplete?.incompleteReason === "requires_action";
  if (route.provider === "codex") {
    const toolCalls = countToolCallsFromSse(body);
    const parsed = rewriteResponseValue(responseTextFromSse(body), publicModel);
    sendJson(response, upstream.status, parsed, responseHeaders);
    const incomplete = incompleteFromResponse(parsed);
    return { toolCalls, failed: responseWasNotCompleted(parsed), ...incomplete, inputRequired: hasInputRequired(parsed, incomplete) };
  }
  try {
    const parsed = JSON.parse(body);
    const toolCalls = countToolCallsInResponse(parsed);
    const rewritten = rewriteResponseValue(parsed, publicModel);
    sendJson(response, upstream.status, rewritten, responseHeaders);
    const incomplete = incompleteFromResponse(rewritten);
    return { toolCalls, failed: responseWasNotCompleted(rewritten), ...incomplete, inputRequired: hasInputRequired(rewritten, incomplete) };
  } catch {
    response.writeHead(upstream.status, { ...responseHeaders, "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
    return { toolCalls: 0, failed: false, inputRequired: false };
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
  if (!ROUTING_POLICY.routeCredentialAvailable(route)) return false;
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

async function proxyConcreteResponse(response, route, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null, session = null) {
  // A direct concrete request's *activity* is still scoped to this one
  // request -- a pinned-model caller proves nothing about a later
  // continuation sharing the same session the way a role/orchestrator
  // request's session key does (see proxyFallbackChain). Its *session* is
  // still real, though, and is registered below so a bridge-side hook that
  // only knows the session id (skill-read telemetry, mcp_exposed, ...) can
  // still correlate back to this turn's provider/model/workspace.
  const activitySubject = `req:${requestId}`;
  if (!ROUTING_POLICY.isProviderEnabled(route.provider)) {
    recordRouterEvent({ phase: "skipped", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, failureClass: "provider_disabled" });
    recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 503, failureClass: "provider_disabled" });
    sendJson(
      response,
      503,
      errorBody(
        `Direct concrete request to ${payload.model} (${route.provider}) is unavailable because provider ${route.provider} is disabled.`,
        "router_provider_unavailable",
        { code: "router_provider_unavailable", retryable: false, failureClass: "provider_disabled", provider: route.provider, model: payload.model, requestId },
      ),
      {
        "x-autodev-provider": route.provider,
        "x-autodev-model": payload.model,
        "x-autodev-request-id": requestId,
      },
    );
    return;
  }
  const startedAt = Date.now();
  recordRouterEvent({ phase: "selected", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace });
  agentActivity.beginRequest(activitySubject, { requestId, provider: route.provider, model: payload.model, role: usageOrigin(null, route.provider) === "orchestrator" ? "orchestrator" : null, origin: usageOrigin(null, route.provider), workspace: workspace?.key ?? null });
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
    const retryAfterMs = retryable ? COOLDOWNS.nextRetryMs([route.provider]) : 0;
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
  const sessionKey = session?.key ?? null;
  const bridgeContext = { provider: route.provider, model: payload.model, role: null, workspace: workspace?.key ?? null, sessionKey };
  noteBridgeRequest(requestId, bridgeContext);
  // A Codex hook (PreToolUse) or a bridge-side session-scoped report (e.g.
  // skill-read telemetry) only knows the session id, never the request id a
  // direct concrete request was actually served under. Registering the same
  // context by session here -- exactly as proxyFallbackChain does for role
  // and orchestrator requests -- is what lets that report resolve back to
  // this turn's provider, model, and workspace instead of being dropped as
  // an unknown session.
  noteBridgeSession(sessionKey, { ...bridgeContext, requestId });
  recordNativeMcpExposure({ route, agentRole: null, workspace, requestId, sessionKey });
  try {
    while (attempts < maxAttempts) {
      try {
        const result = await fetchUpstream(route, payload, wantsStream, turnMetadataHeader, clientSignal, null, requestId, session);
        if (!result.ok) {
          const failureClass = classifyProviderFailure(result.status, result.body);
          const canRetry = result.retryable && attempts < CONCRETE_STATUS_MAX_ATTEMPTS - 1 && !clientSignal?.aborted && !response.headersSent;
          if (canRetry) {
            recordRouterEvent({ phase: "retry", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, status: result.status, failureClass, elapsedMs: Date.now() - startedAt });
            attempts += 1;
            await jitteredBackoff();
            if (clientSignal?.aborted) {
              recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 499, failureClass: "client_aborted", elapsedMs: Date.now() - startedAt });
              agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
              return;
            }
            continue;
          }
          recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: result.status, failureClass, elapsedMs: Date.now() - startedAt });
          agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
          if (result.retryable) COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass, result.limit));
          sendFailureResponse(result.status, failureClass);
          return;
        }
        const responseResult = await writeSuccessfulResponse(response, route, result, wantsStream, payload.model, requestId, payload.model, () => agentActivity.touch(activitySubject));
        recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: responseResult.failed ? "failure" : "success", status: result.upstream.status, failureClass: responseResult.failed ? "upstream_error" : null, elapsedMs: Date.now() - startedAt, toolCalls: responseResult.toolCalls });
        agentActivity.endRequest(activitySubject, { requestId, outcome: responseResult.failed ? "failure" : "success", hasToolCalls: responseResult.toolCalls > 0, inputRequired: Boolean(responseResult.inputRequired) });
        return;
      } catch (error) {
        logTransportError({ requestId, provider: route.provider, model: payload.model, error, workspace });
        if (error && typeof error === "object" && error.code === "router_auth_unavailable") {
          recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 401, failureClass: "authentication", elapsedMs: Date.now() - startedAt });
          agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
          sendFailureResponse(401, "authentication");
          return;
        }
        if (clientSignal?.aborted) {
          recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 499, failureClass: "client_aborted", elapsedMs: Date.now() - startedAt });
          agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
          return;
        }
        if (attempts < CONCRETE_TRANSPORT_MAX_ATTEMPTS - 1 && !response.headersSent) {
          const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
          recordRouterEvent({ phase: "retry", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, status: 502, failureClass, elapsedMs: Date.now() - startedAt });
          attempts += 1;
          await jitteredBackoff();
          if (clientSignal?.aborted) {
            recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 499, failureClass: "client_aborted", elapsedMs: Date.now() - startedAt });
            agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
            return;
          }
          continue;
        }
        const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
        recordRouterEvent({ phase: "result", requestId, requestedModel: payload.model, provider: route.provider, model: payload.model, workspace, outcome: "failure", status: 502, failureClass, elapsedMs: Date.now() - startedAt });
        agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
        COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass));
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
    agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
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
async function proxyFallbackChain(response, { candidates, role = null, origin = null, subject, agentRole = null, sessionKey = null, session = null }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null) {
  // The subject whose gap-spanning activity this call drives. A session key
  // is preferred (it is what lets a continuation on a *later* request find
  // the same record); an unidentified caller still gets a subject scoped to
  // this one request so provider/model activity is still observable.
  const activitySubject = sessionKey || `req:${requestId}`;
  if (!candidates || candidates.length === 0) {
    recordSpawnFailure({ requestId, role, requestedModel: payload.model, reason: "provider_exhausted" });
    closeBridgeSubagentsForRequest(requestId, "failure");
    recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: null, model: null, workspace, outcome: "failure", status: 503, failureClass: "provider_disabled" });
    sendJson(response, 503, errorBody(
      `No enabled providers available for ${subject}.`,
      "router_provider_exhausted",
      { code: "router_provider_exhausted", retryable: false, failureClass: "provider_disabled", model: payload.model, requestId }
    ), { "x-autodev-request-id": requestId });
    return;
  }
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
    const activityRole = role ?? ((origin ?? usageOrigin(role, route.provider)) === "orchestrator" ? "orchestrator" : null);
    agentActivity.beginRequest(activitySubject, { requestId, provider: route.provider, model: route.model, role: activityRole, origin: origin ?? usageOrigin(role, route.provider), workspace: workspace?.key ?? null });
    // The session just proved itself alive by starting a new attempt, which
    // is signal for any concurrency slot it is still holding too -- refresh
    // it here so the non-streaming response path (no keep-alive heartbeat)
    // also keeps a session's slots fresh.
    touchOpenSubagentSlots(sessionKey);
    // A bridge report names only the request id, so record which provider and
    // workspace this attempt resolved to before the upstream call begins.
    const bridgeContext = { provider: route.provider, model: route.model, role: role ?? (origin === "orchestrator" ? "orchestrator" : null), workspace: workspace?.key ?? null, sessionKey };
    noteBridgeRequest(requestId, bridgeContext);
    // A Codex hook (PreToolUse) only knows the session id, so also record the
    // same context keyed by it. The two maps stay in sync for the duration of
    // the parent request, and the session lookup is what lets a hook fire in
    // the middle of the turn submit a skill_used post that the router can
    // attribute to the turn's provider, model, role, and workspace.
    noteBridgeSession(sessionKey, { ...bridgeContext, requestId });
    recordNativeMcpExposure({ route, agentRole, workspace, requestId, sessionKey });
    if (agentRole === ORCHESTRATOR_AGENT_ROLE) noteOrchestratorSession(sessionKey, route.provider);
    incrementActiveRequests(route.provider);
    try {
      const result = await fetchUpstream(route, payloadForCandidate(payload, route), wantsStream, turnMetadataHeader, clientSignal, agentRole, requestId, session);
      if (result.ok) {
        try {
          const responseResult = await writeSuccessfulResponse(response, route, result, wantsStream, payload.model, requestId, route.model, () => {
            agentActivity.touch(activitySubject);
            touchOpenSubagentSlots(sessionKey);
          });
          if (responseResult.failed) {
            // A turn the provider closed as incomplete already said why, and for
            // a limit, until when. Cool it on what it reported rather than on a
            // generic upstream_error -- that report is the whole reason the
            // bridges now carry one.
            const failureClass = responseResult.limit?.limitClass ?? (responseResult.incompleteReason ? "unavailable" : "upstream_error");
            COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass, responseResult.limit));
            recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "failure", status: result.upstream.status, failureClass, elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls, selection });
            agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: responseResult.toolCalls > 0, inputRequired: Boolean(responseResult.inputRequired) });
            return "served";
          }
          COOLDOWNS.clear(route.provider);
          recordRouterEvent({ phase: "result", requestId, role, origin, requestedModel: payload.model, provider: route.provider, model: route.model, workspace, outcome: "success", status: result.upstream.status, elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls, selection });
          agentActivity.endRequest(activitySubject, { requestId, outcome: "success", hasToolCalls: responseResult.toolCalls > 0, inputRequired: Boolean(responseResult.inputRequired) });
        } catch (streamError) {
          COOLDOWNS.cooldownProvider(route.provider, cooldownFor("upstream_error"));
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
        agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
        return "terminal";
      }
      COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass, result.limit));
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
      COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass));
      if (response.headersSent) {
        // The stream already closed itself as incomplete on the way out of
        // writeResponseStream; this is the backstop for a throw that happened
        // anywhere else with headers already on the wire. Never leave a caller
        // holding a stream with no terminal event.
        if (!response.writableEnded) {
          try { response.write(responseFailureEvent(`Router could not complete ${subject}: ${failureClass}.`)); } catch {}
          response.end();
        }
        agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
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
    if (!ROUTING_POLICY.isProviderEnabled(route.provider)) {
      noteSkip(route, "disabled", "provider_disabled");
      return "unavailable";
    }
    if (!(await providerAvailable(route))) {
      // A health probe says the local bridge did not answer. That is real, but
      // it says nothing about the provider behind it, so it rides its own short
      // ladder rather than escalating the provider's own backoff.
      COOLDOWNS.cooldownProvider(route.provider, { failureClass: PROBE_FAILURE_CLASS });
      noteSkip(route, "unavailable", PROBE_FAILURE_CLASS);
      return "unavailable";
    }
    return attemptCandidate(route, selection);
  };
  const served = (outcome) => outcome === "served" || outcome === "terminal";

  // Pass 1: the candidates that are not cooling at all.
  for (const route of candidates) {
    if (Date.now() > selectionDeadline) { deadlineReached = true; break; }
    if (!ROUTING_POLICY.isProviderEnabled(route.provider)) {
      noteSkip(route, "disabled", "provider_disabled");
      continue;
    }
    if (COOLDOWNS.isCooling(route.provider)) {
      noteSkip(route, "cooldown active", COOLDOWNS.get(route.provider)?.failureClass ?? providerState(route.provider).lastFailureClass ?? "cooldown");
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
      .filter((route) => ROUTING_POLICY.isProviderEnabled(route.provider) && !attempted.has(route.provider) && COOLDOWNS.allowsLastResort(COOLDOWNS.get(route.provider)) && countLiveAgentActivity({ provider: route.provider }) === 0)
      .sort((a, b) => (COOLDOWNS.get(a.provider)?.until ?? 0) - (COOLDOWNS.get(b.provider)?.until ?? 0))
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
  const waitCandidates = candidates.filter((route) => ROUTING_POLICY.isProviderEnabled(route.provider) && !attempted.has(route.provider));
  const waitMs = COOLDOWNS.nextRetryMs(waitCandidates.map(({ provider }) => provider));
  if (!deadlineReached && EXHAUSTION_WAIT_MS > 0 && waitMs > 0 && waitMs <= EXHAUSTION_WAIT_MS && !clientSignal?.aborted && !response.headersSent) {
    recordRouterEvent({ phase: "exhaustion_wait", requestId, role, origin, requestedModel: payload.model, provider: null, model: null, workspace, elapsedMs: waitMs });
    await delay(waitMs, clientSignal);
    if (!clientSignal?.aborted) {
      // One attempt, not one candidate: a provider whose local bridge is down
      // was never asked anything, so it must not consume the single try the
      // wait bought.
      for (const route of waitCandidates) {
        if (COOLDOWNS.isCooling(route.provider)) continue;
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
  agentActivity.endRequest(activitySubject, { requestId, outcome: "failure", hasToolCalls: false });
  const summary = COOLDOWNS.summary(candidates.map(({ provider }) => provider));
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

async function proxyRoleResponse(response, role, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null, session = null) {
  return proxyFallbackChain(response, { candidates: ROUTING_POLICY.roleCandidates(role), role, agentRole: role, subject: `role ${role}`, sessionKey: session?.key ?? null, session }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal);
}

async function proxyOrchestratorResponse(response, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal = null, session = null) {
  const sessionKey = session?.key ?? null;
  const preferred = carriesPendingToolResult(payload) ? orchestratorProviderForSession(sessionKey) : null;
  return proxyFallbackChain(response, { candidates: ROUTING_POLICY.orchestratorCandidates(Math.random, preferred), role: null, origin: "orchestrator", agentRole: ORCHESTRATOR_AGENT_ROLE, subject: "the orchestrator", sessionKey, session }, payload, wantsStream, requestId, turnMetadataHeader, workspace, clientSignal);
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

function hasWorkspaceClaim(payload, turnMetadataHeader) {
  const explicitPaths = [
    ...WORKSPACE_KEYS.map((key) => payload?.[key]),
    ...(payload?.metadata && typeof payload.metadata === "object" ? WORKSPACE_KEYS.map((key) => payload.metadata[key]) : []),
  ];
  if (explicitPaths.some((value) => value !== null && value !== undefined && (typeof value !== "string" || value.trim()))) return true;
  const clientMetadata = payload?.client_metadata;
  if (clientMetadata && typeof clientMetadata === "object" && Object.hasOwn(clientMetadata, "x-codex-turn-metadata")) return true;
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  return Boolean(turnMetadata && Object.hasOwn(turnMetadata, "workspaces"));
}

/**
 * Keep a validated workspace attached to an identified conversation when a
 * later Codex continuation drops its workspace transport metadata. The
 * canonicalized single-workspace header is intentionally only minted after
 * resolveCwd accepts the current request; an invalid or ambiguous claim is
 * returned unchanged so the bridge can continue to fail closed.
 */
function addWorkspaceIdToTurnMetadata(payload, turnMetadataHeader) {
  const parsed = parseTurnMetadataJson(turnMetadataHeader);
  if (!parsed) return turnMetadataHeader;
  const context = workspaceContextFromRequest({}, payload, turnMetadataHeader);
  if (!context.workspace_id || parsed.workspace_id === context.workspace_id) return turnMetadataHeader;
  return JSON.stringify({ ...parsed, workspace_id: context.workspace_id });
}

function workspaceMetadataForSession(payload, turnMetadataHeader, session) {
  const headers = turnMetadataHeader ? { "x-codex-turn-metadata": turnMetadataHeader } : {};
  let workspacePath = null;
  try {
    workspacePath = resolveCwd(payload, headers);
  } catch {
    // Missing, invalid, or ambiguous current metadata is handled below. Only
    // a completely metadata-less continuation may use the session's prior
    // validated workspace.
  }
  if (workspacePath) {
    if (session?.scope === "identified") rememberWorkspaceMetadata(session.key, workspacePath);
    // Preserve the caller's richer metadata (including repository identity) if
    // it supplied one. Top-level-only requests need a canonical header so a
    // bridge still receives structured workspace data.
    return addWorkspaceIdToTurnMetadata(payload, turnMetadataHeader ?? JSON.stringify({ workspaces: { [workspacePath]: {} } }));
  }
  if (session?.scope === "identified" && !hasWorkspaceClaim(payload, turnMetadataHeader)) {
    const metadata = getWorkspaceMetadata(session.key) ?? turnMetadataHeader;
    return addWorkspaceIdToTurnMetadata(payload, metadata);
  }
  return turnMetadataHeader;
}

// The only request header the router ever re-emits toward a provider bridge.
// Provider bridges resolve their own workspace `cwd` from this JSON turn
// metadata; the router itself never inspects `workspaces`, it only validates
// and relays. Everything else about the inbound request (in particular any
// client-supplied Authorization) is never forwarded: downstreamHeaders()
// always sets the outbound provider credential independently.


// Router-generated (never forwarded from the client) identity of the Codex
// conversation this request belongs to. A bridge that drives Codex's own
// spawner has to split one CLI turn across two requests -- it ends the first
// with a tool call and Codex returns the result on the next -- so it needs to
// recognise the continuation as the same conversation.
//
// The scope travels with it and matters as much as the key: `requestSession`
// falls back to one process-wide key when a request carries no identity at all,
// and a bridge holding CLI state under that key would let two unrelated Codex
// conversations share one process. Telling the bridge the key is not specific
// lets it fail closed to a one-shot run instead of guessing.
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
  const workspaceKeys = Object.keys(workspaces);
  // A single unresolved map key is safe to use for a privacy-safe display
  // label, but it is not used as the execution path. The bridge still receives
  // the original metadata and fails closed if it cannot resolve that path.
  const labelPath = path ?? (resolvableKeys.length === 0 && workspaceKeys.length === 1 ? workspaceKeys[0] : null);
  const matchingEntry = path && workspaces[path]
    ? workspaces[path]
    : resolvableKeys.length === 1
      ? workspaces[resolvableKeys[0]]
      : workspaceKeys.length === 1
        ? workspaces[workspaceKeys[0]]
        : null;
  const remotes = matchingEntry?.associated_remote_urls;
  const repository = remotes && typeof remotes === "object"
    ? Object.values(remotes).map(repositoryIdentity).find(Boolean) ?? null
    : null;
  const key = repository ?? workspacePathLabel(labelPath) ?? "unknown";
  const cwd = workspacePathLabel(labelPath);

  const rawId = matchingEntry?.workspace_id
    ?? matchingEntry?.workspaceId
    ?? matchingEntry?.id
    ?? turnMetadata?.workspace_id
    ?? turnMetadata?.workspaceId
    ?? null;

  const derivedId = key !== "unknown" ? `ws_${createHash("sha256").update(key).digest("hex").slice(0, 12)}` : null;
  const workspaceId = typeof rawId === "string" && rawId.trim() ? safeWorkspaceId(rawId) : derivedId;

  if (key !== "unknown") {
    if (workspaceId) registerWorkspaceId(workspaceId, key);
    if (derivedId) registerWorkspaceId(derivedId, key);
  }

  const context = {
    key,
    cwd,
  };
  if (workspaceId) context.workspace_id = workspaceId;
  return context;
}

function sendRouterAuthFailure(response) {
  sendJson(response, 401, errorBody("Router authentication is required.", "router_authentication_error", {
    code: "router_authentication_error",
    retryable: false,
  }), { "www-authenticate": "Bearer" });
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
  const providerMatch = pathname.match(/^\/v1\/providers\/([a-zA-Z0-9._-]+)$/);
  if (providerMatch) {
    if (request.method !== "POST") {
      sendJson(response, 405, errorBody("Method not allowed", "router_method_not_allowed", { code: "router_method_not_allowed" }), { allow: "POST" });
      return;
    }
    const remoteAddress = request.socket?.remoteAddress;
    if (!isLoopbackAddress(remoteAddress)) {
      sendJson(response, 403, errorBody("Provider administration is restricted to loopback connections.", "router_access_denied", { code: "router_access_denied" }));
      return;
    }
    const providerParam = providerMatch[1];
    const provider = providerParam.toLowerCase().trim();
    if (!ROUTING.providers[provider] && !ROUTES.some((r) => r.provider === provider)) {
      sendJson(response, 404, errorBody(`Unknown provider: ${providerParam}`, "router_unknown_provider", { code: "router_unknown_provider" }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await requestBody(request));
    } catch {
      sendJson(response, 400, errorBody("request body must be valid JSON"));
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      sendJson(response, 400, errorBody("request body must be a JSON object"));
      return;
    }
    if (typeof payload.enabled !== "boolean") {
      sendJson(response, 400, errorBody("request body requires boolean 'enabled'"));
      return;
    }
    ROUTING_POLICY.setProviderEnabled(provider, payload.enabled);
    await persistRouterStateNow();
    sendJson(response, 200, {
      ok: true,
      provider,
      enabled: payload.enabled,
      status: payload.enabled ? (COOLDOWNS.isCooling(provider) ? (COOLDOWNS.get(provider)?.failureClass ?? "cooldown") : "ready") : "disabled",
    });
    return;
  }
  if (pathname === "/v1/responses" && request.method === "POST" && !routerAuthorizationValid(request)) {
    sendRouterAuthFailure(response);
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
  const role = ROUTING_POLICY.roleForModel(model);
  const requestId = String(request.headers["x-request-id"] ?? randomUUID());
  const wantsStream = payload.stream !== false;
  const turnMetadataHeader = resolveTurnMetadataHeader(request, payload);
  const session = requestSession(request, payload, turnMetadataHeader);
  const effectiveTurnMetadataHeader = workspaceMetadataForSession(payload, turnMetadataHeader, session);
  const workspace = workspaceContextFromRequest(request, payload, effectiveTurnMetadataHeader);
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
      await proxyOrchestratorResponse(response, payload, wantsStream, requestId, effectiveTurnMetadataHeader, workspace, clientAbort.signal, session);
      return;
    }
    if (role) {
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
        // `session.key` here is this role request's own session key, not a
        // proven identifier for an orchestrator turn actually waiting on it
        // -- the router has no reliable parent/child link between a role
        // alias request and whatever spawned it (they can share a session
        // key by convention, but nothing here proves the parent is still
        // in flight, or that it is even the same subject the tracker would
        // use for that parent's own turn). Marking this session subagent_wait
        // would just be immediately overwritten by this very call's own
        // beginRequest below and, worse, would misreport an unrelated caller
        // on the same session id as "waiting on a subagent" it never spawned.
        // A parent's subagent_wait can only come from a proven relationship:
        // the activity lifecycle event a bridge reports against the
        // requestId it was actually served under (see ingestAgentEvents).
        await proxyRoleResponse(response, role, payload, wantsStream, requestId, effectiveTurnMetadataHeader, workspace, clientAbort.signal, session);
      } finally {
        releaseSubagentSlot(session.key);
      }
      return;
    }
    const route = ROUTING_POLICY.routeForModel(payload.model);
    if (!route) {
      sendJson(response, 400, errorBody(`No local route is configured for model ${String(payload.model)}`));
      return;
    }
    await proxyConcreteResponse(response, route, payload, wantsStream, requestId, effectiveTurnMetadataHeader, workspace, clientAbort.signal, session);
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
  refreshCodexState,
  activeProviderRequests,
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
  beginShutdown,
  proxyConcreteResponse,
  proxyOrchestratorResponse,
  ORCHESTRATOR_ALIAS,
  payloadForCandidate,
  classifyProviderFailure,
  codexTelemetryStatus,
  setCodexStateSnapshotForTests,
  declaredLimit,
  concurrencyStatus,
  agentsStatus,
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
  autodevEnrichOtlpPayload,
  isAutodevAttributesEnabled,
  isClientDisconnectError,
  isDraining,
  routingStatus,
  limitsStatus,
  isLoopbackAddress,
  loadRouterState,
  parseConcurrencyConfig,
  parseTurnMetadataJson,
  persistRouterStateNow,
  PROCESS_FALLBACK_SESSION_KEY,
  roleCapabilityRequirements,
  recordConcurrencyDenial,
  recordRouterEvent,
  recordSpawnFailure,
  releaseSubagentSlot,
  requestSession,
  resetConcurrencyTelemetry,
  resetLifecycleForTests,
  resetOtelTelemetry,
  resetRouterTelemetry,
  resolveTurnMetadataHeader,
  ROUTER_INSTANCE_ID,
  spawnFailureStatus,
  routerAuthorizationValid,
  setRouterAuthTokenForTests,
  serializeRouterState,
  tryAcquireSubagentSlot,
  providerCapabilities,
  subagentSpawnToolsFor,
  bridgeTelemetryHeaders,
  mcpContractForRole,
  recordNativeMcpExposure,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  subagentStatus,
  ingestAgentEvents,
  noteBridgeRequest,
  noteBridgeSession,
  lookupBridgeSessionContext,
  recallBridgeSessionRequestId,
  closeBridgeSubagentsForRequest,
  UNATTRIBUTED_SUBAGENT_ROLE,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  carriesPendingToolResult,
  AGENT_EVENTS_URL_HEADER,
  AGENT_EVENTS_PATH,
  workspaceContextFromRequest,
  workspaceMetadataForSession,
  registerWorkspaceId,
  attributionDiagnosticsStatus,
  resetAttributionDiagnostics,
  OTEL_PERSISTENCE_SCHEMA_VERSION,
  resolveTelemetryContext,
  safeAgentIdentity,
  safePrivacyWorkspace,
  otelPersistenceSnapshot,
  restoreOtelTelemetry,
  agentActivity,
  AGENT_ACTIVITY_TTL_MS,
  usageStatus,
  projectLiveAgents,
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
