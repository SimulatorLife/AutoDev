import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import {
  createAgentActivityTracker,
  resolveAgentActivityTtlMs
} from "../agents/agent-activity.ts";
import { writeErrorLine } from "../shared/output.ts";
import {
  isDirectory,
  resolveCwd,
  WORKSPACE_KEYS
} from "../shared/resolve-workspace.ts";
import {
  dropUnresolvableReasoning,
  normalizeInputItemIds
} from "../shared/responses-item-ids.ts";
import {
  authStatus,
  isLoopbackAddress,
  routerAuthorizationValid
} from "./auth.ts";
import {
  ConcurrencyManager,
  concurrencyStatus as getConcurrencyStatus,
  getDefaultConcurrencyManager,
  PROCESS_FALLBACK_SESSION_KEY,
  resetConcurrencyTelemetry as resetManagerConcurrencyTelemetry,
  setDefaultConcurrencyManager,
  SUBAGENT_SLOT_KIND,
  touchOpenSubagentSlots as touchManagerOpenSubagentSlots
} from "./concurrency.ts";
import { COOLDOWN_CONFIG, COOLDOWNS } from "./cooldown.ts";
import {
  getDefaultRouterEventRecorder,
  noteRequestThread,
  recordRouterEvent,
  RouterEventRecorder,
  setDefaultRouterEventRecorder
} from "./events.ts";
import {
  getDefaultRouterLifecycle,
  RouterLifecycle,
  setDefaultRouterLifecycle
} from "./lifecycle.ts";
import {
  codexTelemetryStatus,
  getDefaultOtelTracker,
  ingestOtelSignal,
  OTEL_HEALTH_TTL_MS,
  otelPersistenceSnapshot,
  otelTelemetry,
  OtelTracker,
  recordBridgeMcpExposure,
  recordBridgeSkillExposure,
  recordBridgeSkillUsed,
  recordBridgeToolObservation,
  restoreOtelTelemetry,
  setDefaultOtelTracker
} from "./otel.ts";
import {
  effectiveStateFile,
  getDefaultPersistenceManager,
  persistRouterStateNow,
  restoreProviderTelemetrySection,
  RouterPersistence,
  scheduleRouterStatePersist,
  setDefaultPersistenceManager
} from "./persistence.ts";
import {
  activeProviderRequests,
  CHAIN_SELECTION_DEADLINE_MS,
  CONCRETE_RETRY_BASE_MS,
  CONCRETE_RETRY_MAX_MS,
  CONCRETE_STATUS_MAX_ATTEMPTS,
  CONCRETE_TRANSPORT_MAX_ATTEMPTS,
  errorBody,
  EXHAUSTION_WAIT_MS,
  getActiveRequests,
  LAST_RESORT_MAX_ATTEMPTS,
  PROBE_TIMEOUT_MS,
  proxyConcreteResponse,
  proxyOrchestratorResponse,
  proxyRoleResponse,
  responseFailureEvent,
  ROUTER_INSTANCE_ID,
  type RouterSession,
  sendJson,
  transportErrorInfo,
  UPSTREAM_TIMEOUT_MS
} from "./proxy.ts";
import { setUpstreamShapeHooks } from "./responses.ts";
import {
  ORCHESTRATOR_ALIAS,
  ORCHESTRATOR_REASONING_EFFORT,
  ORCHESTRATOR_TIER,
  ROUTES,
  ROUTING_CONFIG as ROUTING,
  ROUTING_CONFIG_FILE,
  ROUTING_POLICY
} from "./routing.ts";
import {
  CodexStateCollector,
  loadCodexStateCollectorConfig
} from "./state-collector.ts";
import {
  AGENT_EVENTS_PATH,
  bridgeSubagentKey,
  closeBridgeSubagentsForRequest,
  closeBridgeSubagentUsage,
  getDefaultExecutionContract,
  getDefaultSubagentRegistry,
  getWorkspaceMetadata,
  lookupBridgeSessionContext,
  openBridgeSubagentUsage,
  orchestratorProviderForSession,
  providerCapabilities,
  recallBridgeSessionRequestId,
  recordSpawnFailure,
  recordSubagentSpawn,
  rememberWorkspaceMetadata,
  reportedChildren,
  resetSpawnFailureTelemetry,
  resetSubagentTelemetry,
  safeMetricLabel,
  setDefaultSubagentRegistry,
  spawnFailureStatus,
  SubagentRegistry,
  subagentStatus
} from "./subagents.ts";
import {
  attributionDiagnostics,
  attributionDiagnosticsStatus,
  countLiveAgentActivity,
  getDefaultUsageTracker,
  inFlightUsage,
  projectLiveAgents,
  recordUsageEvent,
  registerWorkspaceId,
  resetUsageTelemetry,
  restoreUsagePersistenceSnapshot,
  safeWorkspaceId,
  UNATTRIBUTED_DIMENSION,
  usageOrigin,
  usagePersistenceSnapshot,
  usageStatus
} from "./usage.ts";

export { errorBody, sendJson } from "./proxy.ts";

export const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
export const PORT = Number.parseInt(
  process.env.CODEX_MODEL_ROUTER_PORT ?? "4100");
export const AGENT_ACTIVITY_TTL_MS = resolveAgentActivityTtlMs();
export const agentActivity = createAgentActivityTracker({
  ttlMs: AGENT_ACTIVITY_TTL_MS
});
getDefaultUsageTracker().setActivityTracker(agentActivity);
const CODEX_HOME =
  process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;
const CATALOG_FILE =
  process.env.CODEX_ROUTER_CATALOG_FILE ??
  `${CODEX_HOME}/codex-model-catalog.json`;
const dashboardSource = new URL(
  "../../scripts/codex-model-router-dashboard.html",
  import.meta.url
);
const dashboardInstalled = new URL(
  "../../hooks/codex-model-router-dashboard.html",
  import.meta.url
);
const DASHBOARD_FILE = existsSync(dashboardSource)
  ? dashboardSource
  : dashboardInstalled;
const ROUTER_STARTED_AT = new Date().toISOString();
const SHUTDOWN_DRAIN_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_ROUTER_SHUTDOWN_DRAIN_MS ?? "30000");

export const providerTelemetry = new Map(
  ROUTES.map(({ provider }) => [
    provider,
    {
      attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      lastAttemptAt: null as string | null,
      lastSuccessAt: null as string | null,
      lastFailureAt: null as string | null,
      lastFailureClass: null as string | null,
      lastFailure: null as {
        timestamp: string;
        class: string | null;
        status: number | null | undefined;
      } | null
    }
  ])
);

const routerLifecycle = new RouterLifecycle({
  startedAt: ROUTER_STARTED_AT,
  drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
  routerInstanceId: ROUTER_INSTANCE_ID
});
setDefaultRouterLifecycle(routerLifecycle);

const MAX_RECENT_EVENTS = Number.parseInt(
  process.env.CODEX_ROUTER_MAX_RECENT_EVENTS ?? "100");
const routerEvents = new RouterEventRecorder({
  maxRecentEvents: MAX_RECENT_EVENTS,
  routerInstanceId: ROUTER_INSTANCE_ID,
  resolveOrigin: (role, provider) => usageOrigin(role, provider),
  onEvent: (event, input, effectiveOrigin) => {
    const workspaceContext =
      typeof input.workspace === "string"
        ? { key: input.workspace, cwd: null }
        : (input.workspace ?? null);
    if (
      event.provider &&
      event.model &&
      ["selected", "skipped", "result"].includes(event.phase)
    ) {
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
        origin:
          effectiveOrigin ?? usageOrigin(event.role, event.provider as any)
      } as any);
    }
    if (event.phase === "result")
      closeBridgeSubagentsForRequest(
        event.requestId as any,
        event.outcome as any,
        event.elapsedMs
      );
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
        state.lastFailure = {
          timestamp: event.timestamp,
          class: event.failureClass,
          status: event.status
        };
      }
    }
    scheduleRouterStatePersist();
  }
});
setDefaultRouterEventRecorder(routerEvents);

const subagentRegistry = new SubagentRegistry({
  agentActivity,
  executionContract: getDefaultExecutionContract(),
  onRecordRouterEvent: (event) => recordRouterEvent(event as any),
  onRecordUsageEvent: (event) => recordUsageEvent(event as any),
  onSchedulePersist: () => scheduleRouterStatePersist(),
  onMissingProviderDiagnostic: (count) => {
    attributionDiagnostics.byReason.missing_provider += count;
  },
  onMissingModelDiagnostic: (count) => {
    attributionDiagnostics.byReason.missing_model += count;
  },
  getCodexNativeSpawns: () => otelTelemetry.threads.spawns.total,
  getSpawnCapableProviders: () =>
    Object.keys(ROUTING.providers).filter(
      (provider) => providerCapabilities(provider).subagentSpawn
    )
});
setDefaultSubagentRegistry(subagentRegistry);

const otelTracker = new OtelTracker({
  healthTtlMs: OTEL_HEALTH_TTL_MS,
  usageTracker: getDefaultUsageTracker(),
  getConversationThread: (id) =>
    (codexState.lastSnapshot &&
      (codexState.lastSnapshot as any).conversationThreads?.[id]) ??
    null,
  getBridgeRequestContext: (id) => subagentRegistry.getBridgeRequestContext(id),
  onSchedulePersist: () => scheduleRouterStatePersist()
});
setDefaultOtelTracker(otelTracker);

const CODEX_CONFIG_FILE =
  process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ?? `${CODEX_HOME}/config.toml`;
const concurrencyManager = new ConcurrencyManager({
  agentActivity,
  configFile: CODEX_CONFIG_FILE,
  configSource: process.env.CODEX_ROUTER_CODEX_CONFIG_FILE
    ? "env_override"
    : "default_codex_home",
  getOrchestratorSession: (key) => subagentRegistry.orchestratorSessionInfo(key)
});
setDefaultConcurrencyManager(concurrencyManager);

ROUTING_POLICY.setRuntime({
  providerFailureStreak: (provider) => COOLDOWNS.failureStreak(provider),
  liveProviderCount: (provider) => countLiveAgentActivity({ provider })
});
COOLDOWNS.setRuntime({
  isProviderEnabled: (provider) => ROUTING_POLICY.isProviderEnabled(provider),
  isKnownProvider: (provider) => Object.hasOwn(ROUTING.providers, provider),
  lastFailureClass: (provider) => providerState(provider).lastFailureClass
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
  recordEvent: (event) => {
    if (typeof event.requestId !== "string" || event.requestId.length === 0)
      return;
    recordRouterEvent({
      phase: String(event.phase ?? "router_transform"),
      requestId: event.requestId,
      requestedModel:
        typeof event.requestedModel === "string" ? event.requestedModel : null,
      provider: typeof event.provider === "string" ? event.provider : null,
      model: typeof event.model === "string" ? event.model : null,
      droppedReasoningItems:
        typeof event.droppedReasoningItems === "number"
          ? event.droppedReasoningItems
          : 0,
      normalizedItemIds:
        typeof event.normalizedItemIds === "number"
          ? event.normalizedItemIds
          : 0
    });
  }
});

export const codexState = {
  collector: new CodexStateCollector(loadCodexStateCollectorConfig()),
  lastSnapshot: null as Record<string, unknown> | null,
  livePollStarted: false
};

export async function refreshCodexState(): Promise<void> {
  try {
    codexState.lastSnapshot =
      (await codexState.collector.collectSnapshot()) as unknown as Record<
        string,
        unknown
      >;
  } catch (error) {
    codexState.lastSnapshot = {
      localTelemetry: {
        status: "error",
        pathConfigured: true,
        reason: error instanceof Error ? error.message : String(error),
        collectedAt: new Date().toISOString()
      }
    };
  }
}

export function setCodexStateSnapshotForTests(
  snapshot: Record<string, unknown> | null
): void {
  codexState.lastSnapshot =
    snapshot && typeof snapshot === "object" ? snapshot : null;
}

export function codexStateStatus(): Record<string, unknown> {
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
        reason: "collector_initializing"
      }
    };
  }
  const { path: _path, ...safeLocalTelemetry } =
    (snapshot.localTelemetry as Record<string, unknown>) ?? {};
  return {
    localTelemetry: {
      ...safeLocalTelemetry,
      pathConfigured: Boolean(
        (snapshot.localTelemetry as Record<string, unknown>)?.path
      )
    },
    recentThreads: snapshot.recentThreads,
    projects: snapshot.projects,
    conversationThreads: snapshot.conversationThreads,
    spawnEdges: snapshot.spawnEdges,
    schema: snapshot.schema
  };
}

export function providerState(provider: string) {
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
      lastFailure: null
    });
  }
  return providerTelemetry.get(provider)!;
}

const routerPersistence = new RouterPersistence({
  stateFile: () => effectiveStateFile(),
  isMain: Boolean(
    process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  ),
  debounceMs: 500,
  getSnapshot: () => ({
    disabledProviders: ROUTING_POLICY.runtimeState().disabledProviders,
    providerTelemetry: Object.fromEntries(providerTelemetry),
    usage: usagePersistenceSnapshot(),
    concurrency: concurrencyManager.telemetry,
    subagents: subagentRegistry.subagentTelemetry,
    spawnFailures: subagentRegistry.spawnFailureTelemetry,
    providerCooldowns: COOLDOWNS.persistedHardEntries(),
    recentEvents: routerEvents.getRecentEvents(false),
    otelTelemetry: otelPersistenceSnapshot()
  }),
  restoreSection: (section, value, parsed) => {
    if (section === "providerTelemetry") {
      restoreProviderTelemetrySection(providerTelemetry, value);
    } else if (section === "usage") {
      restoreUsagePersistenceSnapshot(value);
    } else if (
      section === "concurrency" &&
      value &&
      typeof value === "object"
    ) {
      concurrencyManager.restoreTelemetry(value);
    } else if (
      section === "spawnFailures" &&
      value &&
      typeof value === "object"
    ) {
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
          if (event.provider && event.model && event.phase)
            recordUsageEvent(event as any);
        }
        inFlightUsage.clear();
      }
    }
  }
});
setDefaultPersistenceManager(routerPersistence);

export function resetRouterTelemetry(): void {
  getDefaultRouterEventRecorder().clear();
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
  resetManagerConcurrencyTelemetry();
  resetSubagentTelemetry();
  resetSpawnFailureTelemetry();
  COOLDOWNS.clearAll();
  scheduleRouterStatePersist();
}

export function routingStatus(): Record<string, unknown> {
  return {
    configSource: process.env.CODEX_ROUTER_CONFIG_FILE
      ? "env_override"
      : "default_codex_home",
    configFileExists: existsSync(ROUTING_CONFIG_FILE),
    orchestrator: {
      alias: ORCHESTRATOR_ALIAS,
      tier: ORCHESTRATOR_TIER,
      reasoningEffort: { ...ORCHESTRATOR_REASONING_EFFORT }
    },
    roles: { ...ROUTING.roles },
    providerGroups: { ...ROUTING.providerGroups },
    priorities: Object.fromEntries(
      ROUTES.map((route) => {
        const tierPrios: Record<string, string> = {};
        for (const [tier, groups] of Object.entries(ROUTING.providerGroups)) {
          if (Array.isArray(groups)) {
            for (const [gIdx, group] of groups.entries()) {
              if (
                Array.isArray(group) &&
                group.some(
                  (name) =>
                    String(name).toLowerCase() === route.provider.toLowerCase()
                )
              ) {
                tierPrios[tier] = `P${gIdx + 1}`;
                break;
              }
            }
          }
        }
        return [route.provider, tierPrios];
      })
    ),
    configuredProviders: Object.keys(ROUTING.providers),
    enabledProviders: Object.keys(ROUTING.providers).filter((p) =>
      ROUTING_POLICY.isProviderEnabled(p)
    ),
    disabledProviders: ROUTING_POLICY.runtimeState().disabledProviders,
    routes: Object.fromEntries(
      ROUTES.map((route) => [
        route.provider,
        {
          pattern:
            route.pattern instanceof RegExp
              ? route.pattern.source
              : String(route.pattern),
          baseUrl: route.baseUrl,
          healthUrl: route.healthUrl ?? null,
          envKey: route.envKey ?? null,
          credentialConfigured: ROUTING_POLICY.routeCredentialAvailable(route)
        }
      ])
    )
  };
}

export function limitsStatus(): Record<string, unknown> {
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
    maxConcurrentThreadsPerSession:
      getDefaultConcurrencyManager().effectivePerSessionLimit()
  };
}

export function agentsStatus(at = Date.now()): Record<string, unknown> {
  const projection = projectLiveAgents(at);
  const liveAgents = projection.allLiveAgents;
  const byState = getDefaultUsageTracker().activityTracker.snapshot(at).byState;
  const liveByKind: Record<string, number> = {};
  const liveByRole: Record<string, number> = {};
  const liveByOrigin: Record<string, number> = {};
  const liveByProvider: Record<string, number> = {};
  const liveByModel: Record<string, number> = {};
  const liveByWorkspace: Record<string, number> = {};
  for (const agent of liveAgents) {
    const kind =
      typeof agent.kind === "string" && agent.kind ? agent.kind : "session";
    liveByKind[kind] = (liveByKind[kind] ?? 0) + 1;
    if (agent.provider)
      liveByProvider[agent.provider] =
        (liveByProvider[agent.provider] ?? 0) + 1;
    if (agent.provider && agent.model) {
      const modelKey = agent.model.startsWith(`${agent.provider}/`)
        ? agent.model
        : `${agent.provider}/${agent.model}`;
      liveByModel[modelKey] = (liveByModel[modelKey] ?? 0) + 1;
    }
    const rKey = agent.role ?? UNATTRIBUTED_DIMENSION;
    liveByRole[rKey] = (liveByRole[rKey] ?? 0) + 1;
    const oKey = agent.origin ?? UNATTRIBUTED_DIMENSION;
    liveByOrigin[oKey] = (liveByOrigin[oKey] ?? 0) + 1;
    const wKey = agent.workspace ?? UNATTRIBUTED_DIMENSION;
    liveByWorkspace[wKey] = (liveByWorkspace[wKey] ?? 0) + 1;
  }
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
      admissionSlots: getDefaultUsageTracker().activityTracker.countLive(
        { kind: SUBAGENT_SLOT_KIND },
        at
      ),
      activeAdmissionSessions:
        getDefaultUsageTracker().activityTracker.distinctTags(
          { kind: SUBAGENT_SLOT_KIND },
          at
        ).length,
      processFallbackActiveThreads:
        getDefaultUsageTracker().activityTracker.countLive(
          { kind: SUBAGENT_SLOT_KIND, tag: PROCESS_FALLBACK_SESSION_KEY },
          at
        )
    },
    reconciledWithConcurrency: true
  };
}

export function recordConcurrencyDenial(denial: unknown): void {
  getDefaultConcurrencyManager().recordConcurrencyDenial(
    denial as Parameters<ConcurrencyManager["recordConcurrencyDenial"]>[0]
  );
  const info =
    typeof denial === "string"
      ? { reason: denial }
      : ((denial as Record<string, unknown>) ?? {});
  recordSpawnFailure({
    requestId: (info.requestId as string | undefined) ?? null,
    role: (info.role as string | undefined) ?? null,
    requestedModel: (info.requestedModel as string | undefined) ?? null,
    reason: (info.reason as string | undefined) ?? "unknown"
  });
  recordRouterEvent({
    phase: "denied",
    requestId: (info.requestId as string | undefined) ?? null,
    role: (info.role as string | undefined) ?? null,
    requestedModel: (info.requestedModel as string | undefined) ?? null,
    provider: null,
    model: null,
    failureClass: "concurrency_limit",
    denialReason: (info.reason as string | undefined) ?? "unknown"
  });
}

export const INGESTED_AGENT_EVENTS = Object.freeze(
  new Set([
    "subagent_spawn",
    "subagent_result",
    "subagent_tools_unavailable",
    "tool_executed",
    "tool_requested",
    "tool_unavailable",
    "skill_exposed",
    "skill_used",
    "mcp_exposed",
    "activity",
    "heartbeat"
  ])
);

/**
 * The lifecycle facts a bridge may report: only what the router cannot see.
 *
 * The router settles every request itself (`endRequest`), from the response it
 * relays: whether it ended in a tool call, needs input, failed, or left live
 * children. A bridge's own `tool_wait`/`user_wait`/`finished`/`failed` for the
 * same request only repeat that -- late, over a separate channel, and about
 * the request rather than the agent -- so a per-response `finished` arriving
 * after the router had put the agent in `tool_wait` ended the agent between
 * two of its tool calls. What a bridge alone knows is its own in-CLI
 * delegation: `subagent_wait` while bridge-native children run, and `resumed`
 * once they report back. Heartbeats keep a long request visibly alive.
 */
export const REPORTABLE_AGENT_ACTIVITY_STATES = Object.freeze(
  new Set(["subagent_wait", "resumed", "heartbeat"])
);

export function ingestAgentEvents(payload: Record<string, unknown>): {
  accepted: number;
  closed: number;
  unavailable: number;
  rejected: number;
  reason: string | null;
} {
  const requestId =
    typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
  let context = requestId
    ? getDefaultSubagentRegistry().getBridgeRequestContext(requestId)
    : undefined;
  if (!context && requestId) {
    const sessionKey = requestId;
    const sessionContext = lookupBridgeSessionContext(sessionKey);
    const sessionRequestId = recallBridgeSessionRequestId(sessionKey);
    if (sessionContext && sessionRequestId) {
      // Reported against the session itself, so it describes the session's
      // own agent, not whichever request of the session was noted last.
      context = { ...sessionContext, activitySubject: sessionKey };
    }
  }
  if (!context) {
    return {
      accepted: 0,
      closed: 0,
      unavailable: 0,
      rejected: Array.isArray(payload?.events) ? payload.events.length : 0,
      reason: "unknown_request_id"
    };
  }
  const events = Array.isArray(payload.events)
    ? (payload.events as Array<Record<string, unknown>>)
    : [];
  let accepted = 0;
  let closed = 0;
  let unavailable = 0;
  let rejected = 0;
  for (const event of events) {
    if (
      !event ||
      typeof event !== "object" ||
      !INGESTED_AGENT_EVENTS.has(event.type as string)
    ) {
      rejected += 1;
      continue;
    }
    if (event.type === "subagent_tools_unavailable") {
      recordSpawnFailure({
        requestId,
        role: null,
        requestedModel: context.model ?? null,
        reason: "spawn_tool_unavailable"
      });
      unavailable += 1;
      continue;
    }
    if (
      event.type === "tool_executed" ||
      event.type === "tool_requested" ||
      event.type === "tool_unavailable"
    ) {
      recordBridgeToolObservation({ event, context });
      getDefaultUsageTracker().activityTracker.touch(context.activitySubject);
      if (context.sessionKey) touchManagerOpenSubagentSlots(context.sessionKey);
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
    if (
      event.type === "heartbeat" ||
      (event.type === "activity" &&
        (event.state === "heartbeat" ||
          (typeof event.state === "string" &&
            event.state.trim() === "heartbeat")))
    ) {
      getDefaultUsageTracker().activityTracker.touch(context.activitySubject);
      if (context.sessionKey) touchManagerOpenSubagentSlots(context.sessionKey);
      accepted += 1;
      continue;
    }
    if (event.type === "activity") {
      const state = typeof event.state === "string" ? event.state.trim() : "";
      if (!REPORTABLE_AGENT_ACTIVITY_STATES.has(state)) {
        rejected += 1;
        continue;
      }
      const tracker = getDefaultUsageTracker().activityTracker;
      if (state === "subagent_wait") {
        tracker.noteSubagentWait(context.activitySubject, {
          provider: context.provider ?? null,
          model: context.model ?? null,
          role: context.role ?? null,
          workspace: context.workspace ?? null
        });
      } else {
        // `resumed` resolves a bridge-native delegation; it is a no-op for an
        // agent that was not waiting on one.
        tracker.noteSubagentResolved(context.activitySubject);
      }
      accepted += 1;
      continue;
    }
    const role =
      typeof event.role === "string" && event.role.trim()
        ? safeMetricLabel(event.role)
        : null;
    const children = reportedChildren(event);
    const count = children.length;
    if (event.type === "subagent_result") {
      const outcome = event.outcome === "failure" ? "failure" : "success";
      const durationMs = Number.isFinite(event.durationMs)
        ? Math.max(0, event.durationMs as number)
        : null;
      for (const child of children) {
        if (
          closeBridgeSubagentUsage(bridgeSubagentKey(requestId, child.id), {
            outcome,
            elapsedMs: durationMs,
            failureClass: outcome === "failure" ? "subagent_failed" : null
          })
        ) {
          closed += 1;
        }
      }
      continue;
    }
    recordSubagentSpawn({
      mechanism: "bridge_native",
      provider: context.provider,
      role,
      status:
        typeof event.status === "string" && event.status.trim()
          ? safeMetricLabel(event.status)
          : "started",
      tool:
        typeof event.tool === "string" && event.tool.trim()
          ? safeMetricLabel(event.tool)
          : null,
      requestId,
      workspace: context.workspace ?? null,
      count
    });
    for (const child of children) {
      openBridgeSubagentUsage({
        requestId,
        context,
        role,
        childId: child.id,
        model: child.model
      });
    }
    accepted += count;
  }
  return { accepted, closed, unavailable, rejected, reason: null };
}

export function getRouterStatus(now = Date.now()): Record<string, unknown> {
  const projection = projectLiveAgents(now);
  const providers = Object.fromEntries(
    ROUTES.map((route) => {
      const state = providerState(route.provider);
      const cooldown = COOLDOWNS.get(route.provider, now);
      const inFlightRequests = getActiveRequests(route.provider);
      const active = projection.byProvider[route.provider] ?? 0;
      const coolingDown = cooldown !== null;
      const enabled = ROUTING_POLICY.isProviderEnabled(route.provider);
      const tierPrios: string[] = [];
      for (const [tier, groups] of Object.entries(ROUTING.providerGroups)) {
        if (Array.isArray(groups)) {
          for (const [gIdx, group] of groups.entries()) {
            if (
              Array.isArray(group) &&
              group.some(
                (name) =>
                  String(name).toLowerCase() === route.provider.toLowerCase()
              )
            ) {
              tierPrios.push(`${tier}: P${gIdx + 1}`);
              break;
            }
          }
        }
      }
      return [
        route.provider,
        {
          enabled,
          status: enabled
            ? coolingDown
              ? (cooldown.failureClass ?? state.lastFailureClass ?? "cooldown")
              : "ready"
            : "disabled",
          routingPriority: tierPrios.length > 0 ? tierPrios.join(" · ") : "—",
          limits: {
            cooldownKind: coolingDown ? cooldown.kind : null,
            cooldownFailureClass: coolingDown
              ? (cooldown.failureClass ?? null)
              : null,
            cooldownResetsAt: coolingDown ? (cooldown.resetsAt ?? null) : null,
            cooldownUntil: coolingDown
              ? new Date(cooldown.until).toISOString()
              : null,
            cooldownRemainingMs: coolingDown ? cooldown.until - now : 0,
            lastResortEligible: coolingDown
              ? COOLDOWNS.allowsLastResort(cooldown, now)
              : true
          },
          active,
          inFlightRequests,
          cooldownUntil: coolingDown
            ? new Date(cooldown.until).toISOString()
            : null,
          cooldownRemainingMs: coolingDown ? cooldown.until - now : 0,
          cooldownKind: coolingDown ? cooldown.kind : null,
          cooldownFailureClass: coolingDown
            ? (cooldown.failureClass ?? null)
            : null,
          cooldownResetsAt: coolingDown ? (cooldown.resetsAt ?? null) : null,
          lastResortEligible: coolingDown
            ? COOLDOWNS.allowsLastResort(cooldown, now)
            : true,
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
          lastFailure: state.lastFailure
        }
      ];
    })
  );

  return {
    schema: "autodev-router-status-v2",
    router: "codex-model-router",
    routerInstanceId: ROUTER_INSTANCE_ID,
    startedAt: ROUTER_STARTED_AT,
    pid: process.pid,
    telemetryPersistence: {
      enabled: Boolean(
        process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
      ),
      source: process.env.CODEX_ROUTER_STATE_FILE
        ? "env_override"
        : "default_codex_home",
      exists: existsSync(effectiveStateFile()),
      updatedAt: getDefaultPersistenceManager().getUpdatedAt()
    },
    authentication: authStatus(),
    routing: routingStatus(),
    limits: limitsStatus(),
    disabledProviders: ROUTING_POLICY.runtimeState().disabledProviders,
    usage: usageStatus(now, projection),
    attributionDiagnostics: attributionDiagnosticsStatus(),
    liveAgentAttribution: {
      missingProvider: projection.missingProvider,
      missingModel: projection.missingModel
    },
    codexTelemetry: codexTelemetryStatus(),
    agents: agentsStatus(now),
    concurrency: getConcurrencyStatus(now),
    subagents: subagentStatus(),
    spawnFailures: spawnFailureStatus(),
    inFlightRequests: Object.fromEntries(activeProviderRequests),
    liveActivity: projection.canonicalTotal,
    providers,
    recentEvents: getDefaultRouterEventRecorder().getRecentEvents(true),
    codexState: codexStateStatus()
  };
}

export async function sendDashboard(response: ServerResponse): Promise<void> {
  const body = await readFile(DASHBOARD_FILE);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    connection: "close",
    "x-autodev-router-instance-id": ROUTER_INSTANCE_ID
  });
  response.end(body);
}

export async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    );
  }
  const body = Buffer.concat(chunks);
  const encoding = String(
    request.headers["content-encoding"] ?? ""
  ).toLowerCase();
  if (encoding === "gzip") return gunzipSync(body).toString("utf8");
  if (encoding === "br") return brotliDecompressSync(body).toString("utf8");
  if (encoding === "deflate") return inflateSync(body).toString("utf8");
  return body.toString("utf8");
}

export function parseTurnMetadataJson(
  value: unknown
): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function resolveTurnMetadataHeader(
  request: IncomingMessage,
  payload: Record<string, unknown> | null | undefined
): string | null {
  const rawHeader = request.headers["x-codex-turn-metadata"];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (parseTurnMetadataJson(headerValue)) return headerValue ?? null;
  const clientMetadata = payload?.client_metadata as
    Record<string, unknown> | undefined;
  const embedded =
    clientMetadata && typeof clientMetadata === "object"
      ? clientMetadata["x-codex-turn-metadata"]
      : undefined;
  if (typeof embedded === "string" && parseTurnMetadataJson(embedded))
    return embedded;
  if (embedded && typeof embedded === "object" && !Array.isArray(embedded))
    return JSON.stringify(embedded);
  return null;
}

/**
 * Who is asking: the session (a Codex root thread and its whole agent tree
 * share it) and the thread itself. Codex 0.154.0 sends both on every request
 * -- `session-id`/`thread-id` headers, `client_metadata`, and turn metadata --
 * and a subagent's thread differs from its session.
 */
export function requestSession(
  request: IncomingMessage,
  payload: Record<string, unknown> | null | undefined,
  turnMetadataHeader: string | null = null
): {
  key: string;
  scope: "identified" | "process-fallback";
  thread: string | null;
} {
  const header =
    request.headers["x-codex-session-id"] ??
    request.headers["x-session-id"] ??
    request.headers["x-conversation-id"];
  const metadata = payload?.metadata as Record<string, unknown> | undefined;
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  const value =
    (Array.isArray(header) ? header[0] : header) ??
    (payload?.session_id as string | undefined) ??
    (payload?.conversation_id as string | undefined) ??
    (metadata?.session_id as string | undefined) ??
    (metadata?.conversation_id as string | undefined) ??
    (turnMetadata?.session_id as string | undefined) ??
    (turnMetadata?.conversation_id as string | undefined);
  const threadHeader =
    request.headers["thread-id"] ?? request.headers["x-codex-thread-id"];
  const clientMetadata = payload?.client_metadata as
    Record<string, unknown> | undefined;
  const threadValue =
    (Array.isArray(threadHeader) ? threadHeader[0] : threadHeader) ??
    (clientMetadata && typeof clientMetadata === "object"
      ? (clientMetadata.thread_id as string | undefined)
      : undefined) ??
    (turnMetadata?.thread_id as string | undefined);
  const thread =
    typeof threadValue === "string" && threadValue.trim()
      ? threadValue.trim()
      : null;
  if (typeof value === "string" && value.trim())
    return { key: value.trim(), scope: "identified", thread };
  return {
    key: PROCESS_FALLBACK_SESSION_KEY,
    scope: "process-fallback",
    thread
  };
}

export function hasWorkspaceClaim(
  payload: Record<string, unknown> | null | undefined,
  turnMetadataHeader: string | null
): boolean {
  const metadata = payload?.metadata as Record<string, unknown> | undefined;
  const explicitPaths = [
    ...WORKSPACE_KEYS.map((key) => payload?.[key]),
    ...(metadata && typeof metadata === "object"
      ? WORKSPACE_KEYS.map((key) => metadata[key])
      : [])
  ];
  if (
    explicitPaths.some(
      (value) =>
        value !== null &&
        value !== undefined &&
        (typeof value !== "string" || value.trim())
    )
  )
    return true;
  const clientMetadata = payload?.client_metadata as
    Record<string, unknown> | undefined;
  if (
    clientMetadata &&
    typeof clientMetadata === "object" &&
    Object.hasOwn(clientMetadata, "x-codex-turn-metadata")
  )
    return true;
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  return Boolean(turnMetadata && Object.hasOwn(turnMetadata, "workspaces"));
}

export function workspacePathLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const label = basename(value.trim());
  return label && label !== "." && label !== "/" ? label : null;
}

export function repositoryIdentity(remote: unknown): string | null {
  if (typeof remote !== "string" || !remote.trim()) return null;
  const normalized = remote.trim().replace(/^git@([^:]+):/, "https://$1/");
  let pathname: string;
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split(/[?#]/, 1)[0]!;
  }
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/\.git$/i, ""));
  if (parts.length < 2) return null;
  const owner = parts.at(-2)!.replaceAll(/[^A-Za-z0-9._-]/g, "");
  const repo = parts.at(-1)!.replaceAll(/[^A-Za-z0-9._-]/g, "");
  return owner && repo ? `${owner}/${repo}` : null;
}

export function workspaceContextFromRequest(
  request: IncomingMessage | Record<string, unknown>,
  payload: Record<string, unknown> | null | undefined,
  turnMetadataHeader: string | null
): { key: string; cwd: string | null; workspace_id?: string } {
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  const workspaces =
    turnMetadata?.workspaces &&
    typeof turnMetadata.workspaces === "object" &&
    !Array.isArray(turnMetadata.workspaces)
      ? (turnMetadata.workspaces as Record<string, Record<string, unknown>>)
      : {};
  const metadata = payload?.metadata as Record<string, unknown> | undefined;
  const explicitPaths = [
    ...WORKSPACE_KEYS.map((key) => payload?.[key]),
    ...(metadata && typeof metadata === "object"
      ? WORKSPACE_KEYS.map((key) => metadata[key])
      : [])
  ];
  const resolvableKeys = Object.keys(workspaces).filter(
    (value) => typeof value === "string" && value.trim() && isDirectory(value)
  );
  const path =
    (explicitPaths.find(
      (value) => typeof value === "string" && value.trim()
    ) as string | undefined) ??
    (resolvableKeys.length === 1 ? resolvableKeys[0] : null) ??
    null;
  const workspaceKeys = Object.keys(workspaces);
  const labelPath =
    path ??
    (resolvableKeys.length === 0 && workspaceKeys.length === 1
      ? workspaceKeys[0]
      : null);
  const matchingEntry =
    path && workspaces[path]
      ? workspaces[path]
      : resolvableKeys.length === 1
        ? workspaces[resolvableKeys[0]!]
        : workspaceKeys.length === 1
          ? workspaces[workspaceKeys[0]!]
          : null;
  const remotes = matchingEntry?.associated_remote_urls as
    Record<string, string> | undefined;
  const repository =
    remotes && typeof remotes === "object"
      ? (Object.values(remotes).map(repositoryIdentity).find(Boolean) ?? null)
      : null;
  const key = repository ?? workspacePathLabel(labelPath) ?? "unknown";
  const cwd = workspacePathLabel(labelPath);

  const rawId =
    (matchingEntry?.workspace_id as string | undefined) ??
    (matchingEntry?.workspaceId as string | undefined) ??
    (matchingEntry?.id as string | undefined) ??
    (turnMetadata?.workspace_id as string | undefined) ??
    (turnMetadata?.workspaceId as string | undefined) ??
    null;

  const derivedId =
    key === "unknown"
      ? null
      : `ws_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  const workspaceId =
    typeof rawId === "string" && rawId.trim()
      ? safeWorkspaceId(rawId)
      : derivedId;

  if (key !== "unknown") {
    if (workspaceId) registerWorkspaceId(workspaceId, key);
    if (derivedId) registerWorkspaceId(derivedId, key);
  }

  const context: { key: string; cwd: string | null; workspace_id?: string } = {
    key,
    cwd
  };
  if (workspaceId) context.workspace_id = workspaceId;
  return context;
}

export function addWorkspaceIdToTurnMetadata(
  payload: Record<string, unknown> | null | undefined,
  turnMetadataHeader: string | null
): string | null {
  const parsed = parseTurnMetadataJson(turnMetadataHeader);
  if (!parsed) return turnMetadataHeader;
  const context = workspaceContextFromRequest({}, payload, turnMetadataHeader);
  if (!context.workspace_id || parsed.workspace_id === context.workspace_id)
    return turnMetadataHeader;
  return JSON.stringify({ ...parsed, workspace_id: context.workspace_id });
}

export function workspaceMetadataForSession(
  payload: Record<string, unknown> | null | undefined,
  turnMetadataHeader: string | null,
  session: RouterSession | null
): string | null {
  const headers = turnMetadataHeader
    ? { "x-codex-turn-metadata": turnMetadataHeader }
    : {};
  let workspacePath: string | null = null;
  try {
    workspacePath = resolveCwd(payload, headers);
  } catch {
    /* ignore unresolvable */
  }
  if (workspacePath) {
    if (session?.scope === "identified")
      rememberWorkspaceMetadata(session.key, workspacePath);
    return addWorkspaceIdToTurnMetadata(
      payload,
      turnMetadataHeader ??
        JSON.stringify({ workspaces: { [workspacePath]: {} } })
    );
  }
  if (
    session?.scope === "identified" &&
    !hasWorkspaceClaim(payload, turnMetadataHeader)
  ) {
    const metadata = getWorkspaceMetadata(session.key) ?? turnMetadataHeader;
    return addWorkspaceIdToTurnMetadata(payload, metadata);
  }
  return turnMetadataHeader;
}

export function sendRouterAuthFailure(response: ServerResponse): void {
  sendJson(
    response,
    401,
    errorBody(
      "Router authentication is required.",
      "router_authentication_error",
      {
        code: "router_authentication_error",
        retryable: false
      }
    ),
    { "www-authenticate": "Bearer" }
  );
}

export async function loadCatalog(
  catalogFile = CATALOG_FILE
): Promise<{ models: unknown[]; data: unknown[] }> {
  try {
    const parsed = JSON.parse(await readFile(catalogFile, "utf8"));
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    return {
      models,
      data: models.map((model: { slug: string }) =>
        ROUTING_POLICY.providerModelMetadata(model.slug)
      )
    };
  } catch {
    return { models: [], data: [] };
  }
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`)
    .pathname;
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", router: "codex-model-router" });
    return;
  }
  if (pathname === "/health/readiness") {
    if (getDefaultRouterLifecycle().isDraining()) {
      sendJson(
        response,
        503,
        errorBody("Router is draining for shutdown.", "router_draining", {
          code: "router_draining",
          retryable: true
        })
      );
      return;
    }
    sendJson(response, 200, {
      status: "ready",
      router: "codex-model-router",
      lifecycle: getDefaultRouterLifecycle().getLifecycleStatus()
    });
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
      sendJson(
        response,
        405,
        errorBody("Method not allowed", "router_method_not_allowed", {
          code: "router_method_not_allowed"
        }),
        { allow: "POST" }
      );
      return;
    }
    const remoteAddress = request.socket?.remoteAddress;
    if (!isLoopbackAddress(remoteAddress)) {
      sendJson(
        response,
        403,
        errorBody(
          "Provider administration is restricted to loopback connections.",
          "router_access_denied",
          { code: "router_access_denied" }
        )
      );
      return;
    }
    const providerParam = providerMatch[1]!;
    const provider = providerParam.toLowerCase().trim();
    if (
      !ROUTING.providers[provider] &&
      !ROUTES.some((r) => r.provider === provider)
    ) {
      sendJson(
        response,
        404,
        errorBody(
          `Unknown provider: ${providerParam}`,
          "router_unknown_provider",
          { code: "router_unknown_provider" }
        )
      );
      return;
    }
    let payload: Record<string, unknown>;
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
      sendJson(
        response,
        400,
        errorBody("request body requires boolean 'enabled'")
      );
      return;
    }
    ROUTING_POLICY.setProviderEnabled(provider, payload.enabled);
    await persistRouterStateNow();
    sendJson(response, 200, {
      ok: true,
      provider,
      enabled: payload.enabled,
      status: payload.enabled
        ? COOLDOWNS.isCooling(provider)
          ? (COOLDOWNS.get(provider)?.failureClass ?? "cooldown")
          : "ready"
        : "disabled"
    });
    return;
  }
  if (
    pathname === "/v1/responses" &&
    request.method === "POST" &&
    !routerAuthorizationValid(request)
  ) {
    sendRouterAuthFailure(response);
    return;
  }
  if (pathname === AGENT_EVENTS_PATH && request.method === "POST") {
    try {
      const result = ingestAgentEvents(JSON.parse(await requestBody(request)));
      if (result.reason === "unknown_request_id") {
        sendJson(
          response,
          404,
          errorBody(
            "No router request matches the reported request id.",
            "router_unknown_request",
            { code: "router_unknown_request" }
          )
        );
        return;
      }
      sendJson(response, 200, result);
    } catch {
      sendJson(
        response,
        400,
        errorBody("Agent event request must be valid JSON")
      );
    }
    return;
  }
  const otelSignals: Record<string, "logs" | "traces" | "metrics"> = {
    "/v1/logs": "logs",
    "/v1/traces": "traces",
    "/v1/metrics": "metrics"
  };
  if (request.method === "POST" && otelSignals[pathname]) {
    try {
      const payload = JSON.parse(await requestBody(request));
      ingestOtelSignal(otelSignals[pathname]!, payload);
      sendJson(response, 200, {});
    } catch {
      getDefaultOtelTracker().otelTelemetry.receiver.invalid += 1;
      sendJson(response, 400, errorBody("OTLP request must be valid JSON"));
    }
    return;
  }
  if (pathname !== "/v1/responses" || request.method !== "POST") {
    sendJson(response, 404, errorBody("not found"));
    return;
  }
  if (getDefaultRouterLifecycle().isDraining()) {
    sendJson(
      response,
      503,
      errorBody(
        "Router is draining for shutdown; please retry against another instance.",
        "router_draining",
        { code: "router_draining", retryable: true }
      ),
      { "retry-after": "5" }
    );
    return;
  }
  let payload: Record<string, unknown>;
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
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!model) {
    sendJson(
      response,
      400,
      errorBody("request body requires a non-empty string model")
    );
    return;
  }
  payload = { ...payload, model };
  const role = ROUTING_POLICY.roleForModel(model);
  const requestId = String(request.headers["x-request-id"] ?? randomUUID());
  const wantsStream = payload.stream !== false;
  const turnMetadataHeader = resolveTurnMetadataHeader(request, payload);
  const session = requestSession(request, payload, turnMetadataHeader);
  noteRequestThread(requestId, session.thread);
  const effectiveTurnMetadataHeader = workspaceMetadataForSession(
    payload,
    turnMetadataHeader,
    session
  );
  const workspace = workspaceContextFromRequest(
    request,
    payload,
    effectiveTurnMetadataHeader
  );
  const clientAbort = new AbortController();
  const abortForRequest = () => clientAbort.abort();
  const abortForRequestClose = () => {
    if (!request.complete) clientAbort.abort();
  };
  const abortForResponseClose = () => {
    if (!response.writableEnded && !response.destroyed) clientAbort.abort();
  };

  getDefaultRouterLifecycle().registerActiveRequest(clientAbort);
  request.once("aborted", abortForRequest);
  request.once("close", abortForRequestClose);
  response.once("close", abortForResponseClose);
  try {
    if (model === ORCHESTRATOR_ALIAS) {
      await proxyOrchestratorResponse(
        response,
        payload,
        wantsStream,
        requestId,
        effectiveTurnMetadataHeader,
        workspace,
        clientAbort.signal,
        session
      );
      return;
    }
    if (role) {
      const denialReason =
        getDefaultConcurrencyManager().tryAcquireSubagentSlot(session.key);
      if (denialReason) {
        recordConcurrencyDenial({
          requestId,
          role,
          requestedModel: payload.model,
          sessionScope: session.scope,
          reason: denialReason
        });
        sendJson(
          response,
          429,
          errorBody(
            `Subagent denied by configured ${denialReason} limit.`,
            "router_concurrency_limit",
            {
              code: "router_concurrency_limit",
              retryable: true,
              failureClass: "concurrency_limit",
              model,
              requestId
            }
          ),
          { "retry-after": "1", "x-autodev-request-id": requestId }
        );
        return;
      }
      try {
        recordSubagentSpawn({
          mechanism: "router_alias",
          provider: orchestratorProviderForSession(session.key),
          role,
          tool: "multi_agent_v1.spawn",
          requestId,
          workspace: workspace?.key ?? null
        });
        await proxyRoleResponse(
          response,
          role,
          payload,
          wantsStream,
          requestId,
          effectiveTurnMetadataHeader,
          workspace,
          clientAbort.signal,
          session
        );
      } finally {
        getDefaultConcurrencyManager().releaseSubagentSlot(session.key);
      }
      return;
    }
    const route = ROUTING_POLICY.routeForModel(payload.model as string);
    if (!route) {
      sendJson(
        response,
        400,
        errorBody(
          `No local route is configured for model ${String(payload.model)}`
        )
      );
      return;
    }
    await proxyConcreteResponse(
      response,
      route,
      payload,
      wantsStream,
      requestId,
      effectiveTurnMetadataHeader,
      workspace,
      clientAbort.signal,
      session
    );
  } finally {
    getDefaultRouterLifecycle().unregisterActiveRequest(clientAbort);
    request.removeListener("aborted", abortForRequest);
    request.removeListener("close", abortForRequestClose);
    response.removeListener("close", abortForResponseClose);
  }
}

export async function handle(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    return await handleRequest(request, response);
  } catch (error) {
    const info = transportErrorInfo(error);
    writeErrorLine(
      JSON.stringify({
        schema: "autodev-router-event-v1",
        timestamp: new Date().toISOString(),
        routerInstanceId: ROUTER_INSTANCE_ID,
        requestId: null,
        phase: "router_error",
        errorName: info.name,
        errorCode: info.code,
        syscall: info.syscall
      })
    );
    if (response.writableEnded || response.destroyed) return;
    try {
      if (response.headersSent) {
        try {
          response.write(
            responseFailureEvent("The router could not complete the request.")
          );
        } catch {}
        response.end();
      } else {
        sendJson(
          response,
          502,
          errorBody(
            "The router could not complete the request.",
            "router_internal_error",
            { code: "router_internal_error", retryable: true }
          )
        );
      }
    } catch {
      /* client disconnect absorbed */
    }
  }
}
