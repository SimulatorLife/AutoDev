/**
 * Dashboard Lookback aggregator.
 *
 * The router's `/status` payload exposes two shapes that the dashboard has to
 * keep distinct:
 *
 *   1. Activity-derived stats/counts/aggregates
 *      (routing attempts/successes/failures, tool/hook/skill/MCP counts,
 *       skill uses, MCP exposures, subagent spawns, spawn failures, etc.)
 *   2. Current-state / configuration indicators
 *      (active agents, concurrency, provider cooldowns, Codex state DB,
 *       telemetry receiver counters, native metrics observed, tokens, etc.)
 *
 * Lifetime cumulative buckets in `usage.ts` and `otel.ts` cannot be filtered
 * into an interval view from a row timestamp: their `lastSeenAt` /
 * `lastUsedAt` fields describe the most recent sighting only, not the time
 * each individual observation occurred. The interval view therefore MUST
 * be rebuilt from the bounded, per-occurrence histories the router
 * already retains -- `status.recentEvents` (timestamped `RouterEvent[]`)
 * and `status.liveFeed` (timestamped `LiveFeedEvent[]`) -- rather than
 * re-deriving from those lifetime maps.
 *
 * This module is the single source of truth for the interval and active-agent
 * rebuilds. It
 * is consumed by:
 *
 *   - the server's `/status` endpoint, which calls `aggregateLookbackView`
 *     when the dashboard's Lookback selector is anything other than `All`,
 *     and spreads the result back into the existing `RouterStatus`
 *     payload (so the dashboard never needs to filter rows itself); and
 *   - the dashboard's `tests/router/lookback-aggregator.test.ts`
 *     executable test, which exercises the same aggregator directly
 *     against deterministic `now` values and a mixed-timestamp fixture
 *     covering every public counter the dashboard renders.
 *
 * The aggregator is intentionally a pure function with no module-level
 * state. It never throws on missing data, never invents synthetic rows,
 * and never reaches back into the lifetime cumulative maps to "patch" a
 * missing value -- when the bounded histories do not cover a window or do not
 * carry an exact active-agent identity, the aggregator reports zero for that
 * counter and the dashboard shows it. The bounded histories are documented in `events.ts` and
 * `live-feed.ts` (see `maxRecentEvents` and the `maxEvents` constructor
 * defaults).
 */

import type { RouterEvent } from "./events.ts";
import { LIVE_FEED_CATEGORIES, type LiveFeedEvent } from "./live-feed.ts";
import type { OtelLookbackEvent } from "./otel.ts";
import { safeAgentIdentity } from "./usage.ts";

export const LOOKBACK_SELECTIONS = [
  "all",
  "active",
  "today",
  "1h",
  "2h",
  "5h",
  "12h"
] as const;

export type LookbackSelection = (typeof LOOKBACK_SELECTIONS)[number];

export const LOOKBACK_HOURS: Record<
  Exclude<LookbackSelection, "all" | "active" | "today">,
  number
> = {
  "1h": 1,
  "2h": 2,
  "5h": 5,
  "12h": 12
};

/**
 * Routing phases emitted by the router into `status.recentEvents`. Phases
 * outside this set are still recorded but do not advance any of the
 * interval counters in this aggregator (e.g. `router_transform` /
 * `repaired` are bookkeeping).
 */
const ROUTING_ATTEMPT_PHASES: ReadonlySet<string> = new Set([
  "selected",
  "result",
  "skipped",
  "denied"
]);

const STRING_COLLATOR = new Intl.Collator();

interface UsageContext {
  usage: IntervalUsage;
  providerCounts: Map<string, IntervalProviderCounts>;
}

interface ResolvedRoutingBuckets {
  totalsBucket: IntervalUsageBucket;
  providerBucket: IntervalProviderCounts;
  roleBucket: IntervalUsageBucket;
  modelBucket: IntervalUsageBucket;
  originBucket: IntervalUsageBucket;
  wsBucket: IntervalWorkspaceUsageBucket;
  wsRoleBucket: IntervalUsageBucket;
  wsModelBucket: IntervalUsageBucket;
  duration: number;
  toolCalls: number;
  provider: string | null;
}

function resolveRoutingBuckets(
  event: RouterEvent,
  context: UsageContext
): ResolvedRoutingBuckets {
  const roleBucket = getOrCreateBucket(context.usage.byRole, originKey(event));
  const modelBucket = getOrCreateBucket(context.usage.byModel, modelKey(event));
  const originBucket = getOrCreateBucket(
    context.usage.byOrigin,
    originKey(event)
  );
  const wsKey = workspaceKey(event);
  let wsBucket = context.usage.byWorkspace[wsKey];
  if (!wsBucket) {
    wsBucket = createWorkspaceBucket(event.cwd ?? null);
    context.usage.byWorkspace[wsKey] = wsBucket;
  }
  const wsRoleBucket = getOrCreateBucket(wsBucket.byRole, originKey(event));
  const wsModelBucket = getOrCreateBucket(wsBucket.byModel, modelKey(event));
  const provider = event.provider ?? null;
  return {
    totalsBucket: context.usage.totals,
    providerBucket: ensureProviderCounts(
      context.providerCounts,
      provider ?? null
    ),
    roleBucket,
    modelBucket,
    originBucket,
    wsBucket,
    wsRoleBucket,
    wsModelBucket,
    duration: eventDurationMs(event),
    toolCalls: eventToolCalls(event),
    provider
  };
}

function processRoutingEvent(event: RouterEvent, context: UsageContext): void {
  const buckets = resolveRoutingBuckets(event, context);
  dispatchRoutingPhase(event.phase, event, buckets);
}

type PhaseHandler = (
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
) => void;

function dispatchRoutingPhase(
  phase: string,
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
): void {
  const handler: PhaseHandler | undefined = PHASE_DISPATCH[phase];
  if (handler) handler(event, buckets);
}

const PHASE_DISPATCH: Record<string, PhaseHandler> = {
  selected: applySelectedPhase,
  result: applyResultPhase,
  skipped: applySkippedPhase,
  denied: applyDeniedPhase
};

function applySelectedPhase(
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
): void {
  addAttemptsToBucket(buckets.totalsBucket, 1, event.timestamp);
  addAttemptsToBucket(buckets.roleBucket, 1, event.timestamp);
  addAttemptsToBucket(buckets.modelBucket, 1, event.timestamp);
  addAttemptsToBucket(buckets.originBucket, 1, event.timestamp);
  addAttemptsToBucket(buckets.wsBucket, 1, event.timestamp);
  addAttemptsToBucket(buckets.wsRoleBucket, 1, event.timestamp);
  addAttemptsToBucket(buckets.wsModelBucket, 1, event.timestamp);
  if (buckets.provider) {
    buckets.providerBucket.attempts += 1;
    buckets.providerBucket.lastAttemptAt = event.timestamp;
  }
}

function applyResultPhase(
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
): void {
  if (event.outcome === "success") {
    applySuccessToBuckets(event, buckets);
  } else {
    applyFailureToBuckets(event, buckets);
  }
  addToolCallsToBuckets(buckets, event, buckets.toolCalls);
}

function applySuccessToBuckets(
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
): void {
  addSuccessToBucket(buckets.totalsBucket, buckets.duration, event.timestamp);
  addSuccessToBucket(buckets.roleBucket, buckets.duration, event.timestamp);
  addSuccessToBucket(buckets.modelBucket, buckets.duration, event.timestamp);
  addSuccessToBucket(buckets.originBucket, buckets.duration, event.timestamp);
  addSuccessToBucket(buckets.wsBucket, buckets.duration, event.timestamp);
  addSuccessToBucket(buckets.wsRoleBucket, buckets.duration, event.timestamp);
  addSuccessToBucket(buckets.wsModelBucket, buckets.duration, event.timestamp);
  if (buckets.provider) {
    buckets.providerBucket.successes += 1;
    buckets.providerBucket.durationMs += buckets.duration;
    if (buckets.duration > buckets.providerBucket.maxDurationMs) {
      buckets.providerBucket.maxDurationMs = buckets.duration;
    }
    buckets.providerBucket.lastSuccessAt = event.timestamp;
  }
}

function applyFailureToBuckets(
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
): void {
  const failureClass = event.failureClass;
  const status = event.status;
  addFailureToBucket(
    buckets.totalsBucket,
    buckets.duration,
    event.timestamp,
    failureClass,
    status
  );
  addFailureToBucket(
    buckets.roleBucket,
    buckets.duration,
    event.timestamp,
    failureClass,
    status
  );
  addFailureToBucket(
    buckets.modelBucket,
    buckets.duration,
    event.timestamp,
    failureClass,
    status
  );
  addFailureToBucket(
    buckets.originBucket,
    buckets.duration,
    event.timestamp,
    failureClass,
    status
  );
  addFailureToBucket(
    buckets.wsBucket,
    buckets.duration,
    event.timestamp,
    failureClass,
    status
  );
  addFailureToBucket(
    buckets.wsRoleBucket,
    buckets.duration,
    event.timestamp,
    failureClass,
    status
  );
  addFailureToBucket(
    buckets.wsModelBucket,
    buckets.duration,
    event.timestamp,
    failureClass,
    status
  );
  if (buckets.provider) {
    buckets.providerBucket.failures += 1;
    buckets.providerBucket.durationMs += buckets.duration;
    if (buckets.duration > buckets.providerBucket.maxDurationMs) {
      buckets.providerBucket.maxDurationMs = buckets.duration;
    }
    buckets.providerBucket.lastFailureAt = event.timestamp;
  }
}

function addToolCallsToBuckets(
  buckets: ResolvedRoutingBuckets,
  _event: RouterEvent,
  toolCalls: number
): void {
  if (toolCalls <= 0) return;
  addToolCallsToBucket(buckets.totalsBucket, toolCalls);
  addToolCallsToBucket(buckets.roleBucket, toolCalls);
  addToolCallsToBucket(buckets.modelBucket, toolCalls);
  addToolCallsToBucket(buckets.originBucket, toolCalls);
  addToolCallsToBucket(buckets.wsBucket, toolCalls);
  addToolCallsToBucket(buckets.wsRoleBucket, toolCalls);
  addToolCallsToBucket(buckets.wsModelBucket, toolCalls);
}

function applySkippedPhase(
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
): void {
  addSkippedToBucket(buckets.totalsBucket, event.timestamp);
  addSkippedToBucket(buckets.roleBucket, event.timestamp);
  addSkippedToBucket(buckets.modelBucket, event.timestamp);
  addSkippedToBucket(buckets.originBucket, event.timestamp);
  addSkippedToBucket(buckets.wsBucket, event.timestamp);
  addSkippedToBucket(buckets.wsRoleBucket, event.timestamp);
  addSkippedToBucket(buckets.wsModelBucket, event.timestamp);
  if (buckets.provider) buckets.providerBucket.skipped += 1;
}

interface LiveFeedContext {
  record: LiveFeedEvent;
  telemetry: IntervalCodexTelemetry;
  usage: IntervalUsage;
}

function processLiveFeedRecord(
  record: LiveFeedEvent,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  const handler = resolveLiveFeedHandler(record);
  if (!handler) return;
  handler({ record, telemetry, usage });
}

function resolveLiveFeedHandler(
  record: LiveFeedEvent
): LiveFeedHandler | undefined {
  const category = String(record.category ?? "");
  return isLiveFeedCategory(category)
    ? LIVE_FEED_DISPATCH[category]
    : undefined;
}

function isLiveFeedCategory(value: string): boolean {
  return (LIVE_FEED_CATEGORIES as readonly string[]).includes(value);
}

type LiveFeedHandler = (ctx: LiveFeedContext) => void;

const LIVE_FEED_DISPATCH: Record<string, LiveFeedHandler> = {
  tools: handleToolCategory,
  hooks: handleHookCategory,
  skills: handleSkillCategory,
  mcp: handleMcpCategory
};

function handleToolCategory(ctx: LiveFeedContext): void {
  const { record, telemetry, usage } = ctx;
  const toolKey =
    readTextField(record, "tool") ??
    readTextField(record, "name") ??
    "(unknown-tool)";
  const type = String(record.type ?? "");
  if (type.startsWith("otel.")) return;
  applyBridgeToolBucket(record, toolKey, telemetry);
  const workspace = workspaceForLiveFeed(record, usage);
  if (!workspace) return;
  if (type === "tool_executed") workspace.toolsExecuted += 1;
  if (type === "tool_requested") workspace.toolsRequested += 1;
  if (type === "tool_unavailable") workspace.toolsUnavailable += 1;
  const bridgeEvent = [
    "tool_executed",
    "tool_requested",
    "tool_unavailable"
  ].includes(type);
  const rows = bridgeEvent ? workspace.bridgeTools : workspace.byTool;
  const workspaceRow = upsertWorkspaceNamedRow(rows, "tool", toolKey, {
    tool: toolKey,
    source: readTextField(record, "source"),
    server: readTextField(record, "server"),
    count: 0,
    byStatus: {}
  });
  workspaceRow.count = Number(workspaceRow.count ?? 0) + 1;
  addWorkspaceStatus(
    workspaceRow,
    readStatus(record),
    typeof record.outcome === "string" ? record.outcome : null
  );
}

function applyBridgeToolBucket(
  record: LiveFeedEvent,
  toolKey: string,
  telemetry: IntervalCodexTelemetry
): void {
  const type = String(record.type ?? "");
  if (type === "tool_requested") {
    telemetry.bridgeEvents.toolRequested.total += 1;
    bumpStringCount(telemetry.bridgeEvents.toolRequested.byTool, toolKey, 1);
  } else if (type === "tool_unavailable") {
    telemetry.bridgeEvents.toolUnavailable.total += 1;
    bumpStringCount(telemetry.bridgeEvents.toolUnavailable.byTool, toolKey, 1);
    const reason =
      typeof record.failureClass === "string" && record.failureClass.trim()
        ? record.failureClass.trim()
        : typeof record.denialReason === "string" && record.denialReason.trim()
          ? record.denialReason.trim()
          : "unavailable";
    bumpStringCount(telemetry.bridgeEvents.toolUnavailable.byReason, reason, 1);
  } else if (type === "tool_executed") {
    telemetry.bridgeEvents.toolExecuted.total += 1;
    bumpStringCount(telemetry.bridgeEvents.toolExecuted.byTool, toolKey, 1);
  }
}

function handleHookCategory(ctx: LiveFeedContext): void {
  const { record, telemetry } = ctx;
  if (String(record.type ?? "").startsWith("otel.")) return;
  const hookKey =
    readTextField(record, "hook") ??
    readTextField(record, "name") ??
    "(unknown-hook)";
  const row = upsertHookRow(telemetry.hooks.byHook, {
    hook: hookKey,
    source: readTextField(record, "source"),
    handlerType: readTextField(record, "handlerType"),
    count: 0,
    byStatus: {},
    durationCount: 0,
    durationMs: 0,
    averageDurationMs: 0
  });
  row.count += 1;
  bumpToolStatus(
    row,
    readStatus(record),
    typeof record.outcome === "string" ? record.outcome : null
  );
  const durationMs = readDuration(record);
  if (durationMs != null) {
    row.durationCount += 1;
    row.durationMs += durationMs;
  }
}

function handleSkillCategory(ctx: LiveFeedContext): void {
  const { record, telemetry, usage } = ctx;
  const skillKey =
    readTextField(record, "skill") ??
    readTextField(record, "name") ??
    "(unknown-skill)";
  const type = String(record.type ?? "");
  if (type !== "skill_exposed") return;
  const workspace = workspaceForLiveFeed(record, usage);
  telemetry.skills.exposed.total += 1;
  telemetry.bridgeEvents.skillExposed.total += 1;
  if (workspace) {
    workspace.skillsExposed += 1;
    const workspaceRow = upsertWorkspaceNamedRow(
      workspace.bridgeSkills,
      "skill",
      skillKey,
      {
        skill: skillKey,
        count: 0
      }
    );
    workspaceRow.count = Number(workspaceRow.count ?? 0) + 1;
  }
}

function handleMcpCategory(ctx: LiveFeedContext): void {
  const { record, usage } = ctx;
  if (String(record.type ?? "").startsWith("otel.")) return;
  const serverKey =
    readTextField(record, "server") ??
    readTextField(record, "name") ??
    "(unknown-server)";
  const workspace = workspaceForLiveFeed(record, usage);
  if (!workspace) return;
  if (String(record.type ?? "") === "mcp_exposed") {
    const exposed = upsertWorkspaceNamedRow(
      workspace.mcpExposed,
      "server",
      serverKey,
      { server: serverKey, count: 0 }
    );
    exposed.count = Number(exposed.count ?? 0) + 1;
    return;
  }
  workspace.byMcp[serverKey] = (workspace.byMcp[serverKey] ?? 0) + 1;
  const uses = upsertWorkspaceNamedRow(workspace.mcpUses, "server", serverKey, {
    server: serverKey,
    count: 0
  });
  uses.count = Number(uses.count ?? 0) + 1;
}

function workspaceForLiveFeed(
  record: LiveFeedEvent,
  usage: IntervalUsage
): IntervalWorkspaceUsageBucket | null {
  const key = readTextField(record, "workspace");
  if (!key) return null;
  if (!usage.byWorkspace[key])
    usage.byWorkspace[key] = createWorkspaceBucket(null);
  return usage.byWorkspace[key];
}

function upsertWorkspaceNamedRow(
  rows: WorkspaceNamedRow[],
  identityKey: string,
  name: string,
  fields: WorkspaceNamedRow
): WorkspaceNamedRow {
  const existing = rows.find((row) => row[identityKey] === name);
  if (existing) return existing;
  rows.push(fields);
  return fields;
}

function addWorkspaceStatus(
  row: WorkspaceNamedRow,
  status: string | number | null,
  outcome: string | null
): void {
  const statusBucket = { byStatus: row.byStatus ?? {} };
  bumpToolStatus(statusBucket, status, outcome);
  row.byStatus = statusBucket.byStatus;
}

// routing/telemetry/runtime categories intentionally do not feed the
// interval counters -- routing counters are already derived from
// `recentEvents`; telemetry/runtime counts are cumulative current-state
// indicators (receiver totals, native metrics observed) and are surfaced
// unchanged in the `All` view. The dispatch table omits them so the
// switch returns no handler.

function applyDeniedPhase(
  event: RouterEvent,
  buckets: ResolvedRoutingBuckets
): void {
  addSkippedToBucket(buckets.totalsBucket, event.timestamp);
  addSkippedToBucket(buckets.roleBucket, event.timestamp);
  addSkippedToBucket(buckets.modelBucket, event.timestamp);
  addSkippedToBucket(buckets.originBucket, event.timestamp);
  addSkippedToBucket(buckets.wsBucket, event.timestamp);
  addSkippedToBucket(buckets.wsRoleBucket, event.timestamp);
  addSkippedToBucket(buckets.wsModelBucket, event.timestamp);
}

export interface LookbackSubagentRecord {
  timestamp: string;
  mechanism: string;
  provider: string | null;
  role: string | null;
  status: string;
  tool: string | null;
  requestId: string | null;
  workspace: string | null;
  count: number;
  settled?: { success?: number; failure?: number } | null;
}

export interface LookbackSpawnFailureRecord {
  timestamp: string;
  reason: string;
  requestId?: string | null;
  role?: string | null;
  requestedModel?: string | null;
}

export interface LookbackAggregatorInput {
  /** Bounded timestamped router events (`status.recentEvents`). */
  recentEvents: readonly RouterEvent[];
  /** Bounded timestamped live-feed events (`status.liveFeed`). */
  liveFeed: readonly LiveFeedEvent[];
  /** Accepted semantic OTel deltas from the tracker-owned bounded history. */
  otelLookbackEvents?: readonly OtelLookbackEvent[] | null;
  /** Bounded timestamped subagent spawn records (`status.subagents.recent`). */
  subagentRecent?: readonly LookbackSubagentRecord[] | null;
  /** Bounded timestamped spawn-failure records (`status.spawnFailures.recent`). */
  spawnFailureRecent?: readonly LookbackSpawnFailureRecord[] | null;
  /** Canonical live agent records from `AgentActivityTracker.listLive()`. */
  activeAgents?: readonly LookbackActiveAgent[] | null;
  /** Fixed clock used by the dashboard; tests pass a deterministic value. */
  now: number;
  /** Active dashboard selection. */
  selection: LookbackSelection;
}

export interface LookbackActiveAgent {
  subject: string;
  requestId?: string | null;
  state?: string | null;
}

interface ActiveAgentScope {
  threadIds: Set<string>;
  agentIds: Set<string>;
  requestIds: Set<string>;
}

/**
 * Single, per-record UsageBucket shape the dashboard already knows how
 * to render. Mirrors the router's lifetime `usageStatus()` shape so the
 * dashboard does not need to special-case interval values.
 */
export interface IntervalUsageBucket {
  attempts: number;
  successes: number;
  failures: number;
  skipped: number;
  durationMs: number;
  maxDurationMs: number;
  toolCalls: number;
  lastUsedAt: string | null;
  lastFailure: {
    timestamp: string;
    class?: string | null;
    status?: number | string | null;
  } | null;
  averageDurationMs: number;
}

export interface IntervalWorkspaceUsageBucket extends IntervalUsageBucket {
  cwd: string | null;
  skillUses: number;
  byRole: Record<string, IntervalUsageBucket>;
  byModel: Record<string, IntervalUsageBucket>;
  byMcp: Record<string, number>;
  toolsExecuted: number;
  toolsRequested: number;
  toolsUnavailable: number;
  skillsExposed: number;
  byTool: WorkspaceNamedRow[];
  bySkill: WorkspaceNamedRow[];
  bridgeTools: WorkspaceNamedRow[];
  bridgeSkills: WorkspaceNamedRow[];
  mcpUses: WorkspaceNamedRow[];
  mcpExposed: WorkspaceNamedRow[];
}

interface WorkspaceNamedRow extends Record<string, unknown> {
  byStatus?: {
    ok?: number;
    error?: number;
    success?: number;
    failure?: number;
    skipped?: number;
  };
}

export interface IntervalUsage {
  totals: IntervalUsageBucket;
  byRole: Record<string, IntervalUsageBucket>;
  byModel: Record<string, IntervalUsageBucket>;
  byWorkspace: Record<string, IntervalWorkspaceUsageBucket>;
  byOrigin: Record<string, IntervalUsageBucket>;
}

export interface IntervalToolRow {
  tool: string;
  source: string | null;
  server: string | null;
  count: number;
  byStatus: {
    ok?: number;
    error?: number;
    success?: number;
    failure?: number;
    skipped?: number;
  };
  durationCount: number;
  durationMs: number;
  averageDurationMs: number;
}

export interface IntervalHookRow {
  hook: string;
  source: string | null;
  handlerType: string | null;
  count: number;
  byStatus: {
    ok?: number;
    error?: number;
    success?: number;
    failure?: number;
    skipped?: number;
  };
  durationCount: number;
  durationMs: number;
  averageDurationMs: number;
}

export interface IntervalSkillRow {
  skill: string;
  total: number;
  uses: number;
  byStatus: {
    ok?: number;
    error?: number;
    success?: number;
    failure?: number;
    skipped?: number;
  };
}

export interface IntervalHistogram {
  count: number;
  sum: number;
  average: number;
}

export interface IntervalToolResultRow {
  tool: string;
  source: string | null;
  server: string | null;
  count: number;
  byStatus: Record<string, number>;
}

export interface IntervalToolResults {
  total: number;
  executed: number;
  unattributed: number;
  causeResolved: number;
  causeUnresolved: number;
  byStatus: Record<string, number>;
  byTool: IntervalToolResultRow[];
  executionDurationMs: { count: number; sum: number; average: number };
}

export interface IntervalBridgeEvents {
  toolExecuted: { total: number; byTool: Record<string, number> };
  toolRequested: { total: number; byTool: Record<string, number> };
  toolUnavailable: {
    total: number;
    byTool: Record<string, number>;
    byReason: Record<string, number>;
  };
  skillExposed: { total: number };
}

export interface IntervalCodexTelemetry {
  receiver: { logs: number; traces: number; metrics: number; invalid: number };
  turns: {
    prompts: number;
    completed: number;
    promptLength: number;
    ttftCount: number;
    ttftMs: number;
    averageTtftMs: number;
  };
  threads: {
    started: { total: number; bySource: Record<string, number> };
    spawns: {
      total: number;
      byStatus: Record<string, number>;
      byRole: Record<string, number>;
      byModel: Record<string, number>;
    };
  };
  tokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
    tool: number;
    total: number;
  };
  toolResults: IntervalToolResults;
  mcpSummary: {
    observed: number;
    ready: number;
    error: number;
    stale: number;
    byRole: Record<
      string,
      { observed: number; ready: number; error: number; stale: number }
    >;
    byWorkspace: Record<
      string,
      { observed: number; ready: number; error: number; stale: number }
    >;
    byModel: Record<
      string,
      { observed: number; ready: number; error: number; stale: number }
    >;
    byAgent: Record<
      string,
      { observed: number; ready: number; error: number; stale: number }
    >;
  };
  tools: { byTool: IntervalToolRow[] };
  hooks: { byHook: IntervalHookRow[] };
  skills: {
    used: { total: number; bySkill: IntervalSkillRow[] };
    injected: { total: number; bySkill: IntervalSkillRow[] };
    exposed: { total: number };
    turnDuration: { durationSeconds: IntervalHistogram };
    threads: {
      enabledTotal: IntervalHistogram;
      keptTotal: IntervalHistogram;
      truncated: IntervalHistogram;
      descriptionTruncatedChars: IntervalHistogram;
    };
  };
  lookbackEvents: OtelLookbackEvent[];
  mcpServers: Array<{
    name: string;
    observed: number;
    ready: number;
    error: number;
    stale: number;
    lastSeenAt: string | null;
    lastStatus: string;
    byModel: Record<string, number>;
    byRole: Record<string, number>;
    byWorkspace: Record<string, number>;
    byAgent: Record<string, number>;
  }>;
  bridgeEvents: IntervalBridgeEvents;
}

export interface IntervalSubagents {
  total: number;
  byMechanism: Record<string, number>;
  byProvider: Record<string, number>;
  byRole: Record<string, number>;
  byStatus: Record<string, number>;
  recent: LookbackSubagentRecord[];
}

export interface IntervalSpawnFailures {
  total: number;
  byReason: Record<string, number>;
  recent: LookbackSpawnFailureRecord[];
}

export interface IntervalProviderCounts {
  attempts: number;
  successes: number;
  failures: number;
  skipped: number;
  durationMs: number;
  maxDurationMs: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export interface IntervalRouterStatusOverride {
  /** Selection coverage. A null start means no wall-clock lower bound. */
  lookback: {
    selection: LookbackSelection;
    windowStartMs: number | null;
    windowEndMs: number;
    boundedByRingBuffer: boolean;
  };
  usage: IntervalUsage;
  codexTelemetry: IntervalCodexTelemetry;
  subagents: IntervalSubagents;
  spawnFailures: IntervalSpawnFailures;
  providers: Record<string, IntervalProviderCounts>;
  recentEvents: RouterEvent[];
  liveFeed: LiveFeedEvent[];
  activeAgentStates?: Record<string, number>;
}

/**
 * Resolves the wall-clock timestamp the interval starts at, in
 * milliseconds. `null` means the selection does not impose a wall-clock
 * lower bound (`All` or `Active Sessions`); `All` remains a no-op.
 *
 * `Today` uses `America/New_York` to match the dashboard, but the
 * dashboard's timezone display is separate from the aggregator's
 * computation; the aggregator only needs the local-clock start of day
 * the dashboard tells the operator about. We deliberately use the host
 * timezone (`Intl.DateTimeFormat` with the configured zone) rather than
 * the process timezone, so the dashboard and the aggregator stay
 * consistent when running on non-EST servers.
 */
export function lookbackWindowStartMs(
  now: number,
  selection: LookbackSelection,
  timeZone = "America/New_York"
): number | null {
  if (selection === "all" || selection === "active") return null;
  if (selection !== "today") {
    const hours = LOOKBACK_HOURS[selection];
    if (!Number.isFinite(hours)) return null;
    return now - hours * 60 * 60 * 1000;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    })
      .formatToParts(new Date(now))
      .map(({ type, value }) => [type, value])
  );
  const utcMidnight = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day)
  );
  const utcParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    })
      .formatToParts(new Date(utcMidnight))
      .map(({ type, value }) => [type, value])
  );
  const hour = utcParts.hour === "24" ? 0 : Number(utcParts.hour);
  return (
    utcMidnight +
    (utcMidnight -
      Date.UTC(
        Number(utcParts.year),
        Number(utcParts.month) - 1,
        Number(utcParts.day),
        hour,
        Number(utcParts.minute),
        Number(utcParts.second)
      ))
  );
}

/**
 * Returns true when `value` is a parseable ISO timestamp at or after the
 * window start. Entries without a parseable timestamp are kept: they
 * describe current-state indicators (config, capability, observation
 * counts) and have nothing to do with the interval.
 */
function inWindow(
  timestamp: string | null | undefined,
  windowStartMs: number | null,
  windowEndMs = Number.POSITIVE_INFINITY
): boolean {
  if (windowStartMs === null) return true;
  if (!timestamp) return false;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) && ms >= windowStartMs && ms <= windowEndMs;
}

function emptyUsageBucket(): IntervalUsageBucket {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    skipped: 0,
    durationMs: 0,
    maxDurationMs: 0,
    toolCalls: 0,
    lastUsedAt: null,
    lastFailure: null,
    averageDurationMs: 0
  };
}

function addAttemptsToBucket(
  bucket: IntervalUsageBucket,
  count: number,
  timestamp: string | null
): void {
  if (count <= 0) return;
  bucket.attempts += count;
  if (timestamp && (!bucket.lastUsedAt || timestamp > bucket.lastUsedAt))
    bucket.lastUsedAt = timestamp;
}

function addSuccessToBucket(
  bucket: IntervalUsageBucket,
  durationMs: number,
  timestamp: string | null
): void {
  bucket.successes += 1;
  bucket.durationMs += durationMs;
  if (durationMs > bucket.maxDurationMs) bucket.maxDurationMs = durationMs;
  if (timestamp && (!bucket.lastUsedAt || timestamp > bucket.lastUsedAt))
    bucket.lastUsedAt = timestamp;
}

function addFailureToBucket(
  bucket: IntervalUsageBucket,
  durationMs: number,
  timestamp: string | null,
  failureClass: string | null | undefined,
  status: number | string | null | undefined
): void {
  bucket.failures += 1;
  bucket.durationMs += durationMs;
  if (durationMs > bucket.maxDurationMs) bucket.maxDurationMs = durationMs;
  bucket.lastFailure = {
    timestamp: timestamp ?? new Date().toISOString(),
    class: failureClass ?? null,
    status: status ?? null
  };
  if (timestamp && (!bucket.lastUsedAt || timestamp > bucket.lastUsedAt))
    bucket.lastUsedAt = timestamp;
}

function addSkippedToBucket(
  bucket: IntervalUsageBucket,
  timestamp: string | null
): void {
  bucket.skipped += 1;
  if (timestamp && (!bucket.lastUsedAt || timestamp > bucket.lastUsedAt))
    bucket.lastUsedAt = timestamp;
}

function addToolCallsToBucket(
  bucket: IntervalUsageBucket,
  toolCalls: number
): void {
  if (toolCalls > 0) bucket.toolCalls += toolCalls;
}

function finalizeBucket(bucket: IntervalUsageBucket): void {
  const turns = bucket.successes + bucket.failures;
  bucket.averageDurationMs = turns > 0 ? bucket.durationMs / turns : 0;
}

function getOrCreateBucket(
  collection: Record<string, IntervalUsageBucket>,
  key: string
): IntervalUsageBucket {
  if (!collection[key]) collection[key] = emptyUsageBucket();
  return collection[key];
}

function workspaceKey(event: RouterEvent): string {
  return event.workspace ?? "unattributed";
}

function originKey(event: RouterEvent): string {
  return event.role ?? "unattributed";
}

function modelKey(event: RouterEvent): string {
  if (event.provider && event.model) return `${event.provider}/${event.model}`;
  if (event.model) return event.model;
  if (event.requestedModel) return event.requestedModel;
  return "unattributed";
}

function eventDurationMs(event: RouterEvent): number {
  const ms = Number(event.elapsedMs);
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

function eventToolCalls(event: RouterEvent): number {
  const tc = Number(event.toolCalls);
  return Number.isFinite(tc) && tc > 0 ? tc : 0;
}

/**
 * Walks the bounded `recentEvents` history once, accumulating per-dimension
 * usage buckets. Returns the partial status override the caller spreads
 * into its existing payload.
 *
 * The function is pure and side-effect-free; the bounded input ranges are
 * the only authoritative interval source -- the lifetime cumulative maps
 * are never consulted. When `selection === "all"` the aggregator returns
 * `null` and the caller passes the lifetime payload through unchanged.
 */
function addRoutingEvents(
  input: LookbackAggregatorInput,
  windowStartMs: number | null,
  context: UsageContext
): void {
  for (const event of input.recentEvents) {
    if (
      inWindow(event.timestamp, windowStartMs, input.now) &&
      ROUTING_ATTEMPT_PHASES.has(event.phase)
    ) {
      processRoutingEvent(event, context);
    }
  }
}

function finalizeUsage(usage: IntervalUsage): void {
  finalizeBucket(usage.totals);
  for (const bucket of Object.values(usage.byRole)) finalizeBucket(bucket);
  for (const bucket of Object.values(usage.byModel)) finalizeBucket(bucket);
  for (const bucket of Object.values(usage.byOrigin)) finalizeBucket(bucket);
  for (const workspace of Object.values(usage.byWorkspace)) {
    finalizeBucket(workspace);
    for (const bucket of Object.values(workspace.byRole))
      finalizeBucket(bucket);
    for (const bucket of Object.values(workspace.byModel))
      finalizeBucket(bucket);
  }
}

function addSubagents(
  records: readonly LookbackSubagentRecord[] | null | undefined,
  windowStartMs: number | null,
  now: number,
  result: IntervalSubagents
): void {
  for (const record of records ?? []) {
    if (!inWindow(record.timestamp, windowStartMs, now)) continue;
    const count = Number(record.count ?? 1);
    if (!Number.isFinite(count) || count <= 0) continue;
    result.total += count;
    bumpStringCount(result.byMechanism, record.mechanism, count);
    bumpStringCount(
      result.byProvider,
      record.provider ?? "unattributed",
      count
    );
    bumpStringCount(result.byRole, record.role ?? "unattributed", count);
    bumpStringCount(result.byStatus, record.status ?? "started", count);
    result.recent.push(record);
  }
}

function addSpawnFailures(
  records: readonly LookbackSpawnFailureRecord[] | null | undefined,
  windowStartMs: number | null,
  now: number,
  result: IntervalSpawnFailures
): void {
  for (const record of records ?? []) {
    if (!inWindow(record.timestamp, windowStartMs, now)) continue;
    result.total += 1;
    bumpStringCount(result.byReason, record.reason, 1);
    result.recent.push(record);
  }
}

function addLiveFeedEvents(
  records: readonly LiveFeedEvent[],
  windowStartMs: number | null,
  now: number,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  for (const record of records) {
    if (inWindow(record.timestamp, windowStartMs, now))
      processLiveFeedRecord(record, telemetry, usage);
  }
}

function addOtelLookbackEvents(
  records: readonly OtelLookbackEvent[],
  windowStartMs: number | null,
  now: number,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  for (const event of records) {
    if (!inWindow(event.timestamp, windowStartMs, now)) continue;
    telemetry.lookbackEvents.push(event);
    if (event.family === "receiver") addReceiverLookbackEvent(event, telemetry);
    if (event.family === "turn") addTurnLookbackEvent(event, telemetry);
    if (event.family === "token") addTokenLookbackEvent(event, telemetry);
    if (event.family === "tool_result")
      addToolResultLookbackEvent(event, telemetry, usage);
    if (event.family === "tool") addToolLookbackEvent(event, telemetry, usage);
    if (event.family === "hook") addHookLookbackEvent(event, telemetry);
    if (event.family === "skill")
      addSkillLookbackEvent(event, telemetry, usage);
    if (event.family === "mcp") addMcpLookbackEvent(event, telemetry, usage);
  }
}

function addReceiverLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry
): void {
  if (event.type === "invalid") {
    telemetry.receiver.invalid += event.countDelta;
    return;
  }
  if (event.type !== "signal") return;
  if (
    event.name === "logs" ||
    event.name === "traces" ||
    event.name === "metrics"
  )
    telemetry.receiver[event.name] += event.countDelta;
}

function addTurnLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry
): void {
  if (event.type === "prompt") telemetry.turns.prompts += event.countDelta;
  if (event.type === "completed") telemetry.turns.completed += event.countDelta;
  if (event.type === "delta" && event.name === "prompt_length")
    telemetry.turns.promptLength += event.countDelta;
  if (event.type === "ttft") {
    telemetry.turns.ttftCount += event.durationCount ?? 0;
    telemetry.turns.ttftMs += event.durationSumMs ?? 0;
  }
  if (event.type === "thread_started") {
    telemetry.threads.started.total += event.countDelta;
    bumpStringCount(
      telemetry.threads.started.bySource,
      event.source ?? "unattributed",
      event.countDelta
    );
  }
  if (event.type === "thread_spawn") {
    telemetry.threads.spawns.total += event.countDelta;
    bumpStringCount(
      telemetry.threads.spawns.byStatus,
      event.status ?? "unattributed",
      event.countDelta
    );
    bumpStringCount(
      telemetry.threads.spawns.byRole,
      event.role ?? "unattributed",
      event.countDelta
    );
    bumpStringCount(
      telemetry.threads.spawns.byModel,
      event.model ?? "unattributed",
      event.countDelta
    );
  }
}

function addTokenLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry
): void {
  if (event.type !== "delta") return;
  if (
    event.name === "input" ||
    event.name === "output" ||
    event.name === "cached" ||
    event.name === "reasoning" ||
    event.name === "tool"
  ) {
    telemetry.tokens[event.name] += event.countDelta;
    telemetry.tokens.total += event.countDelta;
  }
}

function addToolResultLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  if (event.type !== "result") return;
  addToolResultTotals(event, telemetry.toolResults);
  addToolResultWorkspace(event, telemetry, usage);
}

function addToolResultTotals(
  event: OtelLookbackEvent,
  results: IntervalToolResults
): void {
  results.total += event.countDelta;
  results.executed += event.countDelta;
  results.causeResolved += event.resolvedCall ? event.countDelta : 0;
  results.causeUnresolved += event.resolvedCall ? 0 : event.countDelta;
  results.unattributed += event.resolvedCall ? 0 : event.countDelta;
  if (event.status)
    bumpStringCount(results.byStatus, event.status, event.countDelta);
  const row = upsertToolResultRow(results.byTool, event);
  row.count += event.countDelta;
  if (event.status)
    bumpStringCount(row.byStatus, event.status, event.countDelta);
  results.executionDurationMs.count += event.durationCount ?? 0;
  results.executionDurationMs.sum += event.durationSumMs ?? 0;
}

function addToolResultWorkspace(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  if (!event.server) return;
  const mcpServer = upsertMcpRow(telemetry.mcpServers, event.server);
  if (event.workspace) {
    const workspace = workspaceForOtelEvent(event, usage);
    if (workspace) {
      workspace.byMcp[event.server] =
        (workspace.byMcp[event.server] ?? 0) + event.countDelta;
      const mcpUse = upsertWorkspaceNamedRow(
        workspace.mcpUses,
        "server",
        event.server,
        { server: event.server, count: 0 }
      );
      mcpUse.count = Number(mcpUse.count ?? 0) + event.countDelta;
    }
  }
  mcpServer.observed += event.countDelta;
  if (!mcpServer.lastSeenAt || event.timestamp >= mcpServer.lastSeenAt) {
    mcpServer.lastSeenAt = event.timestamp;
    mcpServer.lastStatus = "observed";
  }
  if (event.model)
    bumpStringCount(mcpServer.byModel, event.model, event.countDelta);
  if (event.role)
    bumpStringCount(mcpServer.byRole, event.role, event.countDelta);
  if (event.workspace)
    bumpStringCount(mcpServer.byWorkspace, event.workspace, event.countDelta);
  if (event.agent)
    bumpStringCount(mcpServer.byAgent, event.agent, event.countDelta);
}

function upsertToolResultRow(
  rows: IntervalToolResultRow[],
  event: OtelLookbackEvent
): IntervalToolResultRow {
  const existing = rows.find(
    (row) =>
      row.tool === event.name &&
      row.source === event.source &&
      row.server === event.server
  );
  if (existing) return existing;
  const row: IntervalToolResultRow = {
    tool: event.name,
    source: event.source,
    server: event.server,
    count: 0,
    byStatus: {}
  };
  rows.push(row);
  return row;
}

function addToolLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  const row = upsertToolRow(telemetry.tools.byTool, {
    tool: event.name,
    source: event.source,
    server: event.server,
    count: 0,
    byStatus: {},
    durationCount: 0,
    durationMs: 0,
    averageDurationMs: 0
  });
  if (event.type === "counter") {
    row.count += event.countDelta;
    addStatusDelta(row, event.status, event.countDelta);
  }
  if (event.type === "duration") {
    row.durationCount += event.durationCount ?? 0;
    row.durationMs += event.durationSumMs ?? 0;
  }
  const workspace = workspaceForOtelEvent(event, usage);
  if (!workspace) return;
  const workspaceRow = upsertWorkspaceNamedRow(
    workspace.byTool,
    "tool",
    event.name,
    {
      tool: event.name,
      source: event.source,
      server: event.server,
      count: 0,
      byStatus: {}
    }
  );
  if (event.type === "counter") {
    workspaceRow.count = Number(workspaceRow.count ?? 0) + event.countDelta;
    addWorkspaceStatusDelta(workspaceRow, event.status, event.countDelta);
  }
}

function addHookLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry
): void {
  const row = upsertHookRow(telemetry.hooks.byHook, {
    hook: event.name,
    source: event.source,
    handlerType: null,
    count: 0,
    byStatus: {},
    durationCount: 0,
    durationMs: 0,
    averageDurationMs: 0
  });
  if (event.type === "counter") {
    row.count += event.countDelta;
    addStatusDelta(row, event.status, event.countDelta);
  }
  if (event.type === "duration") {
    row.durationCount += event.durationCount ?? 0;
    row.durationMs += event.durationSumMs ?? 0;
  }
}

function addSkillLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  if (event.type === "used") {
    const row = upsertSkillRow(telemetry.skills.used.bySkill, {
      skill: event.name,
      total: 0,
      uses: 0,
      byStatus: {}
    });
    row.uses += event.countDelta;
    row.total += event.countDelta;
    telemetry.skills.used.total += event.countDelta;
    addStatusDelta(row, event.status, event.countDelta);
    const workspace = workspaceForOtelEvent(event, usage);
    if (workspace) {
      workspace.skillUses += event.countDelta;
      const workspaceRow = upsertWorkspaceNamedRow(
        workspace.bySkill,
        "skill",
        event.name,
        { skill: event.name, count: 0, uses: 0, byStatus: {} }
      );
      workspaceRow.count = Number(workspaceRow.count ?? 0) + event.countDelta;
      workspaceRow.uses = Number(workspaceRow.uses ?? 0) + event.countDelta;
      addWorkspaceStatusDelta(workspaceRow, event.status, event.countDelta);
    }
  }
  if (event.type === "injected") {
    telemetry.skills.injected.total += event.countDelta;
    const row = upsertSkillRow(telemetry.skills.injected.bySkill, {
      skill: event.name,
      total: 0,
      uses: 0,
      byStatus: {}
    });
    row.total += event.countDelta;
    addStatusDelta(row, event.status, event.countDelta);
  }
  if (event.type === "duration") {
    const histogram = skillHistogramForMetric(telemetry.skills, event.name);
    if (histogram) {
      histogram.count += event.countDelta;
      histogram.sum += event.sumDelta ?? 0;
    }
  }
}

function skillHistogramForMetric(
  skills: IntervalCodexTelemetry["skills"],
  metric: string
): IntervalHistogram | null {
  if (metric === "codex.skill.turn.duration_seconds")
    return skills.turnDuration.durationSeconds;
  if (metric === "codex.thread.skills.enabled_total")
    return skills.threads.enabledTotal;
  if (metric === "codex.thread.skills.kept_total")
    return skills.threads.keptTotal;
  if (metric === "codex.thread.skills.truncated")
    return skills.threads.truncated;
  if (metric === "codex.thread.skills.description_truncated_chars")
    return skills.threads.descriptionTruncatedChars;
  return null;
}

function addMcpLookbackEvent(
  event: OtelLookbackEvent,
  telemetry: IntervalCodexTelemetry,
  usage: IntervalUsage
): void {
  if (event.type !== "observation" && event.type !== "use") return;
  const row = upsertMcpRow(telemetry.mcpServers, event.name);
  row.observed += event.countDelta;
  if (!row.lastSeenAt || event.timestamp >= row.lastSeenAt) {
    row.lastSeenAt = event.timestamp;
    row.lastStatus = event.status ?? "observed";
  }
  if (event.status === "ready" || event.status === "ok")
    row.ready += event.countDelta;
  if (event.status === "error" || event.status === "failure")
    row.error += event.countDelta;
  if (event.status === "stale") row.stale += event.countDelta;
  if (event.model) bumpStringCount(row.byModel, event.model, event.countDelta);
  if (event.role) bumpStringCount(row.byRole, event.role, event.countDelta);
  if (event.workspace)
    bumpStringCount(row.byWorkspace, event.workspace, event.countDelta);
  if (event.agent) bumpStringCount(row.byAgent, event.agent, event.countDelta);
  if (event.type !== "use") return;
  const workspace = workspaceForOtelEvent(event, usage);
  if (!workspace) return;
  workspace.byMcp[event.name] =
    (workspace.byMcp[event.name] ?? 0) + event.countDelta;
  const uses = upsertWorkspaceNamedRow(
    workspace.mcpUses,
    "server",
    event.name,
    { server: event.name, count: 0 }
  );
  uses.count = Number(uses.count ?? 0) + event.countDelta;
}

function workspaceForOtelEvent(
  event: OtelLookbackEvent,
  usage: IntervalUsage
): IntervalWorkspaceUsageBucket | null {
  if (!event.workspace) return null;
  if (!usage.byWorkspace[event.workspace])
    usage.byWorkspace[event.workspace] = createWorkspaceBucket(null);
  return usage.byWorkspace[event.workspace] ?? null;
}

function addStatusDelta(
  row: {
    byStatus: {
      ok?: number;
      error?: number;
      success?: number;
      failure?: number;
      skipped?: number;
    };
  },
  status: string | null,
  count: number
): void {
  addStatusCount(row.byStatus, status, null, count);
}

function addWorkspaceStatusDelta(
  row: WorkspaceNamedRow,
  status: string | null,
  count: number
): void {
  const byStatus = row.byStatus ?? {};
  addStatusCount(byStatus, status, null, count);
  row.byStatus = byStatus;
}

function addStatusCount(
  byStatus: {
    ok?: number;
    error?: number;
    success?: number;
    failure?: number;
    skipped?: number;
  },
  status: string | number | null,
  outcome: string | null,
  count: number
): void {
  const statusText = typeof status === "string" ? status.toLowerCase() : null;
  const outcomeText = outcome?.toLowerCase() ?? null;
  if (
    statusText === "ok" ||
    statusText === "success" ||
    outcomeText === "success"
  ) {
    byStatus.ok = (byStatus.ok ?? 0) + count;
    byStatus.success = (byStatus.success ?? 0) + count;
  } else if (
    statusText === "error" ||
    statusText === "failure" ||
    statusText === "failed" ||
    outcomeText === "failure" ||
    outcomeText === "error" ||
    statusText === "stale"
  ) {
    byStatus.error = (byStatus.error ?? 0) + count;
    if (statusText !== "stale")
      byStatus.failure = (byStatus.failure ?? 0) + count;
  } else if (statusText === "skipped" || outcomeText === "skipped") {
    byStatus.skipped = (byStatus.skipped ?? 0) + count;
  }
}

function finalizeCodexTelemetry(telemetry: IntervalCodexTelemetry): void {
  telemetry.turns.averageTtftMs =
    telemetry.turns.ttftCount > 0
      ? Math.round(telemetry.turns.ttftMs / telemetry.turns.ttftCount)
      : 0;
  telemetry.toolResults.executionDurationMs.average =
    telemetry.toolResults.executionDurationMs.count > 0
      ? telemetry.toolResults.executionDurationMs.sum /
        telemetry.toolResults.executionDurationMs.count
      : 0;
  telemetry.mcpSummary = summarizeIntervalMcp(telemetry.mcpServers);
  for (const histogram of [
    telemetry.skills.turnDuration.durationSeconds,
    telemetry.skills.threads.enabledTotal,
    telemetry.skills.threads.keptTotal,
    telemetry.skills.threads.truncated,
    telemetry.skills.threads.descriptionTruncatedChars
  ]) {
    histogram.average =
      histogram.count > 0 ? histogram.sum / histogram.count : 0;
  }
  finalizeDurationRows(telemetry.tools.byTool);
  finalizeDurationRows(telemetry.hooks.byHook);
  telemetry.skills.used.bySkill.sort((a, b) =>
    STRING_COLLATOR.compare(a.skill, b.skill)
  );
  telemetry.tools.byTool.sort((a, b) =>
    STRING_COLLATOR.compare(
      `${a.tool}/${a.source ?? ""}/${a.server ?? ""}`,
      `${b.tool}/${b.source ?? ""}/${b.server ?? ""}`
    )
  );
  telemetry.hooks.byHook.sort((a, b) =>
    STRING_COLLATOR.compare(
      `${a.hook}/${a.source ?? ""}/${a.handlerType ?? ""}`,
      `${b.hook}/${b.source ?? ""}/${b.handlerType ?? ""}`
    )
  );
  telemetry.mcpServers.sort((a, b) => STRING_COLLATOR.compare(a.name, b.name));
  telemetry.toolResults.byTool.sort((a, b) =>
    STRING_COLLATOR.compare(
      `${a.tool}/${a.source ?? ""}/${a.server ?? ""}`,
      `${b.tool}/${b.source ?? ""}/${b.server ?? ""}`
    )
  );
}

function summarizeIntervalMcp(
  servers: IntervalCodexTelemetry["mcpServers"]
): IntervalCodexTelemetry["mcpSummary"] {
  const summary: IntervalCodexTelemetry["mcpSummary"] = {
    observed: 0,
    ready: 0,
    error: 0,
    stale: 0,
    byRole: {},
    byWorkspace: {},
    byModel: {},
    byAgent: {}
  };
  for (const server of servers) {
    summary.observed += 1;
    if (server.lastStatus === "ready" || server.lastStatus === "ok")
      summary.ready += 1;
    if (server.lastStatus === "error" || server.lastStatus === "failure")
      summary.error += 1;
    if (server.lastStatus === "stale") summary.stale += 1;
    addMcpDimensionCounts(summary.byRole, server.byRole, server.lastStatus);
    addMcpDimensionCounts(
      summary.byWorkspace,
      server.byWorkspace,
      server.lastStatus
    );
    addMcpDimensionCounts(summary.byModel, server.byModel, server.lastStatus);
    addMcpDimensionCounts(summary.byAgent, server.byAgent, server.lastStatus);
  }
  return summary;
}

function addMcpDimensionCounts(
  summary: Record<
    string,
    { observed: number; ready: number; error: number; stale: number }
  >,
  dimension: Record<string, number>,
  lastStatus: string
): void {
  for (const key of Object.keys(dimension)) {
    const bucket = summary[key] ?? {
      observed: 0,
      ready: 0,
      error: 0,
      stale: 0
    };
    bucket.observed += 1;
    if (lastStatus === "ready" || lastStatus === "ok") bucket.ready += 1;
    if (lastStatus === "error" || lastStatus === "failure") bucket.error += 1;
    if (lastStatus === "stale") bucket.stale += 1;
    summary[key] = bucket;
  }
}

function finalizeDurationRows(
  rows: Array<{
    durationCount: number;
    durationMs: number;
    averageDurationMs: number;
  }>
): void {
  for (const row of rows) {
    row.averageDurationMs =
      row.durationCount > 0 ? row.durationMs / row.durationCount : 0;
  }
}

function addIdentity(set: Set<string>, value: string | null | undefined): void {
  if (typeof value === "string" && value.trim()) set.add(value.trim());
}

function addAgentIdentity(scope: ActiveAgentScope, value: string): void {
  scope.agentIds.add(safeAgentIdentity(value));
}

function addBridgeIdentity(scope: ActiveAgentScope, bridgeKey: string): void {
  const separator = bridgeKey.indexOf("\0");
  if (separator === -1) return;
  addIdentity(scope.requestIds, bridgeKey.slice(0, separator));
  const childId = bridgeKey.slice(separator + 1);
  if (childId) addAgentIdentity(scope, childId);
}

function addSubjectIdentity(
  scope: ActiveAgentScope,
  subject: string,
  matchingThread: string | null | undefined
): void {
  if (subject.startsWith("thread:")) {
    const threadId = matchingThread ?? subject.slice("thread:".length);
    addIdentity(scope.threadIds, threadId);
    if (threadId) addAgentIdentity(scope, threadId);
  } else if (subject.startsWith("req:")) {
    addIdentity(scope.requestIds, subject.slice("req:".length));
  } else if (subject.startsWith("bridge-parent:")) {
    addIdentity(scope.requestIds, subject.slice("bridge-parent:".length));
  } else if (subject.startsWith("bridge:")) {
    addBridgeIdentity(scope, subject.slice("bridge:".length));
  } else if (subject !== "process-scope") {
    const threadId = matchingThread ?? subject;
    addIdentity(scope.threadIds, threadId);
    addAgentIdentity(scope, threadId);
  }
}

function addRequestIdentity(
  scope: ActiveAgentScope,
  requestId: string | null
): void {
  if (!requestId) return;
  const separator = requestId.indexOf("\0");
  if (separator !== -1) {
    addIdentity(scope.requestIds, requestId.slice(0, separator));
    const childId = requestId.slice(separator + 1);
    if (childId) addAgentIdentity(scope, childId);
  } else if (requestId.startsWith("bridge-parent:")) {
    addIdentity(scope.requestIds, requestId.slice("bridge-parent:".length));
  } else {
    addIdentity(scope.requestIds, requestId);
  }
}

function addActiveAgentIdentity(
  scope: ActiveAgentScope,
  agent: LookbackActiveAgent,
  recentEvents: readonly RouterEvent[]
): void {
  const requestId =
    typeof agent.requestId === "string" ? agent.requestId : null;
  const matchingThread = requestId
    ? recentEvents.find((event) => event.requestId === requestId)?.thread
    : null;
  addSubjectIdentity(scope, agent.subject, matchingThread);
  addRequestIdentity(scope, requestId);
}

function activeAgentScope(
  agents: readonly LookbackActiveAgent[] | null | undefined,
  recentEvents: readonly RouterEvent[]
): ActiveAgentScope {
  const scope: ActiveAgentScope = {
    threadIds: new Set(),
    agentIds: new Set(),
    requestIds: new Set()
  };
  for (const agent of agents ?? [])
    addActiveAgentIdentity(scope, agent, recentEvents);

  // Resolve synthetic activity subjects that name a request back to the
  // Codex thread carried by that exact request. This also supplies the
  // canonical OTel agent identity for bridge-parent records.
  for (const event of recentEvents) {
    if (
      event.thread &&
      event.requestId &&
      scope.requestIds.has(event.requestId)
    ) {
      addIdentity(scope.threadIds, event.thread);
      addAgentIdentity(scope, event.thread);
    }
  }

  // Router events carry the originating Codex thread. Their request IDs are
  // the exact join key for bridge feed and spawn records without a thread.
  for (const event of recentEvents) {
    if (event.thread && scope.threadIds.has(event.thread))
      addIdentity(scope.requestIds, event.requestId);
  }
  return scope;
}

function eventBelongsToActiveAgent(
  event: RouterEvent,
  scope: ActiveAgentScope
): boolean {
  return Boolean(
    (event.thread && scope.threadIds.has(event.thread)) ||
    (event.requestId && scope.requestIds.has(event.requestId))
  );
}

function liveFeedEventBelongsToActiveAgent(
  event: LiveFeedEvent,
  scope: ActiveAgentScope
): boolean {
  return Boolean(
    (event.requestId && scope.requestIds.has(event.requestId)) ||
    (event.agent && scope.agentIds.has(safeAgentIdentity(event.agent)))
  );
}

function otelEventBelongsToActiveAgent(
  event: OtelLookbackEvent,
  scope: ActiveAgentScope
): boolean {
  if (!event.agent || event.agent === "unattributed") return false;
  return scope.agentIds.has(safeAgentIdentity(event.agent));
}

export function aggregateLookbackView(
  input: LookbackAggregatorInput
): IntervalRouterStatusOverride | null {
  if (input.selection === "all") return null;
  const windowStartMs = lookbackWindowStartMs(
    input.now,
    input.selection,
    "America/New_York"
  );
  const activeScope =
    input.selection === "active"
      ? activeAgentScope(input.activeAgents, input.recentEvents)
      : null;
  const recentEvents = input.recentEvents.filter(
    (event) =>
      inWindow(event.timestamp, windowStartMs, input.now) &&
      (!activeScope || eventBelongsToActiveAgent(event, activeScope))
  );
  const liveFeed = input.liveFeed.filter(
    (event) =>
      inWindow(event.timestamp, windowStartMs, input.now) &&
      (!activeScope || liveFeedEventBelongsToActiveAgent(event, activeScope))
  );
  const otelLookbackEvents = (input.otelLookbackEvents ?? []).filter(
    (event) =>
      inWindow(event.timestamp, windowStartMs, input.now) &&
      (!activeScope || otelEventBelongsToActiveAgent(event, activeScope))
  );
  const subagentRecent = (input.subagentRecent ?? []).filter(
    (record) =>
      inWindow(record.timestamp, windowStartMs, input.now) &&
      (!activeScope ||
        Boolean(
          record.requestId && activeScope.requestIds.has(record.requestId)
        ))
  );
  const spawnFailureRecent = (input.spawnFailureRecent ?? []).filter(
    (record) =>
      inWindow(record.timestamp, windowStartMs, input.now) &&
      (!activeScope ||
        Boolean(
          record.requestId && activeScope.requestIds.has(record.requestId)
        ))
  );
  const activeAgentStates =
    input.selection === "active"
      ? (input.activeAgents ?? []).reduce<Record<string, number>>(
          (counts, agent) => {
            if (agent.state)
              counts[agent.state] = (counts[agent.state] ?? 0) + 1;
            return counts;
          },
          {}
        )
      : undefined;

  const usage: IntervalUsage = {
    totals: emptyUsageBucket(),
    byRole: {},
    byModel: {},
    byWorkspace: {},
    byOrigin: {}
  };
  const providerCounts = new Map<string, IntervalProviderCounts>();
  const subagents: IntervalSubagents = {
    total: 0,
    byMechanism: {},
    byProvider: {},
    byRole: {},
    byStatus: {},
    recent: []
  };
  const spawnFailures: IntervalSpawnFailures = {
    total: 0,
    byReason: {},
    recent: []
  };
  const codexTelemetry = createEmptyCodexTelemetry();
  const boundedByRingBuffer = true;

  const usageContext: UsageContext = {
    usage,
    providerCounts
  };
  addRoutingEvents({ ...input, recentEvents }, windowStartMs, usageContext);
  finalizeUsage(usage);
  addSubagents(subagentRecent, windowStartMs, input.now, subagents);
  addSpawnFailures(spawnFailureRecent, windowStartMs, input.now, spawnFailures);
  addOtelLookbackEvents(
    otelLookbackEvents,
    windowStartMs,
    input.now,
    codexTelemetry,
    usage
  );
  addLiveFeedEvents(liveFeed, windowStartMs, input.now, codexTelemetry, usage);
  finalizeCodexTelemetry(codexTelemetry);

  return {
    lookback: {
      selection: input.selection,
      windowStartMs,
      windowEndMs: input.now,
      boundedByRingBuffer
    },
    usage,
    codexTelemetry,
    subagents,
    spawnFailures,
    providers: Object.fromEntries(providerCounts),
    recentEvents,
    liveFeed,
    ...(activeAgentStates ? { activeAgentStates } : {})
  };
}

function readDuration(record: LiveFeedEvent): number | null {
  const ms = Number(record.durationMs);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function readStatus(record: LiveFeedEvent): string | number | null {
  const status = record.status;
  if (status === null || status === undefined) return null;
  if (typeof status === "string") return status.trim() ? status : null;
  if (typeof status === "number")
    return Number.isFinite(status) ? status : null;
  return null;
}

function readTextField(record: LiveFeedEvent, key: string): string | null {
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function bumpToolStatus(
  row: {
    byStatus: {
      ok?: number;
      error?: number;
      success?: number;
      failure?: number;
      skipped?: number;
    };
  },
  status: string | number | null,
  outcome: string | null
): void {
  addStatusCount(row.byStatus, status, outcome, 1);
}

function bumpStringCount(
  collection: Record<string, number>,
  key: string,
  amount: number
): void {
  collection[key] = (collection[key] ?? 0) + amount;
}

function ensureProviderCounts(
  map: Map<string, IntervalProviderCounts>,
  provider: string | null
): IntervalProviderCounts {
  const key = provider ?? "unattributed";
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      durationMs: 0,
      maxDurationMs: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null
    };
    map.set(key, bucket);
  }
  return bucket;
}

function createWorkspaceBucket(
  cwd: string | null
): IntervalWorkspaceUsageBucket {
  return {
    ...emptyUsageBucket(),
    cwd,
    skillUses: 0,
    byRole: {},
    byModel: {},
    byMcp: {},
    toolsExecuted: 0,
    toolsRequested: 0,
    toolsUnavailable: 0,
    skillsExposed: 0,
    byTool: [],
    bySkill: [],
    bridgeTools: [],
    bridgeSkills: [],
    mcpUses: [],
    mcpExposed: []
  };
}

function createEmptyCodexTelemetry(): IntervalCodexTelemetry {
  return {
    lookbackEvents: [],
    receiver: { logs: 0, traces: 0, metrics: 0, invalid: 0 },
    turns: {
      prompts: 0,
      completed: 0,
      promptLength: 0,
      ttftCount: 0,
      ttftMs: 0,
      averageTtftMs: 0
    },
    threads: {
      started: { total: 0, bySource: {} },
      spawns: { total: 0, byStatus: {}, byRole: {}, byModel: {} }
    },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0, tool: 0, total: 0 },
    toolResults: {
      total: 0,
      executed: 0,
      unattributed: 0,
      causeResolved: 0,
      causeUnresolved: 0,
      byStatus: {},
      byTool: [],
      executionDurationMs: { count: 0, sum: 0, average: 0 }
    },
    mcpSummary: {
      observed: 0,
      ready: 0,
      error: 0,
      stale: 0,
      byRole: {},
      byWorkspace: {},
      byModel: {},
      byAgent: {}
    },
    tools: { byTool: [] },
    hooks: { byHook: [] },
    skills: {
      used: { total: 0, bySkill: [] },
      injected: { total: 0, bySkill: [] },
      exposed: { total: 0 },
      turnDuration: { durationSeconds: { count: 0, sum: 0, average: 0 } },
      threads: {
        enabledTotal: { count: 0, sum: 0, average: 0 },
        keptTotal: { count: 0, sum: 0, average: 0 },
        truncated: { count: 0, sum: 0, average: 0 },
        descriptionTruncatedChars: { count: 0, sum: 0, average: 0 }
      }
    },
    mcpServers: [],
    bridgeEvents: {
      toolExecuted: { total: 0, byTool: {} },
      toolRequested: { total: 0, byTool: {} },
      toolUnavailable: { total: 0, byTool: {}, byReason: {} },
      skillExposed: { total: 0 }
    }
  };
}

function upsertToolRow(
  rows: IntervalToolRow[],
  template: IntervalToolRow
): IntervalToolRow {
  const existing = rows.find(
    (row) =>
      row.tool === template.tool &&
      (row.source ?? "") === (template.source ?? "") &&
      (row.server ?? "") === (template.server ?? "")
  );
  if (existing) return existing;
  const row = { ...template, byStatus: { ...template.byStatus } };
  rows.push(row);
  return row;
}

function upsertHookRow(
  rows: IntervalHookRow[],
  template: IntervalHookRow
): IntervalHookRow {
  const existing = rows.find(
    (row) =>
      row.hook === template.hook &&
      (row.source ?? "") === (template.source ?? "") &&
      (row.handlerType ?? "") === (template.handlerType ?? "")
  );
  if (existing) return existing;
  const row = { ...template, byStatus: { ...template.byStatus } };
  rows.push(row);
  return row;
}

function upsertSkillRow(
  rows: IntervalSkillRow[],
  template: IntervalSkillRow
): IntervalSkillRow {
  const existing = rows.find((row) => row.skill === template.skill);
  if (existing) return existing;
  const row = { ...template, byStatus: { ...template.byStatus } };
  rows.push(row);
  return row;
}

function upsertMcpRow(
  rows: IntervalCodexTelemetry["mcpServers"],
  name: string
): IntervalCodexTelemetry["mcpServers"][number] {
  const existing = rows.find((row) => row.name === name);
  if (existing) return existing;
  const row: IntervalCodexTelemetry["mcpServers"][number] = {
    name,
    observed: 0,
    ready: 0,
    error: 0,
    stale: 0,
    lastSeenAt: null,
    lastStatus: "unknown",
    byModel: {},
    byRole: {},
    byWorkspace: {},
    byAgent: {}
  };
  rows.push(row);
  return row;
}

/**
 * Spreads the aggregator's selection-scoped overrides into a `RouterStatus`
 * payload while preserving every other top-level field. The dashboard's
 * `applyLookback(status)` helper is replaced by `applyIntervalLookback`,
 * which delegates to this function and only ever returns the override
 * fields for the requested selection. `All` returns the input status
 * unchanged so the `All` view continues to use the lifetime cumulative
 * maps.
 */
type LookbackStatusInput = {
  recentEvents?: readonly RouterEvent[];
  liveFeed?: readonly LiveFeedEvent[];
  subagents?: { recent?: readonly LookbackSubagentRecord[] } | null;
  spawnFailures?: { recent?: readonly LookbackSpawnFailureRecord[] } | null;
  [key: string]: unknown;
};

type LookbackStatusFields = {
  recentEvents: RouterEvent[];
  liveFeed: LiveFeedEvent[];
  lookback: IntervalRouterStatusOverride["lookback"];
  usage: IntervalUsage;
  codexTelemetry: Record<string, unknown>;
  subagents: Record<string, unknown>;
  spawnFailures: Record<string, unknown>;
  providers?: Record<string, unknown>;
  agents?: Record<string, unknown>;
};

export function applyIntervalLookback<T extends LookbackStatusInput>(
  status: T,
  selection: "all",
  now?: number,
  activeAgents?: readonly LookbackActiveAgent[]
): T;
export function applyIntervalLookback<T extends LookbackStatusInput>(
  status: T,
  selection: Exclude<LookbackSelection, "all">,
  now?: number,
  activeAgents?: readonly LookbackActiveAgent[]
): T & LookbackStatusFields;
export function applyIntervalLookback<T extends LookbackStatusInput>(
  status: T,
  selection: LookbackSelection,
  now?: number,
  activeAgents?: readonly LookbackActiveAgent[]
): T | (T & LookbackStatusFields);
export function applyIntervalLookback<T extends LookbackStatusInput>(
  status: T,
  selection: LookbackSelection,
  now: number = Date.now(),
  activeAgents: readonly LookbackActiveAgent[] = []
): T | (T & LookbackStatusFields) {
  if (selection === "all") return status;
  const codexTelemetry = status.codexTelemetry as
    { lookbackEvents?: readonly OtelLookbackEvent[] | null } | undefined;
  const override = aggregateLookbackView({
    recentEvents: status.recentEvents ?? [],
    liveFeed: status.liveFeed ?? [],
    otelLookbackEvents: codexTelemetry?.lookbackEvents ?? [],
    subagentRecent: status.subagents?.recent ?? null,
    spawnFailureRecent: status.spawnFailures?.recent ?? null,
    activeAgents,
    now,
    selection
  });
  if (!override) return status;
  return Object.assign({}, status, {
    recentEvents: override.recentEvents,
    liveFeed: override.liveFeed.map(({ agent: _agent, ...event }) => event),
    usage: override.usage,
    codexTelemetry: mergeCodexTelemetry(
      (status.codexTelemetry as Record<string, unknown> | undefined) ?? {},
      override.codexTelemetry,
      selection
    ),
    subagents: mergeSubagents(
      (status.subagents as Record<string, unknown> | undefined) ?? {},
      override.subagents
    ),
    spawnFailures: mergeSpawnFailures(
      (status.spawnFailures as Record<string, unknown> | undefined) ?? {},
      override.spawnFailures
    ),
    ...(status.providers && typeof status.providers === "object"
      ? {
          providers: mergeProviders(
            status.providers as Record<string, unknown>,
            override.providers
          )
        }
      : {}),
    ...(override.activeAgentStates
      ? {
          agents: mergeActiveAgentStates(
            (status.agents as Record<string, unknown> | undefined) ?? {},
            override.activeAgentStates
          )
        }
      : {}),
    lookback: override.lookback
  }) as T & LookbackStatusFields;
}

function mergeActiveAgentStates(
  existing: Record<string, unknown>,
  activeStates: Record<string, number>
): Record<string, unknown> {
  const existingStates =
    existing.byState && typeof existing.byState === "object"
      ? (existing.byState as Record<string, unknown>)
      : {};
  const states = new Set([
    ...Object.keys(existingStates),
    ...Object.keys(activeStates)
  ]);
  const byState = Object.fromEntries(
    Array.from(states, (state) => [state, activeStates[state] ?? 0])
  );
  return { ...existing, byState };
}

function mergeCodexTelemetry(
  existing: Record<string, unknown>,
  interval: IntervalCodexTelemetry,
  selection: LookbackSelection
): Record<string, unknown> {
  const existingReceiver =
    (existing.receiver as Record<string, unknown> | undefined) ?? {};
  const existingSkills = existing.skills as Record<string, unknown> | undefined;
  const lookbackEvents =
    selection === "active"
      ? interval.lookbackEvents.map(({ agent: _agent, ...event }) => event)
      : interval.lookbackEvents;
  const next: Record<string, unknown> = {
    ...existing,
    lookbackEvents,
    receiver:
      selection === "active"
        ? { ...existingReceiver }
        : { ...existingReceiver, ...interval.receiver },
    turns: {
      ...(existing.turns as Record<string, unknown> | undefined),
      ...interval.turns
    },
    threads: {
      ...(existing.threads as Record<string, unknown> | undefined),
      started: {
        ...((existing.threads as Record<string, unknown> | undefined)
          ?.started as Record<string, unknown> | undefined),
        ...interval.threads.started
      },
      spawns: {
        ...((existing.threads as Record<string, unknown> | undefined)
          ?.spawns as Record<string, unknown> | undefined),
        ...interval.threads.spawns
      }
    },
    tokens: {
      ...(existing.tokens as Record<string, unknown> | undefined),
      ...interval.tokens
    },
    toolResults: interval.toolResults,
    tools: {
      ...(existing.tools as Record<string, unknown> | undefined),
      byTool: interval.tools.byTool
    },
    hooks: {
      ...(existing.hooks as Record<string, unknown> | undefined),
      byHook: interval.hooks.byHook
    },
    skills: {
      ...existingSkills,
      used: {
        ...(existingSkills?.used as Record<string, unknown> | undefined),
        total: interval.skills.used.total,
        bySkill: interval.skills.used.bySkill
      },
      injected: {
        ...(existingSkills?.injected as Record<string, unknown> | undefined),
        total: interval.skills.injected.total,
        bySkill: interval.skills.injected.bySkill
      },
      exposed: {
        ...(existingSkills?.exposed as Record<string, unknown> | undefined),
        total: interval.skills.exposed.total
      },
      turnDuration: interval.skills.turnDuration,
      threads: interval.skills.threads
    },
    mcpServers: interval.mcpServers,
    mcpSummary: interval.mcpSummary,
    bridgeEvents: {
      ...(existing.bridgeEvents as Record<string, unknown> | undefined),
      toolExecuted: interval.bridgeEvents.toolExecuted,
      toolRequested: interval.bridgeEvents.toolRequested,
      toolUnavailable: interval.bridgeEvents.toolUnavailable,
      skillExposed: interval.bridgeEvents.skillExposed
    }
  };
  return next;
}

function mergeSubagents(
  existing: Record<string, unknown>,
  interval: IntervalSubagents
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    total: interval.total,
    byMechanism: { ...interval.byMechanism },
    byProvider: { ...interval.byProvider },
    byRole: { ...interval.byRole },
    byStatus: { ...interval.byStatus },
    recent: interval.recent
  };
  return next;
}

function mergeSpawnFailures(
  existing: Record<string, unknown>,
  interval: IntervalSpawnFailures
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    total: interval.total,
    byReason: { ...interval.byReason },
    recent: interval.recent
  };
  return next;
}

function mergeProviders(
  existing: Record<string, unknown>,
  interval: Record<string, IntervalProviderCounts>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [provider, existingEntry] of Object.entries(existing)) {
    if (!existingEntry || typeof existingEntry !== "object") continue;
    const counts = interval[provider] ?? zeroIntervalProviderCounts();
    const merged = {
      ...(existingEntry as Record<string, unknown>),
      attempts: counts.attempts,
      successes: counts.successes,
      failures: counts.failures,
      skipped: counts.skipped,
      durationMs: counts.durationMs,
      maxDurationMs: counts.maxDurationMs,
      lastAttemptAt: counts.lastAttemptAt,
      lastSuccessAt: counts.lastSuccessAt,
      lastFailureAt: counts.lastFailureAt
    };
    next[provider] = merged;
  }
  for (const [provider, counts] of Object.entries(interval)) {
    if (next[provider]) continue;
    next[provider] = {
      attempts: counts.attempts,
      successes: counts.successes,
      failures: counts.failures,
      skipped: counts.skipped,
      durationMs: counts.durationMs,
      maxDurationMs: counts.maxDurationMs,
      lastAttemptAt: counts.lastAttemptAt,
      lastSuccessAt: counts.lastSuccessAt,
      lastFailureAt: counts.lastFailureAt
    };
  }
  return next;
}

function zeroIntervalProviderCounts(): IntervalProviderCounts {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    skipped: 0,
    durationMs: 0,
    maxDurationMs: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null
  };
}
