import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import {
  type ControlApiLiveAgentCounts,
  type ControlApiProviderCheck,
  type ControlApiProviderCheckResponse,
  type ControlApiProviderCooldown,
  type ControlApiProviderHealth,
  type ControlApiProviderModelDiscovery,
  type ControlApiProviderQuota,
  SIGN_IN_REQUIRED_FAILURE_CLASS
} from "@simulatorlife/autodev-core";
import {
  createAgentActivityTracker,
  resolveAgentActivityTtlMs
} from "@simulatorlife/autodev-runtime/agents";
import {
  authStatus,
  routerAuthorizationValid
} from "@simulatorlife/autodev-runtime/router/auth";
import {
  ConcurrencyManager,
  getDefaultConcurrencyManager,
  PROCESS_FALLBACK_SESSION_KEY,
  setDefaultConcurrencyManager,
  SUBAGENT_SLOT_KIND
} from "@simulatorlife/autodev-runtime/router/concurrency";
import {
  COOLDOWN_CONFIG,
  type CooldownEntry,
  COOLDOWNS,
  PROBE_FAILURE_CLASS
} from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  getDefaultRouterEventRecorder,
  isRequestRefusalClass,
  noteRequestIdentity,
  recordRouterEvent,
  type RouterEvent,
  RouterEventRecorder,
  setDefaultRouterEventRecorder,
  type WorkspaceInput
} from "@simulatorlife/autodev-runtime/router/events";
import {
  getDefaultRouterLifecycle,
  RouterLifecycle,
  setDefaultRouterLifecycle
} from "@simulatorlife/autodev-runtime/router/lifecycle";
import { LiveFeedRecorder } from "@simulatorlife/autodev-runtime/router/live-feed";
import {
  effectiveStateFile,
  getDefaultPersistenceManager,
  restoreProviderTelemetrySection,
  RouterPersistence,
  scheduleRouterStatePersist,
  setDefaultPersistenceManager
} from "@simulatorlife/autodev-runtime/router/persistence";
import {
  ORCHESTRATOR_ALIAS,
  ORCHESTRATOR_REASONING_EFFORT,
  ORCHESTRATOR_TIER,
  ROUTES,
  ROUTING_CONFIG as ROUTING,
  ROUTING_CONFIG_FILE,
  ROUTING_POLICY
} from "@simulatorlife/autodev-runtime/router/routing";
import {
  CodexStateCollector,
  type CodexStateSnapshot,
  loadCodexStateCollectorConfig
} from "@simulatorlife/autodev-runtime/router/state-collector";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  isDirectory,
  parseTurnMetadataJson,
  resolveCwd,
  WORKSPACE_KEYS
} from "@simulatorlife/autodev-runtime/shared/resolve-workspace";

import {
  handleControlApiRequest,
  setControlApiLiveAgentCountsSource,
  setControlApiMcpObservationsSource,
  setControlApiProviderHealthSource
} from "../control-api/request-handler.ts";
import {
  providerModelDiscoveryPersistenceSnapshot,
  restoreProviderModelDiscoveryPersistence
} from "../providers/model-discovery.ts";
import { getCachedProviderQuota } from "../providers/quota-discovery.ts";
import { createAgentEventIngest } from "./agent-event-ingest.ts";
import {
  correlationSnapshot,
  correlationStatus,
  CorrelationTracker,
  MCP_OBSERVATION_TTL_MS,
  mcpServerObservations,
  restoreCorrelation,
  setDefaultCorrelationTracker
} from "./correlation.ts";
import {
  activeProviderRequests,
  activitySubjectFor,
  CHAIN_SELECTION_DEADLINE_MS,
  CONCRETE_STATUS_MAX_ATTEMPTS,
  errorBody,
  EXHAUSTION_WAIT_MS,
  getActiveRequests,
  LAST_RESORT_MAX_ATTEMPTS,
  PROBE_TIMEOUT_MS,
  probeProvider,
  type ProviderProbeResult,
  proxyConcreteResponse,
  proxyOrchestratorResponse,
  proxyRoleResponse,
  responseFailureEvent,
  ROUTER_INSTANCE_ID,
  type RouterSession,
  sendJson,
  STREAM_IDLE_TIMEOUT_MS,
  transportErrorInfo,
  UPSTREAM_RETRY_BASE_MS,
  UPSTREAM_RETRY_MAX_MS,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_TRANSPORT_MAX_ATTEMPTS
} from "./proxy.ts";
import {
  AGENT_EVENTS_PATH,
  closeBridgeSubagentsForRequest,
  getDefaultExecutionContract,
  getWorkspaceMetadata,
  orchestratorProviderForSession,
  providerCapabilities,
  recordSpawnFailure,
  recordSubagentSpawn,
  rememberWorkspaceMetadata,
  resetSpawnFailureTelemetry,
  resetSubagentTelemetry,
  setDefaultSubagentRegistry,
  spawnFailureStatus,
  SubagentRegistry,
  subagentStatus
} from "./subagents.ts";
import {
  observeRouterWorkspaceGitCommits,
  withExtractedTraceContext
} from "./telemetry.ts";
import { installUpstreamShapeHooks } from "./upstream-shape-hooks.ts";
import {
  getDefaultUsageTracker,
  type RecordUsageEventParams,
  safeWorkspaceId,
  usageOrigin,
  type UsageTracker
} from "./usage.ts";

const GIT_REMOTE_PATTERN = /^git@([^:]+):/;
const GIT_EXTENSION_PATTERN = /\.git$/i;
const REPO_ID_SANITIZE_PATTERN = /[^A-Za-z0-9._-]/g;
const URL_QUERY_FRAGMENT_SPLIT_PATTERN = /[?#]/;

export const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
export const PORT = Number.parseInt(
  process.env.CODEX_MODEL_ROUTER_PORT ?? "4100"
);
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
const ROUTER_STARTED_AT = new Date().toISOString();
const SHUTDOWN_DRAIN_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_ROUTER_SHUTDOWN_DRAIN_MS ?? "30000"
);

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
        model?: string | null;
      } | null,
      lastCheck: null as ControlApiProviderCheck | null
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
  process.env.CODEX_ROUTER_MAX_RECENT_EVENTS ?? "100"
);
const liveFeedEvents = new LiveFeedRecorder();

export const ingestAgentEvents = createAgentEventIngest({
  agentActivity,
  liveFeedEvents
});

function usageWorkspaceForEvent(
  workspaceKey: string | null,
  cwd: string | null,
  rawWorkspace: string | WorkspaceInput | null | undefined
): string | { key: string; cwd?: string | null; workspace_id?: string } | null {
  if (workspaceKey == null) return null;
  const workspaceId =
    rawWorkspace &&
    typeof rawWorkspace === "object" &&
    typeof rawWorkspace.workspace_id === "string"
      ? rawWorkspace.workspace_id
      : undefined;
  return workspaceId
    ? { key: workspaceKey, cwd, workspace_id: workspaceId }
    : { key: workspaceKey, cwd };
}

const USAGE_ELIGIBLE_PHASES = new Set(["selected", "skipped", "result"]);

// The single owner of RouterEvent -> Usage projection. Used by both the live
// onEvent listener (which also has the raw RecordRouterEventInput, so it can
// read an explicit, validated workspace_id) and persisted-event replay
// (which only has the already-recorded RouterEvent fields, origin included, so
// a replayed child-thread request stays a subagent request). Requests without
// a requestId cannot be keyed and are intentionally skipped rather than
// invented; a null/unknown outcome is omitted rather than coerced to failure.
function usageEventFromRouterEvent(
  event: RouterEvent,
  rawWorkspace: string | WorkspaceInput | null | undefined
): RecordUsageEventParams | null {
  if (
    !event.requestId ||
    !event.provider ||
    !event.model ||
    !USAGE_ELIGIBLE_PHASES.has(event.phase)
  ) {
    return null;
  }
  return {
    phase: event.phase,
    requestId: event.requestId,
    subject: event.activitySubject ?? null,
    role: event.role,
    provider: event.provider,
    model: event.model,
    workspace: usageWorkspaceForEvent(event.workspace, event.cwd, rawWorkspace),
    ...(event.outcome == null ? {} : { outcome: event.outcome }),
    failureClass: event.failureClass,
    status: event.status,
    elapsedMs: event.elapsedMs,
    toolCalls: event.toolCalls,
    timestamp: event.timestamp,
    origin: event.origin ?? usageOrigin(event.role)
  };
}

function isNonProviderHealthFailureClass(
  failureClass: string | null | undefined
): boolean {
  return (
    isRequestRefusalClass(failureClass) ||
    failureClass === "provider_disabled" ||
    failureClass === "model_disabled" ||
    failureClass === "request_error"
  );
}

function isNonProviderHealthFailure(event: RouterEvent): boolean {
  return (
    event.outcome === "client_aborted" ||
    isNonProviderHealthFailureClass(event.failureClass)
  );
}

/** Fold one routing event into the provider's health counters. */
function applyProviderHealthEvent(event: RouterEvent): void {
  const state = event.provider ? providerState(event.provider) : null;
  if (state && event.phase === "selected") {
    state.attempts += 1;
    state.lastAttemptAt = event.timestamp;
  } else if (state && event.phase === "skipped") {
    state.skipped += 1;
    if (!isNonProviderHealthFailure(event)) {
      state.lastFailureClass = event.failureClass;
    }
  } else if (state && event.phase === "result") {
    if (event.outcome === "success") {
      state.successes += 1;
      state.lastSuccessAt = event.timestamp;
      state.lastFailureClass = null;
      state.lastFailure = null;
    } else if (!isNonProviderHealthFailure(event)) {
      state.failures += 1;
      state.lastFailureAt = event.timestamp;
      state.lastFailureClass = event.failureClass;
      state.lastFailure = {
        timestamp: event.timestamp,
        class: event.failureClass,
        status: event.status,
        ...(event.model ? { model: event.model } : {})
      };
    }
  }
}

const routerEvents = new RouterEventRecorder({
  maxRecentEvents: MAX_RECENT_EVENTS,
  routerInstanceId: ROUTER_INSTANCE_ID,
  resolveOrigin: (role) => usageOrigin(role),
  onEvent: (event, input) => {
    const workspaceSessionKey =
      event.thread ??
      (event.activitySubject?.startsWith("thread:")
        ? event.activitySubject.slice("thread:".length)
        : event.activitySubject);
    void observeRouterWorkspaceGitCommits({
      phase: event.phase,
      workspaceKey: event.workspace,
      // The observer reads the workspace's repository, and the session is
      // what knows which directory that is. The remembered turn metadata is
      // a JSON document rather than a path, and handing that over made the
      // observer's directory check fail for every request -- so no commit
      // was ever measured, and the Git metrics stayed empty no matter what
      // the agents committed.
      sessionKey: workspaceSessionKey,
      routerInstanceId: ROUTER_INSTANCE_ID
    });
    liveFeedEvents.record({
      category: "routing",
      type: `routing.${event.phase}`,
      summary: `${event.phase}${event.provider ? ` ${event.provider}` : ""}${event.model ? `/${event.model}` : ""}`,
      timestamp: event.timestamp,
      requestId: event.requestId,
      provider: event.provider,
      model: event.model,
      role: event.role,
      workspace:
        typeof input.workspace === "string"
          ? input.workspace
          : (input.workspace?.key ?? null),
      phase: event.phase,
      outcome: event.outcome,
      status: event.status,
      failureClass: event.failureClass,
      denialReason: event.denialReason,
      spawnFailureReason: event.spawnFailureReason,
      durationMs: event.elapsedMs,
      name: event.model ? `${event.provider ?? ""}/${event.model}` : null
    });
    const usageEvent = usageEventFromRouterEvent(event, input.workspace);
    if (usageEvent) getDefaultUsageTracker().recordUsageEvent(usageEvent);
    if (event.phase === "result")
      closeBridgeSubagentsForRequest(
        String(event.requestId ?? ""),
        String(event.outcome ?? "") as "success" | "failure",
        event.elapsedMs
      );
    applyProviderHealthEvent(event);
    scheduleRouterStatePersist();
  }
});
setDefaultRouterEventRecorder(routerEvents);

const subagentRegistry = new SubagentRegistry({
  agentActivity,
  executionContract: getDefaultExecutionContract(),
  onRecordRouterEvent: (event) => recordRouterEvent(event),
  onRecordUsageEvent: (event) =>
    getDefaultUsageTracker().recordUsageEvent(event),
  onSchedulePersist: () => scheduleRouterStatePersist(),
  getSpawnCapableProviders: () =>
    Object.keys(ROUTING.providers).filter(
      (provider) => providerCapabilities(provider).subagentSpawn
    )
});
setDefaultSubagentRegistry(subagentRegistry);

const otelTracker = new CorrelationTracker({
  healthTtlMs: MCP_OBSERVATION_TTL_MS,
  usageTracker: getDefaultUsageTracker(),
  getConversationThread: (id) => {
    const thread = codexState.lastSnapshot?.conversationThreads?.[id];
    return thread ? { ...thread } : null;
  },
  getBridgeRequestContext: (id) => subagentRegistry.getBridgeRequestContext(id),
  onSchedulePersist: () => scheduleRouterStatePersist()
});
setDefaultCorrelationTracker(otelTracker);

const CODEX_CONFIG_FILE =
  process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ?? `${CODEX_HOME}/config.toml`;
const concurrencyManager = new ConcurrencyManager({
  agentActivity,
  configFile: CODEX_CONFIG_FILE,
  configFileSource: process.env.CODEX_ROUTER_CODEX_CONFIG_FILE
    ? "env_override"
    : "default_codex_home",
  getOrchestratorSession: (key) => subagentRegistry.orchestratorSessionInfo(key)
});
setDefaultConcurrencyManager(concurrencyManager);

ROUTING_POLICY.setRuntime({
  providerFailureStreak: (provider) => COOLDOWNS.failureStreak(provider),
  liveProviderCount: (provider) =>
    getDefaultUsageTracker().countLiveAgentActivity({ provider })
});
COOLDOWNS.setRuntime({
  isProviderEnabled: (provider, role) =>
    ROUTING_POLICY.isProviderEnabledForRole(provider, role),
  isKnownProvider: (provider) => Object.hasOwn(ROUTING.providers, provider),
  lastFailureClass: (provider) => providerState(provider).lastFailureClass
});
installUpstreamShapeHooks();

export const codexState = {
  collector: new CodexStateCollector(loadCodexStateCollectorConfig()),
  lastSnapshot: null as Partial<CodexStateSnapshot> | null,
  livePollStarted: false
};

export async function refreshCodexState(): Promise<void> {
  try {
    const snapshot = await codexState.collector.collectSnapshot();
    assignCodexSnapshot(snapshot);
  } catch (error) {
    assignCodexSnapshot({
      localTelemetry: {
        status: "error",
        path: null,
        schema: null,
        capabilities: { tables: {}, columnCount: 0 },
        recencyWindowMs: null,
        limit: null,
        threadCount: 0,
        projectCount: 0,
        edgeCount: 0,
        fileSizeBytes: null,
        collectedAt: new Date().toISOString(),
        durationMs: null,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

const ROUTING_POLICY_PERSISTENCE_SECTIONS = new Set([
  "roleAssignments",
  "disabledProviders",
  "disabledModels",
  "disabledAgentRoles",
  "agentEnablementRevisions",
  "providerLimits",
  "agentModels"
]);

function restorePersistedSection(args: {
  section: string;
  value: unknown;
  parsed: Record<string, unknown>;
}): void {
  const { section, value, parsed } = args;
  if (ROUTING_POLICY_PERSISTENCE_SECTIONS.has(section)) {
    ROUTING_POLICY.restoreRuntimeState({
      ...ROUTING_POLICY.runtimeState(),
      [section]: value
    });
    return;
  }
  if (section === "providerTelemetry") {
    restoreProviderTelemetrySection(providerTelemetry, value);
    return;
  }
  if (section === "providerModelDiscovery") {
    if (!restoreProviderModelDiscoveryPersistence(value)) {
      writeErrorLine(
        "Warning: invalid persisted provider model-discovery state was discarded."
      );
    }
    return;
  }
  if (section === "usage") {
    getDefaultUsageTracker().restoreUsagePersistenceSnapshot(value);
    return;
  }
  if (section === "concurrency" && value && typeof value === "object") {
    concurrencyManager.restorePersistence(value as Record<string, unknown>);
    return;
  }
  if (section === "spawnFailures" && value && typeof value === "object") {
    subagentRegistry.restoreSpawnFailureTelemetry(value);
    return;
  }
  if (section === "correlation") {
    restoreCorrelation(value);
    return;
  }
  if (section === "subagents" && value && typeof value === "object") {
    subagentRegistry.restoreSubagentTelemetry(value);
    return;
  }
  if (section === "providerCooldowns" && Array.isArray(value)) {
    COOLDOWNS.restoreHardEntries(value, Date.now());
    return;
  }
  if (section === "liveFeed" && Array.isArray(value)) {
    liveFeedEvents.restore(value);
    return;
  }
  if (section === "recentEvents" && Array.isArray(value)) {
    restoreRecentEvents(value, parsed);
  }
}

function restoreRecentEvents(
  value: unknown[],
  parsed: Record<string, unknown>
): void {
  routerEvents.restore(value);
  if (parsed.usage) return;
  getDefaultUsageTracker().resetUsageTelemetry();
  for (const event of routerEvents.getRecentEvents()) {
    const usageEvent = usageEventFromRouterEvent(event, null);
    if (usageEvent) getDefaultUsageTracker().recordUsageEvent(usageEvent);
  }
  getDefaultUsageTracker().inFlightUsage.clear();
}

function assignCodexSnapshot(
  snapshot: Partial<CodexStateSnapshot> | null
): void {
  codexState.lastSnapshot = snapshot;
}

export function setCodexStateSnapshotForTests(
  snapshot: Partial<CodexStateSnapshot> | null
): void {
  assignCodexSnapshot(
    snapshot && typeof snapshot === "object" ? snapshot : null
  );
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
  const { path: _path, ...safeLocalTelemetry } = snapshot.localTelemetry ?? {};
  return {
    localTelemetry: {
      ...safeLocalTelemetry,
      pathConfigured: Boolean(snapshot.localTelemetry?.path)
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
      lastFailure: null,
      lastCheck: null
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
    ...ROUTING_POLICY.runtimeState(),
    providerTelemetry: Object.fromEntries(providerTelemetry),
    providerModelDiscovery: providerModelDiscoveryPersistenceSnapshot(),
    usage: getDefaultUsageTracker().usagePersistenceSnapshot(),
    concurrency: concurrencyManager.persistenceSnapshot(),
    subagents: subagentRegistry.subagentTelemetry,
    spawnFailures: subagentRegistry.spawnFailureTelemetry,
    providerCooldowns: COOLDOWNS.persistedHardEntries(),
    recentEvents: routerEvents.getRecentEvents(false),
    liveFeed: liveFeedEvents.getRecentEvents(false, true),
    correlation: correlationSnapshot()
  }),
  restoreSection: (section, value, parsed) => {
    restorePersistedSection({ section, value, parsed });
  }
});
setDefaultPersistenceManager(routerPersistence);

/**
 * Record what a provider's model listing said about its account.
 *
 * A browser-driven bridge reads its models from the signed-in site, so the
 * periodic listing is the first to find a site signed out -- usually long
 * before a request is routed there. A listing that says so is a provider
 * failure (`sign_in_required`), the same evidence a turn refused for it
 * would leave, so the provider stops reading Ready while it waits for the
 * operator. A listing that succeeds again withdraws that failure, and only
 * that failure: it is not evidence the provider serves turns.
 */
export function recordProviderSignIn(
  provider: string,
  detail: string | null,
  at: string = new Date().toISOString()
): void {
  const state = providerState(provider);
  if (detail === null) {
    if (state.lastFailure?.class !== SIGN_IN_REQUIRED_FAILURE_CLASS) return;
    state.lastFailure = null;
    state.lastFailureClass = null;
  } else {
    state.lastFailureAt = at;
    state.lastFailureClass = SIGN_IN_REQUIRED_FAILURE_CLASS;
    state.lastFailure = {
      timestamp: at,
      class: SIGN_IN_REQUIRED_FAILURE_CLASS,
      status: 401
    };
  }
  scheduleRouterStatePersist();
}

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
  getDefaultUsageTracker().resetUsageTelemetry();
  getDefaultConcurrencyManager().resetConcurrencyTelemetry();
  resetSubagentTelemetry();
  resetSpawnFailureTelemetry();
  COOLDOWNS.clearAll();
  scheduleRouterStatePersist();
}

export function routingStatus() {
  return {
    ...ROUTING_POLICY.runtimeState(),
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
    providerGroups: ROUTING_POLICY.effectiveTierGroups(),
    priorities: Object.fromEntries(
      ROUTES.map((route) => [
        route.provider,
        Object.fromEntries(
          Object.entries(ROUTING_POLICY.effectiveTierGroups()).flatMap(
            ([tier, groups]) => {
              const index = groups.findIndex((group) =>
                group.includes(route.provider.toLowerCase())
              );
              return index === -1 ? [] : [[tier, `P${index + 1}`]];
            }
          )
        )
      ])
    ),
    configuredProviders: Object.keys(ROUTING.providers),
    // The providers that can serve the orchestrator right now: enabled for it,
    // and able to. A provider with no delegation path is enabled and ranked
    // for the role, and the router still refuses it -- so listing it here as
    // an orchestrator provider is the report that started this: an operator
    // disabled every other provider on the strength of it and was then told
    // that no provider was enabled.
    enabledOrchestratorProviders: Object.keys(ROUTING.providers).filter((p) =>
      ROUTING_POLICY.canProviderServeRole(p, "orchestrator")
    ),
    // Enabled for the orchestrator and unable to serve it. Named separately
    // because the fix is not an enable switch.
    incapableOrchestratorProviders: Object.keys(ROUTING.providers).filter(
      (p) =>
        ROUTING_POLICY.isProviderEnabledForRole(p, "orchestrator") &&
        ROUTING_POLICY.providerRoleCapabilityReason(p, "orchestrator") !== null
    ),
    enabledSubagentProviders: Object.keys(ROUTING.providers).filter((p) =>
      ROUTING_POLICY.canProviderServeRole(p, "subagent")
    ),
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
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    upstreamRetryBaseMs: UPSTREAM_RETRY_BASE_MS,
    upstreamRetryMaxMs: UPSTREAM_RETRY_MAX_MS,
    concreteStatusMaxAttempts: CONCRETE_STATUS_MAX_ATTEMPTS,
    upstreamTransportMaxAttempts: UPSTREAM_TRANSPORT_MAX_ATTEMPTS,
    shutdownDrainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
    maxConcurrentThreadsPerSession:
      getDefaultConcurrencyManager().effectivePerSessionLimit()
  };
}

export function agentsStatus(at = Date.now()): Record<string, unknown> {
  const projection = getDefaultUsageTracker().projectLiveAgents(at);
  const liveAgents = projection.allLiveAgents;
  const byState = agentActivity.snapshot(at).byState;
  const liveByKind: Record<string, number> = {};
  for (const agent of liveAgents) {
    const kind =
      typeof agent.kind === "string" && agent.kind ? agent.kind : "session";
    liveByKind[kind] = (liveByKind[kind] ?? 0) + 1;
  }
  return {
    schema: "autodev-agent-status-v1",
    canonicalLiveCount: projection.canonicalTotal,
    byState,
    liveByKind,
    liveByRole: projection.byRole,
    liveByOrigin: projection.byOrigin,
    liveByProvider: projection.byProvider,
    liveByModel: projection.byModel,
    liveByWorkspace: projection.byWorkspace,
    missingProvider: projection.missingProvider,
    missingModel: projection.missingModel,
    slotVsAgent: {
      agentLive: projection.canonicalTotal,
      admissionSlots: agentActivity.countLive({ kind: SUBAGENT_SLOT_KIND }, at),
      activeAdmissionSessions: agentActivity.distinctTags(
        { kind: SUBAGENT_SLOT_KIND },
        at
      ).length,
      processFallbackActiveThreads: agentActivity.countLive(
        { kind: SUBAGENT_SLOT_KIND, tag: PROCESS_FALLBACK_SESSION_KEY },
        at
      )
    },
    reconciledWithConcurrency: true
  };
}

function controlApiLiveAgentCounts(now: number): ControlApiLiveAgentCounts {
  const projection = getDefaultUsageTracker().projectLiveAgents(now);
  return {
    count: projection.canonicalTotal,
    byRole: projection.byRole,
    byProvider: projection.byProvider,
    byModel: projection.byModel,
    byWorkspace: projection.byWorkspace,
    byProviderRole: projection.byProviderRole,
    byModelRole: projection.byModelRole,
    missingProvider: projection.missingProvider,
    missingModel: projection.missingModel
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

function providerTierPriorities(provider: string): string[] {
  return Object.entries(ROUTING_POLICY.effectiveTierGroups()).flatMap(
    ([tier, groups]) => {
      const index = groups.findIndex((group) =>
        group.includes(provider.toLowerCase())
      );
      return index === -1 ? [] : [`${tier}: P${index + 1}`];
    }
  );
}

/**
 * The models of one provider that are out.
 *
 * A cooldown belongs to the route that failed, not to the provider: a rejected
 * model cools one model. The provider-wide cooldown is therefore only non-null
 * when the whole provider is out, and the models that are out are named here
 * -- otherwise a provider with one rejected model reads as "ready" and the
 * traffic that vanished has nowhere to show up.
 */
function scopedProviderCooldowns(
  provider: string,
  now: number
): Record<string, unknown> {
  const models = COOLDOWNS.getModelCooldowns(provider, now);
  const serialize = (entries: Record<string, CooldownEntry>) =>
    Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [
        name,
        serializeProviderCooldown(entry, now)
      ])
    );
  return {
    ...(Object.keys(models).length > 0
      ? { modelCooldowns: serialize(models) }
      : {})
  };
}

/** A provider's cooldown as the status response states it; all-clear when none. */
function providerCooldownFields(
  cooldown: CooldownEntry | null,
  now: number
): {
  cooldownKind: CooldownEntry["kind"] | null;
  cooldownFailureClass: string | null;
  cooldownResetsAt: string | null;
  cooldownUntil: string | null;
  cooldownRemainingMs: number;
  lastResortEligible: boolean;
} {
  if (cooldown === null) {
    return {
      cooldownKind: null,
      cooldownFailureClass: null,
      cooldownResetsAt: null,
      cooldownUntil: null,
      cooldownRemainingMs: 0,
      lastResortEligible: true
    };
  }
  return {
    cooldownKind: cooldown.kind,
    cooldownFailureClass: cooldown.failureClass ?? null,
    cooldownResetsAt: cooldown.resetsAt ?? null,
    cooldownUntil: new Date(cooldown.until).toISOString(),
    cooldownRemainingMs: cooldown.until - now,
    lastResortEligible: COOLDOWNS.allowsLastResort(cooldown, now)
  };
}

function routerProviderStatus(
  route: (typeof ROUTES)[number],
  now: number,
  projection: ReturnType<UsageTracker["projectLiveAgents"]>
): [string, Record<string, unknown>] {
  const state = providerState(route.provider);
  const activeLastFailure =
    state.lastFailure &&
    !isNonProviderHealthFailureClass(state.lastFailure.class)
      ? state.lastFailure
      : null;
  const cooldown = COOLDOWNS.get(route.provider, now);
  const inFlightRequests = getActiveRequests(route.provider);
  const active = projection.byProvider[route.provider] ?? 0;
  const orchestratorEnabled = ROUTING_POLICY.isProviderEnabledForRole(
    route.provider,
    "orchestrator"
  );
  const orchestratorCapable =
    ROUTING_POLICY.providerRoleCapabilityReason(
      route.provider,
      "orchestrator"
    ) === null;
  const subagentEnabled = ROUTING_POLICY.isProviderEnabledForRole(
    route.provider,
    "subagent"
  );
  const tierPrios = providerTierPriorities(route.provider);
  const readiness = cooldown
    ? (cooldown.failureClass ?? state.lastFailureClass ?? "cooldown")
    : "ready";
  const cooldownFields = providerCooldownFields(cooldown, now);
  return [
    route.provider,
    {
      orchestratorEnabled,
      orchestratorCapable,
      subagentEnabled,
      status: readiness,
      orchestratorStatus: orchestratorEnabled
        ? orchestratorCapable
          ? readiness
          : "cannot_delegate"
        : "disabled",
      subagentStatus: subagentEnabled ? readiness : "disabled",
      routingPriority: tierPrios.length > 0 ? tierPrios.join(" · ") : "—",
      limits: cooldownFields,
      ...scopedProviderCooldowns(route.provider, now),
      active,
      inFlightRequests,
      ...cooldownFields,
      failureStreak: COOLDOWNS.failureStreak(route.provider) ?? 0,
      probeFailureStreak: COOLDOWNS.probeFailureStreak(route.provider) ?? 0,
      configuredModels: ROUTING_POLICY.effectiveModels(route.provider),
      agentModels: ROUTING_POLICY.agentModelsFor(route.provider),
      capabilities: providerCapabilities(route.provider),
      attempts: state.attempts,
      successes: state.successes,
      failures: state.failures,
      skipped: state.skipped,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: activeLastFailure ? state.lastFailureAt : null,
      lastFailure: activeLastFailure
    }
  ];
}

function serializeProviderCooldown(
  cooldown: CooldownEntry,
  now: number
): ControlApiProviderCooldown {
  return {
    kind: cooldown.kind,
    failureClass: cooldown.failureClass ?? null,
    until: new Date(cooldown.until).toISOString(),
    resetsAt: cooldown.resetsAt ?? null,
    lastResortEligible: COOLDOWNS.allowsLastResort(cooldown, now),
    ...(cooldown.model === undefined ? {} : { scope: "model" as const }),
    ...(cooldown.model === undefined ? {} : { model: cooldown.model })
  };
}

/** Typed live provider evidence the Control API serves to the Console. */
function controlApiProviderHealth(
  now: number
): Record<string, ControlApiProviderHealth> {
  const projection = getDefaultUsageTracker().projectLiveAgents(now);
  return Object.fromEntries(
    ROUTES.map((route) => {
      const state = providerState(route.provider);
      const cooldown = COOLDOWNS.get(route.provider, now);
      const rawModelCooldowns = COOLDOWNS.getModelCooldowns(
        route.provider,
        now
      );
      const modelCooldownEntries = Object.entries(rawModelCooldowns).map(
        ([model, entry]) => [model, serializeProviderCooldown(entry, now)]
      );
      const quota = getCachedProviderQuota(route.provider, now);
      const activeLastFailure =
        state.lastFailure &&
        !isNonProviderHealthFailureClass(state.lastFailure.class)
          ? state.lastFailure
          : null;
      const health: ControlApiProviderHealth = {
        cooldown: cooldown ? serializeProviderCooldown(cooldown, now) : null,
        ...(modelCooldownEntries.length > 0
          ? { modelCooldowns: Object.fromEntries(modelCooldownEntries) }
          : {}),
        failureStreak: COOLDOWNS.failureStreak(route.provider) ?? 0,
        probeFailureStreak: COOLDOWNS.probeFailureStreak(route.provider) ?? 0,
        inFlightRequests: getActiveRequests(route.provider),
        activeAgents: projection.byProvider[route.provider] ?? 0,
        attempts: state.attempts,
        successes: state.successes,
        failures: state.failures,
        lastSuccessAt: state.lastSuccessAt,
        lastFailure: activeLastFailure
          ? {
              at: activeLastFailure.timestamp,
              failureClass: activeLastFailure.class,
              status: activeLastFailure.status ?? null,
              ...(activeLastFailure.model === undefined
                ? {}
                : { model: activeLastFailure.model })
            }
          : null,
        lastCheck: state.lastCheck,
        ...(quota ? { quota } : {})
      };
      return [route.provider, health];
    })
  );
}
setControlApiProviderHealthSource(controlApiProviderHealth);

/** Re-read one provider's model listing, for a check; null when nothing lists models. */
export type ProviderModelRecheck = (
  provider: string
) => Promise<ControlApiProviderModelDiscovery | null>;

/** Re-read one provider's quota/usage limits, for a check; null when nothing checks quota. */
export type ProviderQuotaRecheck = (
  provider: string
) => Promise<ControlApiProviderQuota | null>;

/**
 * The failure class a check records for a provider that has no route.
 *
 * A provider can be configured without a route: it is listed, it holds
 * priorities, models and limits, and no request can reach it. The verdict the
 * Console shows for it is `Missing CODEX_ROUTE`, and a re-check cannot change
 * that -- a route is configuration, not something a probe discovers.
 */
const MISSING_ROUTE_FAILURE_CLASS = "missing_route";

/**
 * Re-check one provider now, on an operator's request.
 *
 * Routing only re-probes a provider when a request is about to use it, so a
 * provider marked unavailable stays that way until traffic happens to try it
 * again. The check runs what routing would: the live probe (credential, the
 * bridge's health endpoint, or Codex's own auth), then the provider's model
 * listing. Model discovery is reported separately from provider health.
 *
 * A passing probe clears a probe-failure cooldown, and the passing check is
 * recorded as health evidence (`lastCheck`) that a request failure older than
 * it no longer stands for. A failing operator-requested probe records health
 * evidence without increasing cooldown penalties or failure streaks. A
 * provider-declared quota or rate-limit cooldown remains in effect.
 */
/** What one operator check found, from its probe and its model listing. */
function providerCheckVerdict(
  provider: string,
  probe: ProviderProbeResult,
  listing: ControlApiProviderModelDiscovery | null,
  checkedFrom: string
): ControlApiProviderCheck {
  const at = new Date().toISOString();
  if (!probe.ok) {
    return {
      at,
      ok: false,
      failureClass: probe.failureClass ?? PROBE_FAILURE_CLASS,
      detail: probe.detail ?? "The provider's live probe failed."
    };
  }
  // A bridge can answer its probe and only learn from the listing that its
  // site is signed out: the listing is the first thing that reads the site.
  const listedSignIn = providerState(provider).lastFailure;
  if (
    listedSignIn?.class === SIGN_IN_REQUIRED_FAILURE_CLASS &&
    listedSignIn.timestamp >= checkedFrom
  ) {
    return {
      at,
      ok: false,
      failureClass: SIGN_IN_REQUIRED_FAILURE_CLASS,
      models: listing,
      detail:
        listing?.status === "stale" || listing?.status === "unavailable"
          ? listing.reason
          : "The provider's account must be signed in again."
    };
  }
  return {
    at,
    ok: true,
    failureClass: null,
    models: listing,
    detail:
      listing === null
        ? "The provider answered its live probe."
        : listing.status === "observed"
          ? `The provider answered its live probe and listed ${listing.models.length} model(s).`
          : listing.status === "stale"
            ? `The provider answered its live probe; its model listing failed (${listing.reason}), so its last listing is kept.`
            : `The provider answered its live probe, but its model listing is unavailable: ${listing.reason}`
  };
}

export async function checkProvider(
  provider: string,
  recheckModels: ProviderModelRecheck | null,
  recheckQuota: ProviderQuotaRecheck | null = null
): Promise<ControlApiProviderCheckResponse> {
  const route = ROUTES.find((candidate) => candidate.provider === provider);
  if (!route) {
    // A provider the Runtime knows but has no route for is a provider the
    // Control API has already accepted as known -- it is in the routing
    // configuration -- so throwing here left the operator's re-check as a
    // failed request with nothing said about the provider. The check answers
    // instead.
    //
    // There is nothing to probe: a route is what a probe would call. The check
    // records that, and the verdict stays the one it was, because a re-check
    // cannot conjure a route into existence.
    if (ROUTING_POLICY.config.providers[provider] === undefined) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    const check: ControlApiProviderCheck = {
      at: new Date().toISOString(),
      ok: false,
      failureClass: MISSING_ROUTE_FAILURE_CLASS,
      detail:
        "This provider has no route configured, so there is nothing to probe."
    };
    providerState(provider).lastCheck = check;
    scheduleRouterStatePersist();
    return {
      schema: "autodev-control-provider-check-v1",
      provider,
      check,
      health: controlApiProviderHealth(Date.now())[provider] ?? null
    };
  }
  const checkedFrom = new Date().toISOString();
  const probe = await probeProvider(route);
  let listing: ControlApiProviderModelDiscovery | null = null;
  if (probe.ok) {
    COOLDOWNS.clearProbeFailures(provider);
    listing = recheckModels ? await recheckModels(provider) : null;
  }
  const check = providerCheckVerdict(provider, probe, listing, checkedFrom);
  providerState(provider).lastCheck = check;
  if (recheckQuota) {
    await recheckQuota(provider).catch(() => null);
  }
  scheduleRouterStatePersist();
  return {
    schema: "autodev-control-provider-check-v1",
    provider,
    check,
    health: controlApiProviderHealth(Date.now())[provider] ?? null,
    models: listing
  };
}
setControlApiLiveAgentCountsSource(controlApiLiveAgentCounts);
// The MCP observations are the router's own telemetry of the MCP servers it
// has reached, so the Control API publishes them rather than reaching into
// the tracker itself.
setControlApiMcpObservationsSource(mcpServerObservations);

function buildRouterStatus(now = Date.now()) {
  const projection = getDefaultUsageTracker().projectLiveAgents(now);
  const recentEvents = getDefaultRouterEventRecorder().getRecentEvents(true);
  // The agent identity is not published on the public status: it is the
  // correlation an operator reads on the Control API, not a fact every
  // reader of the router's status is entitled to.
  const statusRecentEvents = recentEvents.map(
    ({ activitySubject: _activitySubject, ...event }) => event
  );
  const providers = Object.fromEntries(
    ROUTES.map((route) => routerProviderStatus(route, now, projection))
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
    ...ROUTING_POLICY.runtimeState(),
    usage: getDefaultUsageTracker().usageStatus(now, projection),
    attributionDiagnostics:
      getDefaultUsageTracker().attributionDiagnosticsStatus(),
    liveAgentAttribution: {
      missingProvider: projection.missingProvider,
      missingModel: projection.missingModel
    },
    correlation: correlationStatus(),
    agents: agentsStatus(now),
    concurrency: getDefaultConcurrencyManager().concurrencyStatus(now),
    subagents: subagentStatus(),
    spawnFailures: spawnFailureStatus(),
    inFlightRequests: Object.fromEntries(activeProviderRequests),
    liveActivity: projection.canonicalTotal,
    providers,
    recentEvents: statusRecentEvents,
    liveFeed: liveFeedEvents.getRecentEvents(true, false),
    codexState: codexStateStatus()
  };
}

export function getRouterStatus(
  now = Date.now()
): ReturnType<typeof buildRouterStatus> {
  return buildRouterStatus(now);
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
 *
 * The canonical Codex 0.154.0+ header (`session-id`) is recognized at the top
 * of the precedence list so a metadata-less continuation/compaction request
 * that supplies only the canonical header is still identified as the same
 * session whose workspace metadata was previously remembered, instead of
 * falling back to the process-wide anonymous bucket. The legacy
 * `x-codex-session-id`/`x-session-id`/`x-conversation-id` aliases remain in
 * the precedence list so already-remembered workspace metadata continues to
 * resolve for older callers. Thread identity accepts Codex's canonical
 * `thread-id` header, `client_metadata.thread_id`, or turn metadata; the former
 * `x-codex-thread-id` header is no longer accepted.
 */
export function requestSession(
  request: IncomingMessage,
  payload: Record<string, unknown> | null | undefined,
  turnMetadataHeader: string | null = null
): {
  key: string;
  scope: "identified" | "process-fallback";
  thread: string | null;
  /** The source session identity; a thread-only fallback is not a session ID. */
  sessionId?: string;
} {
  // Canonical Codex 0.154.0+ header takes precedence so a request that only
  // carries `session-id` (e.g. an auto_compact continuation that is
  // metadata-less) still resolves to the same identified session and the
  // remembered workspace metadata can be restored.
  const canonicalHeader = request.headers["session-id"];
  const header =
    request.headers["x-codex-session-id"] ??
    request.headers["x-session-id"] ??
    request.headers["x-conversation-id"];
  const metadata = payload?.metadata as Record<string, unknown> | undefined;
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  const value =
    (Array.isArray(canonicalHeader) ? canonicalHeader[0] : canonicalHeader) ??
    (Array.isArray(header) ? header[0] : header) ??
    (payload?.session_id as string | undefined) ??
    (payload?.conversation_id as string | undefined) ??
    (metadata?.session_id as string | undefined) ??
    (metadata?.conversation_id as string | undefined) ??
    (turnMetadata?.session_id as string | undefined) ??
    (turnMetadata?.conversation_id as string | undefined);
  const threadHeader = request.headers["thread-id"];
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
  const explicitSession =
    typeof value === "string" && Boolean(value.trim()) ? value.trim() : null;
  const sessionKey = explicitSession ?? thread;
  if (sessionKey)
    return {
      key: sessionKey,
      scope: "identified",
      thread,
      ...(explicitSession ? { sessionId: explicitSession } : {})
    };
  return {
    key: PROCESS_FALLBACK_SESSION_KEY,
    scope: "process-fallback",
    thread: null
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
  const embeddedMeta =
    clientMetadata && typeof clientMetadata === "object"
      ? clientMetadata["x-codex-turn-metadata"]
      : undefined;
  const effectiveMeta =
    turnMetadataHeader ??
    (typeof embeddedMeta === "string"
      ? embeddedMeta
      : embeddedMeta && typeof embeddedMeta === "object"
        ? JSON.stringify(embeddedMeta)
        : null);
  const turnMetadata = parseTurnMetadataJson(effectiveMeta);
  const workspaces = turnMetadata?.workspaces;
  if (
    !workspaces ||
    typeof workspaces !== "object" ||
    Array.isArray(workspaces)
  )
    return false;
  return Object.keys(workspaces).some(
    (key) => typeof key === "string" && Boolean(key.trim())
  );
}

export function workspacePathLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const label = path.basename(value.trim());
  return label && label !== "." && label !== "/" ? label : null;
}

export function repositoryIdentity(remote: unknown): string | null {
  if (typeof remote !== "string" || !remote.trim()) return null;
  const normalized = remote.trim().replace(GIT_REMOTE_PATTERN, "https://$1/");
  let pathname: string;
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split(URL_QUERY_FRAGMENT_SPLIT_PATTERN, 1)[0]!;
  }
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(GIT_EXTENSION_PATTERN, ""));
  if (parts.length < 2) return null;
  const owner = parts.at(-2)!.replaceAll(REPO_ID_SANITIZE_PATTERN, "");
  const repo = parts.at(-1)!.replaceAll(REPO_ID_SANITIZE_PATTERN, "");
  return owner && repo ? `${owner}/${repo}` : null;
}

function resolveTurnMetadataWorkspaces(
  turnMetadataHeader: string | null
): Record<string, Record<string, unknown>> {
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  if (
    !turnMetadata ||
    !turnMetadata.workspaces ||
    typeof turnMetadata.workspaces !== "object" ||
    Array.isArray(turnMetadata.workspaces)
  )
    return {};
  return turnMetadata.workspaces as Record<string, Record<string, unknown>>;
}

function resolveExplicitWorkspacePaths(
  payload: Record<string, unknown> | null | undefined
): unknown[] {
  const metadata = payload?.metadata as Record<string, unknown> | undefined;
  return [
    ...WORKSPACE_KEYS.map((key) => payload?.[key]),
    ...(metadata && typeof metadata === "object"
      ? WORKSPACE_KEYS.map((key) => metadata[key])
      : [])
  ];
}

function resolveWorkspacePathCandidate(
  explicitPaths: unknown[],
  resolvableKeys: string[]
): string | null {
  const explicit = explicitPaths.find(
    (value) => typeof value === "string" && Boolean(value.trim())
  ) as string | undefined;
  if (explicit) return explicit;
  if (resolvableKeys.length === 1) return resolvableKeys[0] ?? null;
  return null;
}

function resolveWorkspaceMatchEntry(
  workspaces: Record<string, Record<string, unknown>>,
  workspacePath: string | null,
  resolvableKeys: string[],
  workspaceKeys: string[]
): Record<string, unknown> | null {
  if (workspacePath && workspaces[workspacePath])
    return workspaces[workspacePath];
  if (resolvableKeys.length === 1) {
    const key = resolvableKeys[0];
    return key ? (workspaces[key] ?? null) : null;
  }
  if (workspaceKeys.length === 1) {
    const key = workspaceKeys[0];
    return key ? (workspaces[key] ?? null) : null;
  }
  return null;
}

function resolveRepositoryFromEntry(
  entry: Record<string, unknown> | null
): string | null {
  const remotes = entry?.associated_remote_urls;
  if (!remotes || typeof remotes !== "object") return null;
  for (const value of Object.values(remotes)) {
    const id = repositoryIdentity(value);
    if (id) return id;
  }
  return null;
}

function resolveWorkspaceId(
  entry: Record<string, unknown> | null,
  turnMetadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  const rawId =
    (entry?.workspace_id as string | undefined) ??
    (entry?.workspaceId as string | undefined) ??
    (entry?.id as string | undefined) ??
    (turnMetadata?.workspace_id as string | undefined) ??
    (turnMetadata?.workspaceId as string | undefined) ??
    null;
  if (typeof rawId === "string" && rawId.trim()) return safeWorkspaceId(rawId);
  if (key === "unknown") return null;
  return `ws_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export function workspaceContextFromRequest(
  request: IncomingMessage | Record<string, unknown>,
  payload: Record<string, unknown> | null | undefined,
  turnMetadataHeader: string | null
): { key: string; cwd: string | null; workspace_id?: string } {
  const turnMetadata = parseTurnMetadataJson(turnMetadataHeader);
  const workspaces = resolveTurnMetadataWorkspaces(turnMetadataHeader);
  const explicitPaths = resolveExplicitWorkspacePaths(payload);
  const resolvableKeys = Object.keys(workspaces).filter(
    (value) =>
      typeof value === "string" && Boolean(value.trim()) && isDirectory(value)
  );
  const workspacePath = resolveWorkspacePathCandidate(
    explicitPaths,
    resolvableKeys
  );
  const workspaceKeys = Object.keys(workspaces);
  const labelPath =
    workspacePath ??
    (resolvableKeys.length === 0 && workspaceKeys.length === 1
      ? workspaceKeys[0]
      : null);
  const matchingEntry = resolveWorkspaceMatchEntry(
    workspaces,
    workspacePath,
    resolvableKeys,
    workspaceKeys
  );
  const repository = resolveRepositoryFromEntry(matchingEntry);
  const key = repository ?? workspacePathLabel(labelPath) ?? "unknown";
  const cwd = workspacePathLabel(labelPath);
  const workspaceId = resolveWorkspaceId(
    matchingEntry,
    turnMetadata as Record<string, unknown> | undefined,
    key
  );

  if (key !== "unknown") {
    if (workspaceId)
      getDefaultUsageTracker().registerWorkspaceId(workspaceId, key);
    if (workspaceId)
      getDefaultUsageTracker().registerWorkspaceId(
        `ws_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
        key
      );
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

/**
 * The client's own entry for one workspace, as a one-entry `workspaces` map.
 *
 * The client's map carries the workspace's git identity in each entry, and a
 * remembered copy that dropped it would label the workspace by its path
 * basename on every later turn. Only the entry for the workspace that was
 * resolved is kept: the map's shape stays one workspace per map, which is
 * what the downstream resolver treats as unambiguous.
 */
function clientWorkspaceEntry(
  workspaces: Record<string, Record<string, unknown>>,
  workspacePath: string
): Record<string, Record<string, unknown>> | null {
  const direct = workspaces[workspacePath];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return { [workspacePath]: direct };
  }
  for (const [key, entry] of Object.entries(workspaces)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const paths = [
      key,
      record.path,
      ...WORKSPACE_KEYS.map((name) => record[name])
    ];
    if (
      paths.some(
        (candidate) =>
          typeof candidate === "string" && candidate === workspacePath
      )
    ) {
      return { [workspacePath]: entry };
    }
  }
  return null;
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
    if (session?.scope === "identified") {
      // The client's own workspace entry is remembered alongside the path: it
      // carries the workspace's git identity, and a remembered copy that
      // dropped it would relabel the workspace by its basename on every later
      // turn, splitting the per-workspace Usage breakdown in two.
      const workspaces = resolveTurnMetadataWorkspaces(turnMetadataHeader);
      const clientEntry = clientWorkspaceEntry(workspaces, workspacePath);
      rememberWorkspaceMetadata(session.key, workspacePath, clientEntry);
      if (session.thread && session.thread !== session.key) {
        rememberWorkspaceMetadata(session.thread, workspacePath, clientEntry);
      }
    }
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
    const rememberedJson =
      getWorkspaceMetadata(session.key) ??
      (session.thread ? getWorkspaceMetadata(session.thread) : null);
    let metadata = turnMetadataHeader;
    if (rememberedJson) {
      const rememberedParsed = parseTurnMetadataJson(rememberedJson);
      const incomingParsed = parseTurnMetadataJson(turnMetadataHeader);
      if (incomingParsed && rememberedParsed?.workspaces) {
        metadata = JSON.stringify({
          ...incomingParsed,
          workspaces: rememberedParsed.workspaces
        });
      } else {
        metadata = rememberedJson;
      }
    }
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
    const models: Array<{ slug: string; [key: string]: unknown }> =
      Array.isArray(parsed.models) ? parsed.models : [];
    if (catalogFile === CATALOG_FILE) {
      const modelSlugs = new Set(models.map((m) => m.slug));
      const codexModels = ROUTING_POLICY.config.providers?.codex?.models ?? {};
      for (const [key, slug] of Object.entries(codexModels)) {
        if (typeof slug === "string" && slug && !modelSlugs.has(slug)) {
          models.unshift({
            slug,
            display_name: slug,
            description: `OpenAI Codex model for ${key}.`,
            default_reasoning_level:
              key === "orchestrator"
                ? (ROUTING_POLICY.config.orchestrator?.reasoningEffort?.codex ??
                  "xhigh")
                : key === "smart"
                  ? "high"
                  : "medium",
            supported_reasoning_levels: [
              { effort: "low", description: "Low reasoning" },
              { effort: "medium", description: "Balanced reasoning" },
              { effort: "high", description: "High reasoning" },
              { effort: "xhigh", description: "Extra-high reasoning" },
              { effort: "max", description: "Maximum reasoning" }
            ],
            shell_type: "shell_command",
            visibility: "list",
            supported_in_api: true,
            priority: 0,
            context_window: 1_000_000,
            max_context_window: 1_000_000,
            supports_parallel_tool_calls: true,
            supports_reasoning_summaries: true,
            support_verbosity: true,
            supports_search_tool: true,
            tool_mode: "code_mode_only",
            truncation_policy: { mode: "tokens", limit: 10_000 },
            experimental_supported_tools: [],
            use_responses_lite: true,
            multi_agent_version: "v1",
            input_modalities: ["text", "image"]
          });
          modelSlugs.add(slug);
        }
      }
    }
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

async function handleResponseRequest(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
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
  const isOrchestratorRequest = model === ORCHESTRATOR_ALIAS;
  const agentRole = isOrchestratorRequest ? "orchestrator" : role;
  if (agentRole && ROUTING_POLICY.isAgentEnabled(agentRole) === false) {
    recordRouterEvent({
      phase: "denied",
      requestId,
      role: agentRole,
      requestedModel: model,
      provider: null,
      model: null,
      outcome: "failure",
      status: 403,
      failureClass: "request_error",
      denialReason: "agent_disabled"
    });
    sendJson(
      response,
      403,
      errorBody(
        `Agent role ${agentRole} is disabled.`,
        "router_agent_disabled",
        {
          code: "router_agent_disabled",
          retryable: false,
          model,
          requestId
        }
      ),
      { "x-autodev-request-id": requestId }
    );
    return;
  }
  const turnMetadataHeader = resolveTurnMetadataHeader(request, payload);
  const session = requestSession(request, payload, turnMetadataHeader);
  const activitySubject = activitySubjectFor(requestId, session, {
    subagentOfKnownSession:
      !isOrchestratorRequest &&
      Boolean(role && orchestratorProviderForSession(session.key))
  });
  noteRequestIdentity(requestId, session.thread, activitySubject);
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
  // A client disconnect destroys the response before "close" fires, so a
  // `destroyed` check here skipped exactly the case this exists for and left
  // the provider working for a client that was gone. Anything not ended by
  // the router can no longer be delivered: cancel the upstream work.
  const abortForResponseClose = () => {
    if (!response.writableEnded) clientAbort.abort();
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
          workspace: workspace?.key ?? null,
          thread: session.thread
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

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`)
    .pathname;
  if (await handlePreflightRoutes(pathname, request, response)) return;
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

  await handleResponseRequest(pathname, request, response);
}

async function handlePreflightRoutes(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<boolean> {
  if (pathname === "/health" || pathname === "/health/liveliness") {
    sendJson(response, 200, { status: "ok", router: "codex-model-router" });
    return true;
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
      return true;
    }
    sendJson(response, 200, {
      status: "ready",
      router: "codex-model-router",
      lifecycle: getDefaultRouterLifecycle().getLifecycleStatus()
    });
    return true;
  }
  if (pathname === "/status" && request.method === "GET") {
    const now = Date.now();
    const status = buildRouterStatus(now);
    sendJson(response, 200, status, { "cache-control": "no-store" });
    return true;
  }
  if (pathname === "/v1/models" && request.method === "GET") {
    sendJson(response, 200, await loadCatalog());
    return true;
  }
  if (await handleControlApiRequest(request, response, pathname)) return true;
  return false;
}

export async function handle(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    await withExtractedTraceContext(request.headers, () =>
      handleRequest(request, response)
    );
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
        } catch {
          /* stream already closed */
        }
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
