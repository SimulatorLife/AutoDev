import type {
  ControlApiMcpRuntimeHealth,
  ControlApiMcpRuntimeServer
} from "@simulatorlife/autodev-core";

import { safeMetricLabel } from "./metric-label.ts";
import { recordSkillObservation } from "./telemetry.ts";
import {
  extractWorkspaceIdWithAmbiguity,
  getDefaultUsageTracker,
  safeAgentIdentity,
  safePrivacyWorkspace,
  safeWorkspaceId,
  UNATTRIBUTED_DIMENSION,
  type UsageTracker
} from "./usage.ts";

/**
 * The attributes a bridge report carries.
 *
 * The values are untrusted -- they arrive over the wire from a bridge -- so
 * every read of one goes through a guard rather than a cast.
 */
export type AttributeMap = Record<string, unknown>;

export const MCP_OBSERVATION_TTL_MS_DEFAULT = 120_000;
export const MCP_OBSERVATION_TTL_MS = Number.parseInt(
  process.env.CODEX_ROUTER_MCP_OBSERVATION_TTL_MS ?? "120000"
);
export const PENDING_MCP_MODEL_CONVERSATION_LIMIT = 1000;
export const PENDING_MCP_MODEL_OBSERVATION_LIMIT = 200;
export const MCP_DISCOVERY_SPAN_NAMES = new Set([
  "list_tools_for_client_uncached",
  "list_tools_with_connector_ids"
]);

export interface McpServerDimensionBucket {
  observed: number;
  lastSeenAt: string | null;
  lastStatus: string;
  agentKind?: string;
  ready?: number;
  error?: number;
  stale?: number;
  health?: string;
}

export interface McpServerEntry {
  name: string;
  lastSeenAt: string | null;
  failures: number;
  durationMs: number;
  durationCount: number;
  lastStatus: string;
  byRole: Record<string, McpServerDimensionBucket>;
  byWorkspace: Record<string, McpServerDimensionBucket>;
  byModel: Record<string, McpServerDimensionBucket>;
  byAgent: Record<string, McpServerDimensionBucket>;
}

export interface ContextDimensionBucket {
  count: number;
  lastSeenAt: string | null;
  agentKind?: string;
}

export interface ContextDimensions {
  byRole: Record<string, ContextDimensionBucket>;
  byWorkspace: Record<string, ContextDimensionBucket>;
  byModel: Record<string, ContextDimensionBucket>;
  byAgent: Record<string, ContextDimensionBucket>;
}

/**
 * The dimensions a context is counted under, and the context field each one
 * takes its value from.
 */
export const CONTEXT_DIMENSION_FIELDS = [
  ["byRole", "role"],
  ["byWorkspace", "workspace"],
  ["byModel", "model"],
  ["byAgent", "agent"]
] as const;

export function emptyContextDimensions(): ContextDimensions {
  return { byRole: {}, byWorkspace: {}, byModel: {}, byAgent: {} };
}

export interface SkillUsedSkillBucket {
  skill: string;
  total: number;
  byRole: Record<string, number>;
  byWorkspace: Record<string, number>;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  lastSeenAt: string | null;
}

export interface SkillUsedEntry {
  total: number;
  bySkill: Map<string, SkillUsedSkillBucket>;
  byRole: Record<string, number>;
  byWorkspace: Record<string, number>;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  lastSeenAt: string | null;
}

export interface BridgeToolRow {
  tool: string;
  server: string;
  callId?: string | null;
  count: number;
  byStatus: Record<string, number>;
}

export interface BridgeWorkspaceRow {
  workspaceKey: string;
  count: number;
  byTool: Map<string, BridgeToolRow>;
  bySkill?: Map<string, number>;
  byStatus: Record<string, number>;
}

export interface BridgeToolBucket {
  total: number;
  byTool: Map<string, BridgeToolRow>;
  byWorkspace: Map<string, BridgeWorkspaceRow>;
  byReason?: Record<string, number>;
}

export interface BridgeSkillEntry {
  skill: string;
  source: string;
  pluginId: string;
  count: number;
  byWorkspace?: Map<string, number>;
}

export interface BridgeSkillBucket {
  total: number;
  bySkill: Map<string, BridgeSkillEntry>;
  byWorkspace: Map<
    string,
    { workspaceKey: string; count: number; bySkill: Map<string, number> }
  >;
  seenKeys?: Set<string>;
}

export interface BridgeMcpEntry {
  server: string;
  source: string;
  count: number;
}

export interface BridgeMcpBucket {
  total: number;
  byServer: Map<string, BridgeMcpEntry>;
  byWorkspace: Map<
    string,
    { workspaceKey: string; count: number; byServer: Map<string, number> }
  >;
  seenKeys?: Set<string>;
}

export interface BridgeEventsState {
  toolExecuted: BridgeToolBucket;
  toolRequested: BridgeToolBucket;
  toolUnavailable: BridgeToolBucket & { byReason: Record<string, number> };
  skillExposed: BridgeSkillBucket;
  skillUsed: BridgeSkillBucket & { seenKeys: Set<string> };
  mcpExposed: BridgeMcpBucket & { seenKeys: Set<string> };
}

/**
 * The router's live correlation with the agents it serves.
 *
 * Everything here is observed by the router itself, from the requests it
 * routes and the reports its bridges send back. The historical aggregation
 * the router used to build from an OTLP receiver is gone: OpenLIT is the
 * system of record for history, and the router keeps only what it must answer
 * a live control question from.
 */
/**
 * The schema of the persisted live correlation.
 *
 * It is deliberately not the receiver's version. The historical aggregation
 * the router used to build from an OTLP receiver is gone -- OpenLIT is the
 * system of record for history -- so a snapshot an older router wrote
 * describes a shape this one does not have and must not be read as one.
 */
export const TELEMETRY_CORRELATION_SCHEMA_VERSION = 7;

export interface CorrelationState {
  mcpServers: Map<string, McpServerEntry>;
  dimensions: {
    bridge: ContextDimensions;
  };
  skills: {
    used: SkillUsedEntry;
  };
  bridgeEvents: BridgeEventsState;
}

export interface CorrelationContext {
  workspace: string;
  role: string;
  model: string;
  agent: string;
  /** Exact router identity for bounded active-session correlation only. */
  activeAgent?: string | null;
  agentKind: string;
  timestamp: string;
  timestampSource: "source" | "ingestion";
}

export interface CorrelationTrackerOptions {
  healthTtlMs?: number;
  usageTracker?: UsageTracker;
  getConversationThread?: (
    conversationId: string
  ) => RequestContext | null | undefined;
  getBridgeRequestContext?: (
    requestId: string
  ) => RequestContext | null | undefined;
  onSchedulePersist?: () => void;
}

// Wire-level OTel attribute shapes (JSON-shaped OTLP records).
interface RequestContext {
  workspace?: unknown;
  role?: unknown;
  model?: unknown;
  requestedModel?: unknown;
  childId?: unknown;
  agentId?: unknown;
  activitySubject?: unknown;
  agent?: unknown;
  agentKind?: unknown;
  agentRole?: unknown;
  projectKey?: string;
  workspaceKey?: string;
  cwdBasename?: string;
  agentName?: unknown;
  threadId?: string;
  threadSource?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

export interface BridgeObservationEventInput {
  type?: string;
  tool?: unknown;
  server?: unknown;
  status?: unknown;
  callId?: unknown;
  reason?: unknown;
  source?: unknown;
  pluginId?: unknown;
  skill?: unknown;
  eventId?: unknown;
  event_id?: unknown;
  turnId?: unknown;
  turn_id?: unknown;
  call_id?: unknown;
  /** How long the call took, when the bridge measured it. */
  durationMs?: unknown;
}

export interface BridgeObservationContextInput {
  workspace?: unknown;
  [key: string]: unknown;
}

export interface ResolveCorrelationContextOptions {
  context?: RequestContext | null | undefined;
  requestId?: string | null | undefined;
  timestamp?: string | null | undefined;
  conversationId?: string | null | undefined;
}

interface CorrelationSnapshot {
  schemaVersion: typeof TELEMETRY_CORRELATION_SCHEMA_VERSION;
  dimensions: Record<string, ContextDimensions>;
  mcpServers: McpServerEntry[];
  skills: { used: SkillUsedStatusView };
  bridgeEvents: BridgeEventsStatusView;
}

interface CorrelationRestoreInput {
  schemaVersion: typeof TELEMETRY_CORRELATION_SCHEMA_VERSION;
  dimensions?: unknown;
  mcpServers?: unknown;
  skills?: unknown;
  bridgeEvents?: unknown;
}

interface McpServerStatusView extends McpServerEntry {
  health: string;
  averageDurationMs: number;
}

interface McpSummaryView {
  observed: number;
  ready: number;
  error: number;
  stale: number;
  byRole: Record<string, DimensionSummaryBucket>;
  byWorkspace: Record<string, DimensionSummaryBucket>;
  byModel: Record<string, DimensionSummaryBucket>;
  byAgent: Record<string, DimensionSummaryBucket>;
}

interface SkillUsedSkillBucketStatusView {
  skill: string;
  total: number;
  byRole: Record<string, number>;
  byWorkspace: Record<string, number>;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  lastSeenAt: string | null;
}

interface SkillUsedStatusView {
  total: number;
  lastSeenAt: string | null;
  byRole: Record<string, number>;
  byWorkspace: Record<string, number>;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  bySkill: SkillUsedSkillBucketStatusView[];
}

interface BridgeToolRowStatusView {
  tool: string;
  server: string;
  callId?: string | null;
  count: number;
  byStatus: Record<string, number>;
}

interface BridgeWorkspaceRowStatusView {
  workspaceKey: string;
  count: number;
  byTool: BridgeToolRowStatusView[];
  bySkill: Array<{ skill: string; count: number }>;
  byStatus: Record<string, number>;
}

interface BridgeToolBucketStatusView {
  total: number;
  byTool: BridgeToolRowStatusView[];
  byWorkspace: BridgeWorkspaceRowStatusView[];
  byReason: Record<string, number>;
}

interface BridgeSkillEntryStatusView {
  skill: string;
  source: string;
  pluginId: string;
  count: number;
}

interface BridgeSkillBucketStatusView {
  total: number;
  bySkill: BridgeSkillEntryStatusView[];
  byWorkspace: Array<{
    workspaceKey: string;
    count: number;
    bySkill: Array<{ skill: string; count: number }>;
  }>;
}

interface BridgeMcpEntryStatusView {
  server: string;
  source: string;
  count: number;
}

interface BridgeMcpBucketStatusView {
  total: number;
  byServer: BridgeMcpEntryStatusView[];
  byWorkspace: Array<{
    workspaceKey: string;
    count: number;
    byServer: Array<{ server: string; count: number }>;
  }>;
}

interface BridgeEventsStatusView {
  toolExecuted: BridgeToolBucketStatusView;
  toolRequested: BridgeToolBucketStatusView;
  toolUnavailable: BridgeToolBucketStatusView;
  skillExposed: BridgeSkillBucketStatusView;
  skillUsed: BridgeSkillBucketStatusView;
  mcpExposed: BridgeMcpBucketStatusView;
}

/**
 * The router's live correlation, as the router's status publishes it.
 *
 * Every field is something the router observed itself. The historical
 * aggregation the router used to build from an OTLP receiver is not here:
 * OpenLIT is the system of record for history, and a status that carried a
 * second, stale copy of it was a second answer to a question that has one.
 */
export function timestampNotOlder(
  next: string | null | undefined,
  previous: string | null | undefined
): boolean {
  if (!next || !previous) return true;
  const nextMs = Date.parse(next);
  const previousMs = Date.parse(previous);
  return (
    !Number.isFinite(nextMs) ||
    !Number.isFinite(previousMs) ||
    nextMs >= previousMs
  );
}
export interface CorrelationStatus {
  mcpSummary: McpSummaryView;
  mcpServers: McpServerStatusView[];
  dimensions: Record<string, ContextDimensions>;
  skills: { used: SkillUsedStatusView };
  bridgeEvents: BridgeEventsStatusView;
}

export function formatContextDimensions(
  dimensions: Record<string, ContextDimensions> | null | undefined
): Record<string, ContextDimensions> {
  return Object.fromEntries(
    Object.entries(dimensions ?? {}).map(([family, value]) => [
      family,
      {
        byRole: { ...value?.byRole },
        byWorkspace: { ...value?.byWorkspace },
        byModel: { ...value?.byModel },
        byAgent: { ...value?.byAgent }
      }
    ])
  );
}

export function formatMcpDimensionBuckets(
  dimensions: Record<string, McpServerDimensionBucket> | null | undefined,
  now: number,
  healthTtlMs: number = MCP_OBSERVATION_TTL_MS
): Record<string, McpServerDimensionBucket> {
  return Object.fromEntries(
    Object.entries(dimensions ?? {}).map(([key, bucket]) => {
      const lastSeenMs = bucket.lastSeenAt
        ? Date.parse(bucket.lastSeenAt)
        : Number.NaN;
      const health =
        Number.isFinite(lastSeenMs) && now - lastSeenMs <= healthTtlMs
          ? bucket.lastStatus
          : "stale";
      return [
        key,
        {
          ...bucket,
          observed: 1,
          ready: health === "ready" ? 1 : 0,
          error: health === "error" ? 1 : 0,
          stale: health === "stale" ? 1 : 0,
          health
        }
      ];
    })
  );
}

export function formatBridgeEvents(
  events: BridgeEventsState
): BridgeEventsStatusView {
  const formatBucket = (bucket: BridgeToolBucket) => ({
    total: bucket.total,
    byReason: {},
    byTool: Array.from(bucket.byTool.values(), (entry) => ({
      ...entry,
      byStatus: { ...entry.byStatus }
    })).sort((a, b) =>
      STRING_COLLATOR.compare(`${a.tool}/${a.server}`, `${b.tool}/${b.server}`)
    ),
    byWorkspace: Array.from(
      bucket.byWorkspace.entries(),
      ([workspaceKey, row]) => ({
        workspaceKey,
        count: row.count,
        byTool: Array.from(row.byTool.values(), (entry) => ({
          ...entry,
          byStatus: { ...entry.byStatus }
        })).sort((a, b) => STRING_COLLATOR.compare(a.tool, b.tool)),
        bySkill: row.bySkill
          ? Array.from(row.bySkill.entries(), ([skill, count]) => ({
              skill,
              count
            })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill))
          : [],
        byStatus: { ...row.byStatus }
      })
    ).sort((a, b) => STRING_COLLATOR.compare(a.workspaceKey, b.workspaceKey))
  });
  return {
    toolExecuted: formatBucket(events.toolExecuted),
    toolRequested: formatBucket(events.toolRequested),
    toolUnavailable: {
      ...formatBucket(events.toolUnavailable),
      byReason: { ...events.toolUnavailable.byReason }
    },
    skillExposed: {
      total: events.skillExposed.total,
      bySkill: Array.from(events.skillExposed.bySkill.values(), (entry) => ({
        ...entry
      })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill)),
      byWorkspace: Array.from(
        events.skillExposed.byWorkspace.entries(),
        ([workspaceKey, row]) => ({
          workspaceKey,
          count: row.count,
          bySkill: Array.from(row.bySkill.entries(), ([skill, count]) => ({
            skill,
            count
          }))
        })
      ).sort((a, b) => STRING_COLLATOR.compare(a.workspaceKey, b.workspaceKey))
    },
    skillUsed: {
      total: events.skillUsed.total,
      bySkill: Array.from(events.skillUsed.bySkill.values(), (entry) => ({
        ...entry
      })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill)),
      byWorkspace: Array.from(
        events.skillUsed.byWorkspace.entries(),
        ([workspaceKey, row]) => ({
          workspaceKey,
          count: row.count,
          bySkill: Array.from(row.bySkill.entries(), ([skill, count]) => ({
            skill,
            count
          }))
        })
      ).sort((a, b) => STRING_COLLATOR.compare(a.workspaceKey, b.workspaceKey))
    },
    mcpExposed: {
      total: events.mcpExposed.total,
      byServer: Array.from(events.mcpExposed.byServer.values(), (entry) => ({
        ...entry
      })).sort((a, b) => STRING_COLLATOR.compare(a.server, b.server)),
      byWorkspace: Array.from(
        events.mcpExposed.byWorkspace.entries(),
        ([workspaceKey, row]) => ({
          workspaceKey,
          count: row.count,
          byServer: Array.from(row.byServer.entries(), ([server, count]) => ({
            server,
            count
          }))
        })
      ).sort((a, b) => STRING_COLLATOR.compare(a.workspaceKey, b.workspaceKey))
    }
  };
}

export function createEmptyCorrelation(): CorrelationState {
  return {
    mcpServers: new Map(),
    dimensions: {
      bridge: {
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {}
      }
    },
    skills: {
      used: {
        total: 0,
        bySkill: new Map(),
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {},
        lastSeenAt: null
      }
    },
    bridgeEvents: {
      toolExecuted: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolRequested: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolUnavailable: {
        total: 0,
        byTool: new Map(),
        byWorkspace: new Map(),
        byReason: {}
      },
      skillExposed: { total: 0, bySkill: new Map(), byWorkspace: new Map() },
      skillUsed: {
        total: 0,
        bySkill: new Map(),
        byWorkspace: new Map(),
        seenKeys: new Set()
      },
      mcpExposed: {
        total: 0,
        byServer: new Map(),
        byWorkspace: new Map(),
        seenKeys: new Set()
      }
    }
  };
}

function firstString(values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type CorrelationRecord = Record<string, unknown>;

function isCorrelationRecord(value: unknown): value is CorrelationRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCorrelationRestoreInput(
  value: unknown
): value is CorrelationRestoreInput {
  return (
    isCorrelationRecord(value) &&
    value.schemaVersion === TELEMETRY_CORRELATION_SCHEMA_VERSION
  );
}

// Reusable collators used by hot sort paths. Hoisted so the same instance
// can be shared across calls instead of constructing a new one each time.
const STRING_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "variant",
  usage: "sort"
});

function restoreNumberFields(
  target: object,
  source: CorrelationRecord | null | undefined,
  fields: readonly string[]
): void {
  if (!source) return;
  for (const field of fields) {
    const value = source[field];
    if (isFiniteNonnegative(value)) Object.assign(target, { [field]: value });
  }
}

interface DimensionSummaryBucket {
  observed: number;
  ready: number;
  error: number;
  stale: number;
  lastSeenAt: string | null;
}

function bucketHealth(
  bucket: { lastSeenAt: string | null; lastStatus: string },
  now: number,
  healthTtlMs: number
): string {
  const lastSeenMs = bucket.lastSeenAt
    ? Date.parse(bucket.lastSeenAt)
    : Number.NaN;
  const fresh = Number.isFinite(lastSeenMs) && now - lastSeenMs <= healthTtlMs;
  return fresh ? bucket.lastStatus : "stale";
}

function mergeBucketSummary(
  target: DimensionSummaryBucket,
  health: string,
  bucket: { lastSeenAt: string | null }
): void {
  target.observed += 1;
  if (health === "ready") target.ready += 1;
  else if (health === "error") target.error += 1;
  else if (health === "stale") target.stale += 1;
  if (
    !target.lastSeenAt ||
    (bucket.lastSeenAt &&
      Date.parse(bucket.lastSeenAt) > Date.parse(target.lastSeenAt))
  ) {
    target.lastSeenAt = bucket.lastSeenAt;
  }
}

function emptyDimensionSummary(): DimensionSummaryBucket {
  return {
    observed: 0,
    ready: 0,
    error: 0,
    stale: 0,
    lastSeenAt: null
  };
}

function summarizeMcpDimension(
  mcpServers: McpServerEntry[],
  now: number,
  healthTtlMs: number
): (
  dimension: "byRole" | "byWorkspace" | "byModel" | "byAgent"
) => Record<string, DimensionSummaryBucket> {
  return (dimension) => {
    const summary: Record<string, DimensionSummaryBucket> = {};
    for (const server of mcpServers) {
      for (const [key, bucket] of Object.entries(server[dimension] ?? {})) {
        const health = bucketHealth(bucket, now, healthTtlMs);
        const target = summary[key] ?? emptyDimensionSummary();
        mergeBucketSummary(target, health, bucket);
        summary[key] = target;
      }
    }
    return summary;
  };
}

export class CorrelationTracker {
  healthTtlMs: number;
  usageTracker: UsageTracker;
  getConversationThread?:
    ((conversationId: string) => RequestContext | null | undefined) | undefined;
  getBridgeRequestContext?:
    ((requestId: string) => RequestContext | null | undefined) | undefined;
  onSchedulePersist?: (() => void) | undefined;

  readonly telemetry: CorrelationState;

  constructor(options: CorrelationTrackerOptions = {}) {
    this.healthTtlMs = options.healthTtlMs ?? MCP_OBSERVATION_TTL_MS;
    this.usageTracker = options.usageTracker ?? getDefaultUsageTracker();
    this.getConversationThread = options.getConversationThread;
    this.getBridgeRequestContext = options.getBridgeRequestContext;
    this.onSchedulePersist = options.onSchedulePersist;

    this.telemetry = createEmptyCorrelation();
  }

  configure(options: Partial<CorrelationTrackerOptions>): this {
    if (options.healthTtlMs !== undefined)
      this.healthTtlMs = options.healthTtlMs;
    if (options.usageTracker !== undefined)
      this.usageTracker = options.usageTracker;
    if (options.getConversationThread !== undefined)
      this.getConversationThread = options.getConversationThread;
    if (options.getBridgeRequestContext !== undefined)
      this.getBridgeRequestContext = options.getBridgeRequestContext;
    if (options.onSchedulePersist !== undefined)
      this.onSchedulePersist = options.onSchedulePersist;
    return this;
  }

  mcpServer(name: string): McpServerEntry {
    const cleanName = safeMetricLabel(name, "unknown");
    if (!this.telemetry.mcpServers.has(cleanName)) {
      this.telemetry.mcpServers.set(cleanName, {
        name: cleanName,
        lastSeenAt: null,
        failures: 0,
        durationMs: 0,
        durationCount: 0,
        lastStatus: "unknown",
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {}
      });
    }
    return this.telemetry.mcpServers.get(cleanName)!;
  }

  private resolveWorkspaceDimension(
    attributes: AttributeMap,
    resourceAttributes: AttributeMap,
    reqContext: RequestContext | null,
    thread: RequestContext | null
  ): string | null {
    const dpWs = extractWorkspaceIdWithAmbiguity(attributes);
    if (!dpWs.ambiguous && dpWs.id) {
      const safeId = safeWorkspaceId(dpWs.id);
      return (
        this.usageTracker.workspaceIdRegistry.get(safeId) ??
        safePrivacyWorkspace(dpWs.id)
      );
    }
    const directWs = firstString([
      attributes?.workspace,
      attributes?.workspace_key,
      attributes?.workspaceKey,
      attributes?.project_key,
      attributes?.projectKey
    ]);
    if (directWs) return safePrivacyWorkspace(directWs);
    if (reqContext?.workspace)
      return safePrivacyWorkspace(reqContext.workspace);
    if (thread) {
      const key =
        (thread as RequestContext).projectKey ??
        (thread as RequestContext).workspaceKey ??
        (thread as RequestContext).cwdBasename;
      if (typeof key === "string" && key.trim()) {
        return safePrivacyWorkspace(key);
      }
    }
    const resWs = extractWorkspaceIdWithAmbiguity(resourceAttributes);
    if (!resWs.ambiguous && resWs.id) {
      const safeId = safeWorkspaceId(resWs.id);
      return (
        this.usageTracker.workspaceIdRegistry.get(safeId) ??
        safePrivacyWorkspace(resWs.id)
      );
    }
    if (
      typeof resourceAttributes?.workspace === "string" &&
      resourceAttributes.workspace.trim()
    ) {
      return safePrivacyWorkspace(resourceAttributes.workspace);
    }
    return null;
  }

  private resolveRoleDimension(
    attributes: AttributeMap,
    resourceAttributes: AttributeMap,
    reqContext: RequestContext | null,
    thread: RequestContext | null
  ): string | null {
    const direct = firstString([
      attributes?.role,
      attributes?.agent_role,
      attributes?.["agent.role"]
    ]);
    if (direct) return safeMetricLabel(direct);
    if (reqContext?.role) return safeMetricLabel(reqContext.role);
    const threadRole =
      (thread as RequestContext | null)?.agentRole ??
      (thread as RequestContext | null)?.role;
    if (threadRole) {
      return safeMetricLabel(threadRole);
    }
    const resource = firstString([
      resourceAttributes?.role,
      resourceAttributes?.agent_role,
      resourceAttributes?.["agent.role"]
    ]);
    if (resource) return safeMetricLabel(resource);
    return null;
  }

  private resolveModelDimension(
    attributes: AttributeMap,
    resourceAttributes: AttributeMap,
    reqContext: RequestContext | null,
    thread: RequestContext | null
  ): string | null {
    const direct = firstString([
      attributes?.model,
      attributes?.requested_model,
      attributes?.["requested.model"],
      attributes?.model_slug,
      attributes?.["model.slug"]
    ]);
    if (direct) return safeMetricLabel(direct);
    if (reqContext?.model ?? reqContext?.requestedModel) {
      return safeMetricLabel(reqContext.model ?? reqContext.requestedModel);
    }
    const threadModel = (thread as RequestContext | null)?.model;
    if (threadModel) return safeMetricLabel(threadModel);
    const resource = firstString([
      resourceAttributes?.model,
      resourceAttributes?.requested_model,
      resourceAttributes?.model_slug
    ]);
    if (resource) return safeMetricLabel(resource);
    return null;
  }

  private resolveAgentDimension(
    attributes: AttributeMap,
    resourceAttributes: AttributeMap,
    reqContext: RequestContext | null,
    thread: RequestContext | null,
    conversationId: string | null
  ): string | null {
    const direct = firstString([
      attributes?.agent_id,
      attributes?.["agent.id"],
      attributes?.agentId,
      attributes?.child_id,
      attributes?.childId,
      attributes?.agent_name,
      attributes?.["agent.name"],
      attributes?.agentName
    ]);
    if (direct) return safeAgentIdentity(direct);
    if (reqContext?.childId ?? reqContext?.agentId ?? reqContext?.agent) {
      return safeAgentIdentity(
        reqContext.childId ?? reqContext.agentId ?? reqContext.agent
      );
    }
    const threadAgent =
      (thread as RequestContext | null)?.agentId ??
      (thread as RequestContext | null)?.agent_id ??
      (thread as RequestContext | null)?.threadId;
    if (threadAgent) {
      return safeAgentIdentity(threadAgent);
    }
    if (conversationId) return safeAgentIdentity(conversationId);
    const resource = firstString([
      resourceAttributes?.agent_id,
      resourceAttributes?.["agent.id"],
      resourceAttributes?.agentId,
      resourceAttributes?.agent_name
    ]);
    if (resource) return safeAgentIdentity(resource);
    return null;
  }

  private resolveAgentKindDimension(
    attributes: AttributeMap,
    resourceAttributes: AttributeMap,
    reqContext: RequestContext | null,
    thread: RequestContext | null
  ): string | null {
    const direct = firstString([
      attributes?.agent_kind,
      attributes?.agentKind,
      attributes?.["agent.kind"]
    ]);
    if (direct) return safeMetricLabel(direct);
    if (reqContext?.agentKind) return safeMetricLabel(reqContext.agentKind);
    const sessionSource = firstString([
      attributes?.session_source,
      resourceAttributes?.session_source,
      (thread as RequestContext | null)?.threadSource,
      (thread as RequestContext | null)?.source
    ]);
    if (sessionSource) {
      return sessionSource.trim().startsWith("subagent_thread_spawn_")
        ? "subagent"
        : "root";
    }
    const threadAgentRole = (thread as RequestContext | null)?.agentRole;
    if (threadAgentRole) {
      return threadAgentRole === "orchestrator" ? "root" : "subagent";
    }
    return null;
  }

  private resolveTelemetryTimestamp(
    attributes: AttributeMap,
    options: ResolveCorrelationContextOptions
  ): { timestamp: string; timestampSource: "source" | "ingestion" } {
    if (options?.timestamp && typeof options.timestamp === "string") {
      return { timestamp: options.timestamp, timestampSource: "source" };
    }
    if (attributes?.["event.timestamp"]) {
      return {
        timestamp: String(attributes["event.timestamp"]),
        timestampSource: "source"
      };
    }
    if (attributes?.timestamp) {
      return {
        timestamp: String(attributes.timestamp),
        timestampSource: "source"
      };
    }
    return {
      timestamp: new Date().toISOString(),
      timestampSource: "ingestion"
    };
  }

  /**
   * The conversation a report belongs to.
   *
   * The router correlates its own live threads by this id, so it reads the
   * attribute names the bridges and the router write it under.
   */
  telemetryConversationId(
    attributes: AttributeMap = {},
    resourceAttributes: AttributeMap = {},
    options: { conversationId?: unknown } = {}
  ): string | null {
    const convId =
      attributes?.["conversation.id"] ??
      attributes?.conversation_id ??
      attributes?.conversationId ??
      resourceAttributes?.["conversation.id"] ??
      resourceAttributes?.conversation_id ??
      resourceAttributes?.conversationId ??
      options?.conversationId;
    return typeof convId === "string" && convId.trim() ? convId.trim() : null;
  }

  resolveCorrelationContext(
    attributes: AttributeMap = {},
    resourceAttributes: AttributeMap = {},
    options: ResolveCorrelationContextOptions = {}
  ): CorrelationContext {
    const reqContext = this.resolveRequestContext(attributes, options);
    const conversationId = this.telemetryConversationId(
      attributes,
      resourceAttributes,
      options
    );
    const thread = conversationId
      ? (this.getConversationThread?.(conversationId) ?? null)
      : null;
    const workspace =
      this.resolveWorkspaceDimension(
        attributes,
        resourceAttributes,
        reqContext,
        thread
      ) || UNATTRIBUTED_DIMENSION;
    const role =
      this.resolveRoleDimension(
        attributes,
        resourceAttributes,
        reqContext,
        thread
      ) || UNATTRIBUTED_DIMENSION;
    const model =
      this.resolveModelDimension(
        attributes,
        resourceAttributes,
        reqContext,
        thread
      ) || UNATTRIBUTED_DIMENSION;
    const agent =
      this.resolveAgentDimension(
        attributes,
        resourceAttributes,
        reqContext,
        thread,
        conversationId
      ) || UNATTRIBUTED_DIMENSION;
    const activeAgent = reqContext?.activitySubject
      ? safeAgentIdentity(reqContext.activitySubject)
      : agent === UNATTRIBUTED_DIMENSION
        ? null
        : agent;
    const agentKind =
      this.resolveAgentKindDimension(
        attributes,
        resourceAttributes,
        reqContext,
        thread
      ) || UNATTRIBUTED_DIMENSION;
    const { timestamp, timestampSource } = this.resolveTelemetryTimestamp(
      attributes,
      options
    );
    return {
      workspace: workspace as string,
      role: role as string,
      model: model as string,
      agent: agent as string,
      activeAgent,
      agentKind: agentKind as string,
      timestamp: timestamp as string,
      timestampSource
    };
  }

  private resolveRequestContext(
    attributes: AttributeMap,
    options: ResolveCorrelationContextOptions
  ): RequestContext | null {
    if (options?.context) return options.context;
    if (options?.requestId) {
      return this.getBridgeRequestContext?.(options.requestId) ?? null;
    }
    const bridgeRequestId = attributes?.requestId || attributes?.request_id;
    if (typeof bridgeRequestId === "string" && bridgeRequestId) {
      return this.getBridgeRequestContext?.(bridgeRequestId) ?? null;
    }
    return null;
  }

  noteContextDimension(
    family: keyof CorrelationState["dimensions"],
    context: CorrelationContext,
    count: number = 1,
    dimensions: Set<string> | null = null
  ): void {
    if (!Number.isFinite(count) || count <= 0) return;
    const target =
      this.telemetry.dimensions[family] ??
      (this.telemetry.dimensions[family] = emptyContextDimensions());
    const timestamp = context.timestamp ?? new Date().toISOString();
    for (const [dimension, field] of CONTEXT_DIMENSION_FIELDS) {
      if (dimensions && !dimensions.has(dimension)) continue;
      this.mergeContextDimensionBucket(
        target[dimension],
        dimension,
        context[field],
        context,
        count,
        timestamp
      );
    }
  }

  noteMcpDimension(
    server: McpServerEntry,
    dimension: "byRole" | "byWorkspace" | "byModel" | "byAgent",
    key: string,
    context: CorrelationContext,
    status?: string
  ): void {
    this.mergeMcpDimensionBucket(
      server[dimension],
      dimension,
      key,
      context,
      status
    );
  }

  mergeMcpDimensionBucket(
    buckets: Record<string, McpServerDimensionBucket>,
    dimension: string,
    key: string,
    context: CorrelationContext,
    status?: string
  ): void {
    const existing = buckets[key];
    const bucket = existing ?? {
      observed: 1,
      lastSeenAt: null,
      lastStatus: "observed"
    };
    bucket.observed = 1;
    const nextStatus = status ?? bucket.lastStatus;
    const replace =
      !existing ||
      !bucket.lastSeenAt ||
      (nextStatus === "configured"
        ? bucket.lastStatus === "configured"
        : bucket.lastStatus === "configured" ||
          timestampNotOlder(context.timestamp, bucket.lastSeenAt));
    if (replace) {
      bucket.lastSeenAt = context.timestamp;
      bucket.lastStatus = nextStatus;
    }
    if (dimension === "byAgent") bucket.agentKind = context.agentKind;
    buckets[key] = bucket;
  }
  mergeContextDimensionBucket(
    buckets: Record<string, ContextDimensionBucket>,
    dimension: string,
    key: string,
    context: CorrelationContext,
    count: number,
    timestamp: string
  ): void {
    const bucket = buckets[key] ?? {
      count: 0,
      lastSeenAt: null,
      ...(dimension === "byAgent" ? { agentKind: context.agentKind } : {})
    };
    bucket.count += count;
    if (
      !bucket.lastSeenAt ||
      Date.parse(timestamp) >= Date.parse(bucket.lastSeenAt)
    )
      bucket.lastSeenAt = timestamp;
    if (dimension === "byAgent") bucket.agentKind = context.agentKind;
    buckets[key] = bucket;
  }

  skillUsedBucket(name: string): SkillUsedSkillBucket {
    const used = this.telemetry.skills.used;
    if (!used.bySkill.has(name)) {
      used.bySkill.set(name, {
        skill: name,
        total: 0,
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {},
        lastSeenAt: null
      });
    }
    return used.bySkill.get(name)!;
  }

  recordSkillUse(
    skill: string,
    context: CorrelationContext,
    count: number = 1,
    timestamp: string | null = null
  ): void {
    if (!skill || !Number.isFinite(count) || count <= 0) return;
    const cleanSkill = safeMetricLabel(skill, "unknown");
    const used = this.telemetry.skills.used;
    const at = timestamp ?? context.timestamp ?? new Date().toISOString();
    used.total += count;
    used.lastSeenAt = at;
    const bucket = this.skillUsedBucket(skill);
    bucket.total += count;
    bucket.lastSeenAt = at;
    for (const [field, key] of [
      ["byRole", context.role],
      ["byWorkspace", context.workspace],
      ["byModel", context.model],
      ["byAgent", context.agent]
    ] as const) {
      used[field][key] = (used[field][key] ?? 0) + count;
      bucket[field][key] = (bucket[field][key] ?? 0) + count;
    }
    this.usageTracker.recordAgentSkillUse(
      context.activeAgent,
      context.workspace,
      cleanSkill,
      count
    );
    if (context.workspace !== UNATTRIBUTED_DIMENSION) {
      const workspace = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        context.workspace
      );
      workspace.skillUses = (workspace.skillUses ?? 0) + count;
      const wsSkill = this.usageTracker.workspaceSkillBucket(workspace, skill);
      wsSkill.uses = (wsSkill.uses ?? 0) + count;
    }
  }

  private bridgeToolObservationStatus(
    event: BridgeObservationEventInput
  ): string {
    if (event.type === "tool_unavailable") return "unavailable";
    if (event.status === "error" || event.status === "failure") return "error";
    if (event.status === "ok" || event.status === "success") return "ok";
    return "unknown";
  }

  private bridgeToolBucketFor(eventType: unknown): BridgeToolBucket {
    if (eventType === "tool_executed")
      return this.telemetry.bridgeEvents.toolExecuted;
    if (eventType === "tool_requested")
      return this.telemetry.bridgeEvents.toolRequested;
    return this.telemetry.bridgeEvents.toolUnavailable;
  }

  private incrementBridgeToolRow(
    bucket: BridgeToolBucket,
    toolBucketKey: string,
    tool: string,
    server: string | null,
    callId: string | null,
    statusKey: string
  ): void {
    const toolRow = bucket.byTool.get(toolBucketKey) ?? {
      tool,
      server: server ?? "",
      callId: callId ?? null,
      count: 0,
      byStatus: {}
    };
    toolRow.count += 1;
    if (server && !toolRow.server) toolRow.server = server;
    const statusMap = toolRow.byStatus as Record<string, number>;
    statusMap[statusKey] = (statusMap[statusKey] ?? 0) + 1;
    bucket.byTool.set(toolBucketKey, toolRow);
  }

  private incrementBridgeWorkspaceRow(
    bucket: BridgeToolBucket,
    workspaceKey: string,
    tool: string,
    server: string | null,
    statusKey: string
  ): void {
    const wsRow = bucket.byWorkspace.get(workspaceKey) ?? {
      workspaceKey,
      count: 0,
      byTool: new Map(),
      byStatus: {}
    };
    wsRow.count += 1;
    (wsRow.byStatus as Record<string, number>)[statusKey] =
      ((wsRow.byStatus as Record<string, number>)[statusKey] ?? 0) + 1;
    const wsToolRow = wsRow.byTool.get(tool) ?? {
      tool,
      server: server ?? "",
      count: 0,
      byStatus: {}
    };
    wsToolRow.count += 1;
    if (server && !wsToolRow.server) wsToolRow.server = server;
    (wsToolRow.byStatus as Record<string, number>)[statusKey] =
      ((wsToolRow.byStatus as Record<string, number>)[statusKey] ?? 0) + 1;
    wsRow.byTool.set(tool, wsToolRow);
    bucket.byWorkspace.set(workspaceKey, wsRow);
  }

  private accumulateBridgeUnavailableReason(
    bucket: BridgeToolBucket & { byReason?: Record<string, number> },
    reason: unknown
  ): void {
    const cleanReason =
      typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, 64)
        : "denied";
    bucket.byReason = bucket.byReason ?? {};
    bucket.byReason[cleanReason] = (bucket.byReason[cleanReason] ?? 0) + 1;
  }

  private accumulateWorkspaceBridgeObservation(
    workspaceKey: string,
    tool: string,
    server: string | null,
    statusKey: string
  ): void {
    const wsBucket = this.usageTracker.workspaceBucket(
      this.usageTracker.usageTelemetry.byWorkspace,
      workspaceKey
    );
    wsBucket.toolsExecuted = (wsBucket.toolsExecuted ?? 0) + 1;
    const toolBucket = wsBucket.bridgeObservations.tools.get(tool) ?? {
      tool,
      server: server ?? "",
      count: 0,
      byStatus: {}
    };
    toolBucket.count += 1;
    if (server && !toolBucket.server) toolBucket.server = server;
    toolBucket.byStatus[statusKey] = (toolBucket.byStatus[statusKey] ?? 0) + 1;
    wsBucket.bridgeObservations.tools.set(tool, toolBucket);
  }

  private incrementWorkspaceCounter(
    workspaceKey: string,
    field: "toolsRequested" | "toolsUnavailable"
  ): void {
    const wsBucket = this.usageTracker.workspaceBucket(
      this.usageTracker.usageTelemetry.byWorkspace,
      workspaceKey
    );
    wsBucket[field] = (wsBucket[field] ?? 0) + 1;
  }

  /**
   * What the router saw of one MCP server, from a bridge's report of a call
   * against it.
   *
   * A call that ran and came back is the server being reachable, so it is the
   * evidence the server's health is read from. A call that was refused before
   * it ran says nothing about the server -- the refusal was the router's --
   * so it leaves the server's own observation alone.
   */
  private noteMcpServerObservation(
    mcp: McpServerEntry,
    ctx: CorrelationContext,
    event: BridgeObservationEventInput,
    status: string
  ): void {
    if (event.type === "tool_unavailable") return;
    const observedAt = ctx.timestamp;
    if (!mcp.lastSeenAt || observedAt >= mcp.lastSeenAt)
      mcp.lastSeenAt = observedAt;
    if (event.type !== "tool_executed") return;
    const duration = Number((event as { durationMs?: unknown }).durationMs);
    if (Number.isFinite(duration) && duration >= 0) {
      mcp.durationMs += duration;
      mcp.durationCount += 1;
    }
    if (status === "ok") {
      mcp.lastStatus = "ready";
      return;
    }
    if (status === "error") {
      mcp.lastStatus = "error";
      mcp.failures += 1;
    }
  }

  private noteBridgeToolMcpObservation(
    server: string,
    ctx: CorrelationContext,
    eventType: unknown,
    event: BridgeObservationEventInput,
    status: string
  ): void {
    const mcp = this.mcpServer(server);
    this.noteMcpServerObservation(mcp, ctx, event, status);
    // The dimension buckets carry the same verdict the server carries: a call
    // that ran and came back is the evidence that the server was ready, and a
    // role that made that call saw it.
    const verdict =
      status === "ok" ? "ready" : status === "error" ? "error" : "observed";
    this.noteMcpDimension(mcp, "byRole", ctx.role, ctx, verdict);
    this.noteMcpDimension(mcp, "byWorkspace", ctx.workspace, ctx, verdict);
    this.noteMcpDimension(mcp, "byModel", ctx.model, ctx, verdict);
    this.noteMcpDimension(mcp, "byAgent", ctx.agent, ctx, verdict);
    if (
      ctx.workspace !== UNATTRIBUTED_DIMENSION &&
      eventType === "tool_executed"
    ) {
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        ctx.workspace
      );
      wsBucket.mcpCapable = true;
      wsBucket.byMcp[server] = (wsBucket.byMcp[server] ?? 0) + 1;
    }
  }

  recordBridgeToolObservation({
    event,
    context
  }: {
    event: BridgeObservationEventInput;
    context: BridgeObservationContextInput;
  }): void {
    const eventMap = event as unknown as AttributeMap;
    const tool =
      typeof event.tool === "string" && event.tool.trim()
        ? safeMetricLabel(event.tool)
        : null;
    if (!tool) return;
    const server =
      typeof event.server === "string" && event.server.trim()
        ? safeMetricLabel(event.server)
        : null;
    const workspaceKey =
      typeof context.workspace === "string" ? context.workspace : null;
    const callId =
      typeof event.callId === "string" && event.callId.trim()
        ? event.callId.trim()
        : null;
    const status = this.bridgeToolObservationStatus(event);
    const bucket = this.bridgeToolBucketFor(event.type);
    bucket.total += 1;
    const ctx = this.resolveCorrelationContext(eventMap, {}, { context });
    this.noteContextDimension("bridge", ctx);
    if (server) {
      this.noteBridgeToolMcpObservation(server, ctx, event.type, event, status);
    }
    const toolBucketKey = callId ? `${tool}::${callId}` : tool;
    this.incrementBridgeToolRow(
      bucket,
      toolBucketKey,
      tool,
      server,
      callId,
      status
    );
    if (workspaceKey) {
      this.incrementBridgeWorkspaceRow(
        bucket,
        workspaceKey,
        tool,
        server,
        status
      );
    }
    if (event.type === "tool_unavailable") {
      this.accumulateBridgeUnavailableReason(bucket, event.reason);
    }
    if (workspaceKey && event.type === "tool_executed") {
      this.accumulateWorkspaceBridgeObservation(
        workspaceKey,
        tool,
        server,
        status
      );
    }
    if (workspaceKey && event.type === "tool_requested") {
      this.incrementWorkspaceCounter(workspaceKey, "toolsRequested");
    }
    if (workspaceKey && event.type === "tool_unavailable") {
      this.incrementWorkspaceCounter(workspaceKey, "toolsUnavailable");
    }
  }

  recordMcpExposure({
    server,
    source = null,
    context,
    requestId = null
  }: {
    server: string;
    source?: string | null;
    context: BridgeObservationContextInput;
    requestId?: string | null;
  }): boolean {
    if (typeof server !== "string" || !server.trim()) return false;
    const cleanServer = safeMetricLabel(server);
    const contextMap = context as unknown as AttributeMap;
    const mcpContext = this.resolveCorrelationContext(
      {},
      {},
      { context: contextMap }
    );
    const workspaceKey =
      typeof mcpContext.workspace === "string" ? mcpContext.workspace : null;
    const store = this.telemetry.bridgeEvents.mcpExposed;
    const dedupeKey = requestId
      ? `${requestId}\0${workspaceKey ?? UNATTRIBUTED_DIMENSION}\0${cleanServer}`
      : null;
    if (dedupeKey && store.seenKeys?.has(dedupeKey)) return false;
    if (dedupeKey) store.seenKeys?.add(dedupeKey);
    const cleanSource =
      typeof source === "string" && source.trim()
        ? safeMetricLabel(source)
        : null;
    this.noteContextDimension("bridge", mcpContext);
    store.total += 1;
    const serverRow = store.byServer.get(cleanServer) ?? {
      server: cleanServer,
      source: cleanSource ?? "",
      count: 0
    };
    serverRow.count += 1;
    if (cleanSource && !serverRow.source) serverRow.source = cleanSource;
    store.byServer.set(cleanServer, serverRow);
    if (workspaceKey) {
      const wsRow = store.byWorkspace.get(workspaceKey) ?? {
        workspaceKey,
        count: 0,
        byServer: new Map()
      };
      wsRow.count += 1;
      wsRow.byServer.set(
        cleanServer,
        (wsRow.byServer.get(cleanServer) ?? 0) + 1
      );
      store.byWorkspace.set(workspaceKey, wsRow);
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        workspaceKey
      );
      wsBucket.mcpCapable = true;
      const mcpRow = this.usageTracker.workspaceMcpBucket(
        wsBucket,
        cleanServer
      );
      mcpRow.count += 1;
    }
    const mcp = this.mcpServer(cleanServer);
    if (mcp.lastStatus === "unknown") mcp.lastStatus = "configured";
    if (!mcp.lastSeenAt || mcpContext.timestamp >= mcp.lastSeenAt)
      mcp.lastSeenAt = mcpContext.timestamp;
    this.noteMcpDimension(
      mcp,
      "byRole",
      mcpContext.role,
      mcpContext,
      "configured"
    );
    this.noteMcpDimension(
      mcp,
      "byWorkspace",
      mcpContext.workspace,
      mcpContext,
      "configured"
    );
    this.noteMcpDimension(
      mcp,
      "byModel",
      mcpContext.model,
      mcpContext,
      "configured"
    );
    this.noteMcpDimension(
      mcp,
      "byAgent",
      mcpContext.agent,
      mcpContext,
      "configured"
    );
    return true;
  }

  recordBridgeMcpExposure({
    event,
    context,
    requestId = null
  }: {
    event: BridgeObservationEventInput;
    context: BridgeObservationContextInput;
    requestId?: string | null;
  }): boolean {
    return this.recordMcpExposure({
      server: typeof event?.server === "string" ? event.server : "",
      source: typeof event?.source === "string" ? event.source : null,
      context,
      requestId
    });
  }

  recordBridgeSkillExposure({
    event,
    context
  }: {
    event: BridgeObservationEventInput;
    context: BridgeObservationContextInput;
  }): boolean {
    const eventMap = event as unknown as AttributeMap;
    const skill =
      typeof event.skill === "string" && event.skill.trim()
        ? safeMetricLabel(event.skill)
        : null;
    if (!skill) return false;
    const source =
      typeof event.source === "string" && event.source.trim()
        ? safeMetricLabel(event.source)
        : null;
    const pluginId =
      typeof event.pluginId === "string" && event.pluginId.trim()
        ? safeMetricLabel(event.pluginId)
        : null;
    const workspaceKey =
      typeof context.workspace === "string" ? context.workspace : null;
    const bucket = this.telemetry.bridgeEvents.skillExposed;
    const skillContext = this.resolveCorrelationContext(
      eventMap,
      {},
      { context }
    );
    this.noteContextDimension("bridge", skillContext);
    bucket.total += 1;
    const skillKey = `${skill}::${source ?? ""}::${pluginId ?? ""}`;
    const skillRow = bucket.bySkill.get(skillKey) ?? {
      skill,
      source: source ?? "",
      pluginId: pluginId ?? "",
      count: 0,
      byWorkspace: new Map()
    };
    skillRow.count += 1;
    bucket.bySkill.set(skillKey, skillRow);
    if (workspaceKey) {
      const wsRow = bucket.byWorkspace.get(workspaceKey) ?? {
        workspaceKey,
        count: 0,
        bySkill: new Map()
      };
      wsRow.count += 1;
      wsRow.bySkill.set(skill, (wsRow.bySkill.get(skill) ?? 0) + 1);
      bucket.byWorkspace.set(workspaceKey, wsRow);
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        workspaceKey
      );
      wsBucket.skillsCapable = true;
      wsBucket.skillsExposed = (wsBucket.skillsExposed ?? 0) + 1;
      wsBucket.bridgeObservations.skills.set(
        skill,
        (wsBucket.bridgeObservations.skills.get(skill) ?? 0) + 1
      );
    }
    recordSkillObservation({
      event: "exposed",
      skill,
      source,
      role: typeof context.role === "string" ? context.role : null,
      workspace: workspaceKey ? { key: workspaceKey } : null
    });
    return true;
  }

  recordBridgeSkillUsed({
    event,
    context
  }: {
    event: BridgeObservationEventInput;
    context: BridgeObservationContextInput;
  }): boolean {
    const eventMap = event as unknown as AttributeMap;
    const skill =
      typeof event.skill === "string" && event.skill.trim()
        ? safeMetricLabel(event.skill)
        : null;
    if (!skill) return false;
    const source =
      typeof event.source === "string" && event.source.trim()
        ? safeMetricLabel(event.source)
        : "";
    const pluginId =
      typeof event.pluginId === "string" && event.pluginId.trim()
        ? safeMetricLabel(event.pluginId)
        : "";
    const workspace =
      typeof context.workspace === "string" && context.workspace.trim()
        ? context.workspace
        : UNATTRIBUTED_DIMENSION;
    const eventId =
      event.eventId ??
      event.event_id ??
      event.turnId ??
      event.turn_id ??
      event.callId ??
      event.call_id ??
      "";
    const key = [eventId || "no-id", skill, source, pluginId, workspace].join(
      "\0"
    );
    const store = this.telemetry.bridgeEvents.skillUsed;
    if (store.seenKeys.has(key)) return false;
    store.seenKeys.add(key);
    while (store.seenKeys.size > 5000) {
      const first = store.seenKeys.values().next().value;
      if (first !== undefined) store.seenKeys.delete(first);
    }
    const ctx = this.resolveCorrelationContext(eventMap, {}, { context });
    const timestamp = ctx.timestamp;
    if (ctx.workspace !== UNATTRIBUTED_DIMENSION) {
      this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        ctx.workspace
      ).skillsCapable = true;
    }
    store.total += 1;
    const skillRow = store.bySkill.get(skill) ?? {
      skill,
      source,
      pluginId,
      count: 0
    };
    skillRow.count += 1;
    store.bySkill.set(skill, skillRow);
    const wsRow = store.byWorkspace.get(ctx.workspace) ?? {
      workspaceKey: ctx.workspace,
      count: 0,
      bySkill: new Map()
    };
    wsRow.count += 1;
    wsRow.bySkill.set(skill, (wsRow.bySkill.get(skill) ?? 0) + 1);
    store.byWorkspace.set(ctx.workspace, wsRow);
    this.recordSkillUse(skill, ctx, 1, timestamp);
    recordSkillObservation({
      event: "used",
      skill,
      source,
      role: typeof context.role === "string" ? context.role : null,
      workspace:
        ctx.workspace === UNATTRIBUTED_DIMENSION ? null : { key: ctx.workspace }
    });
    return true;
  }

  resetCorrelation(): void {
    this.telemetry.mcpServers.clear();
    this.telemetry.dimensions = {
      bridge: {
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {}
      }
    };
    this.telemetry.skills.used = {
      total: 0,
      bySkill: new Map(),
      byRole: {},
      byWorkspace: {},
      byModel: {},
      byAgent: {},
      lastSeenAt: null
    };
    this.telemetry.bridgeEvents = {
      toolExecuted: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolRequested: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolUnavailable: {
        total: 0,
        byTool: new Map(),
        byWorkspace: new Map(),
        byReason: {}
      },
      skillExposed: { total: 0, bySkill: new Map(), byWorkspace: new Map() },
      skillUsed: {
        total: 0,
        bySkill: new Map(),
        byWorkspace: new Map(),
        seenKeys: new Set()
      },
      mcpExposed: {
        total: 0,
        byServer: new Map(),
        byWorkspace: new Map(),
        seenKeys: new Set()
      }
    };
  }

  correlationStatus(now: number = Date.now()): CorrelationStatus {
    const mcpServers = Array.from(
      this.telemetry.mcpServers.values(),
      (server) => {
        const lastSeenMs = server.lastSeenAt
          ? Date.parse(server.lastSeenAt)
          : Number.NaN;
        const fresh =
          Number.isFinite(lastSeenMs) && now - lastSeenMs <= this.healthTtlMs;
        return {
          ...server,
          health: fresh ? server.lastStatus : "stale",
          averageDurationMs: server.durationCount
            ? Math.round(server.durationMs / server.durationCount)
            : 0,
          byRole: formatMcpDimensionBuckets(
            server.byRole,
            now,
            this.healthTtlMs
          ),
          byWorkspace: formatMcpDimensionBuckets(
            server.byWorkspace,
            now,
            this.healthTtlMs
          ),
          byModel: formatMcpDimensionBuckets(
            server.byModel,
            now,
            this.healthTtlMs
          ),
          byAgent: formatMcpDimensionBuckets(
            server.byAgent,
            now,
            this.healthTtlMs
          )
        };
      }
    ).sort((a, b) => STRING_COLLATOR.compare(a.name, b.name));
    const summarizeDimension = summarizeMcpDimension(
      mcpServers,
      now,
      this.healthTtlMs
    );
    const mcpSummary: McpSummaryView = mcpServers.reduce(
      (summary, server) => {
        summary.observed += 1;
        if (server.health === "ready") summary.ready += 1;
        if (server.health === "error") summary.error += 1;
        if (server.health === "stale") summary.stale += 1;
        return summary;
      },
      {
        observed: 0,
        ready: 0,
        error: 0,
        stale: 0,
        byRole: summarizeDimension("byRole"),
        byWorkspace: summarizeDimension("byWorkspace"),
        byModel: summarizeDimension("byModel"),
        byAgent: summarizeDimension("byAgent")
      }
    );
    const used = this.telemetry.skills.used;
    return {
      mcpSummary,
      mcpServers,
      dimensions: formatContextDimensions(this.telemetry.dimensions),
      skills: {
        used: {
          total: used.total,
          lastSeenAt: used.lastSeenAt,
          byRole: { ...used.byRole },
          byWorkspace: { ...used.byWorkspace },
          byModel: { ...used.byModel },
          byAgent: { ...used.byAgent },
          bySkill: Array.from(used.bySkill.values(), (entry) => ({
            ...entry,
            byRole: { ...entry.byRole },
            byWorkspace: { ...entry.byWorkspace },
            byModel: { ...entry.byModel },
            byAgent: { ...entry.byAgent }
          })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill))
        }
      },
      bridgeEvents: formatBridgeEvents(this.telemetry.bridgeEvents)
    };
  }

  correlationSnapshot(): CorrelationSnapshot {
    const telemetry = this.correlationStatus();
    return {
      schemaVersion: TELEMETRY_CORRELATION_SCHEMA_VERSION,
      dimensions: telemetry.dimensions,
      mcpServers: Array.from(this.telemetry.mcpServers.values(), (server) => ({
        ...server,
        byRole: { ...server.byRole },
        byWorkspace: { ...server.byWorkspace },
        byModel: { ...server.byModel },
        byAgent: { ...server.byAgent }
      })),
      skills: telemetry.skills,
      bridgeEvents: telemetry.bridgeEvents
    };
  }

  private restoreCorrelationCounters(snapshot: CorrelationRestoreInput): void {
    const bridgeEvents = isCorrelationRecord(snapshot.bridgeEvents)
      ? snapshot.bridgeEvents
      : undefined;
    if (!bridgeEvents) return;
    const families: Array<keyof BridgeEventsState> = [
      "toolExecuted",
      "toolRequested",
      "toolUnavailable",
      "skillExposed",
      "skillUsed",
      "mcpExposed"
    ];
    for (const family of families) {
      const source = bridgeEvents[family];
      if (isCorrelationRecord(source)) this.restoreBridgeFamily(family, source);
    }
  }

  private restoreSkillUsedEntries(source: CorrelationRecord): void {
    const destination = this.telemetry.bridgeEvents.skillUsed;
    const entries = Array.isArray(source.bySkill) ? source.bySkill : [];
    for (const entry of entries) {
      if (
        !isCorrelationRecord(entry) ||
        typeof entry.skill !== "string" ||
        typeof entry.count !== "number"
      ) {
        continue;
      }
      destination.bySkill.set(safeMetricLabel(entry.skill), {
        skill: safeMetricLabel(entry.skill),
        source: safeMetricLabel(entry.source, ""),
        pluginId: safeMetricLabel(entry.pluginId, ""),
        count: entry.count
      });
    }
  }

  private buildSkillWorkspaceMap(row: CorrelationRecord): Map<string, number> {
    const entries = Array.isArray(row.bySkill) ? row.bySkill : [];
    return new Map(
      entries.flatMap((entry) =>
        isCorrelationRecord(entry) &&
        typeof entry.skill === "string" &&
        typeof entry.count === "number"
          ? [[safeMetricLabel(entry.skill), entry.count] as const]
          : []
      )
    );
  }

  private restoreSkillUsedWorkspaces(source: CorrelationRecord): void {
    const destination = this.telemetry.bridgeEvents.skillUsed;
    const rows = Array.isArray(source.byWorkspace) ? source.byWorkspace : [];
    for (const row of rows) {
      if (
        !isCorrelationRecord(row) ||
        typeof row.workspaceKey !== "string" ||
        typeof row.count !== "number"
      ) {
        continue;
      }
      destination.byWorkspace.set(safeMetricLabel(row.workspaceKey), {
        workspaceKey: safeMetricLabel(row.workspaceKey),
        count: row.count,
        bySkill: this.buildSkillWorkspaceMap(row)
      });
    }
  }

  private restoreMcpExposedServers(source: CorrelationRecord): void {
    const destination = this.telemetry.bridgeEvents.mcpExposed;
    const entries = Array.isArray(source.byServer) ? source.byServer : [];
    for (const entry of entries) {
      if (
        !isCorrelationRecord(entry) ||
        typeof entry.server !== "string" ||
        typeof entry.count !== "number"
      ) {
        continue;
      }
      destination.byServer.set(safeMetricLabel(entry.server), {
        server: safeMetricLabel(entry.server),
        source: safeMetricLabel(entry.source, ""),
        count: entry.count
      });
    }
  }

  private buildMcpWorkspaceMap(row: CorrelationRecord): Map<string, number> {
    const entries = Array.isArray(row.byServer) ? row.byServer : [];
    return new Map(
      entries.flatMap((entry) =>
        isCorrelationRecord(entry) &&
        typeof entry.server === "string" &&
        typeof entry.count === "number"
          ? [[safeMetricLabel(entry.server), entry.count] as const]
          : []
      )
    );
  }

  private restoreMcpExposedWorkspaces(source: CorrelationRecord): void {
    const destination = this.telemetry.bridgeEvents.mcpExposed;
    const rows = Array.isArray(source.byWorkspace) ? source.byWorkspace : [];
    for (const row of rows) {
      if (
        !isCorrelationRecord(row) ||
        typeof row.workspaceKey !== "string" ||
        typeof row.count !== "number"
      ) {
        continue;
      }
      destination.byWorkspace.set(safeMetricLabel(row.workspaceKey), {
        workspaceKey: safeMetricLabel(row.workspaceKey),
        count: row.count,
        byServer: this.buildMcpWorkspaceMap(row)
      });
    }
  }

  private restoreBridgeFamily(
    family: keyof BridgeEventsState,
    source: CorrelationRecord
  ): void {
    if (typeof source.total === "number" && source.total >= 0) {
      this.telemetry.bridgeEvents[family].total = source.total;
    }
    if (family === "skillUsed") {
      this.restoreSkillUsedEntries(source);
      this.restoreSkillUsedWorkspaces(source);
    } else if (family === "mcpExposed") {
      this.restoreMcpExposedServers(source);
      this.restoreMcpExposedWorkspaces(source);
    }
    if (
      family === "toolExecuted" ||
      family === "toolRequested" ||
      family === "toolUnavailable"
    ) {
      const destination = this.telemetry.bridgeEvents[family];
      const byReason = source.byReason;
      if (isCorrelationRecord(byReason)) {
        destination.byReason = destination.byReason ?? {};
        for (const [key, count] of Object.entries(byReason)) {
          if (typeof count === "number" && count >= 0) {
            destination.byReason[safeMetricLabel(key)] = count;
          }
        }
      }
    }
  }

  private restoreCorrelationDimensionBucket(
    dimension: "byRole" | "byWorkspace" | "byModel" | "byAgent",
    bucket: CorrelationRecord
  ): ContextDimensionBucket {
    return {
      count: isFiniteNonnegative(bucket.count) ? bucket.count : 0,
      lastSeenAt:
        typeof bucket.lastSeenAt === "string" ? bucket.lastSeenAt : null,
      ...(dimension === "byAgent"
        ? {
            agentKind: safeMetricLabel(bucket.agentKind, UNATTRIBUTED_DIMENSION)
          }
        : {})
    };
  }

  private restoreCorrelationDimensionsFamily(
    family: keyof CorrelationState["dimensions"],
    value: CorrelationRecord
  ): void {
    for (const dimension of [
      "byRole",
      "byWorkspace",
      "byModel",
      "byAgent"
    ] as const) {
      const dimMap = value[dimension];
      if (!isCorrelationRecord(dimMap)) continue;
      for (const [key, bucket] of Object.entries(dimMap)) {
        if (!isCorrelationRecord(bucket)) continue;
        const bucketEntry = bucket;
        if (!isFiniteNonnegative(bucketEntry.count)) continue;
        this.telemetry.dimensions[family][dimension][safeMetricLabel(key)] =
          this.restoreCorrelationDimensionBucket(dimension, bucketEntry);
      }
    }
  }

  private restoreCorrelationDimensions(
    snapshot: CorrelationRestoreInput
  ): void {
    const dimensions = snapshot.dimensions;
    if (!isCorrelationRecord(dimensions)) return;
    const bridge = dimensions.bridge;
    if (isCorrelationRecord(bridge))
      this.restoreCorrelationDimensionsFamily("bridge", bridge);
  }

  private restoreCorrelationMcpServers(
    snapshot: CorrelationRestoreInput
  ): void {
    const servers = Array.isArray(snapshot.mcpServers)
      ? snapshot.mcpServers
      : [];
    for (const server of servers) {
      if (
        !isCorrelationRecord(server) ||
        typeof server.name !== "string" ||
        !server.name
      ) {
        continue;
      }
      this.restoreSingleMcpServer(server);
    }
  }

  private restoreMcpServerDimensionBucket(v: {
    observed?: unknown;
    lastSeenAt?: unknown;
    lastStatus?: unknown;
    agentKind?: unknown;
  }): McpServerDimensionBucket {
    return {
      observed: 1,
      lastSeenAt: typeof v.lastSeenAt === "string" ? v.lastSeenAt : null,
      lastStatus: safeMetricLabel(v.lastStatus, "observed")
    };
  }

  private restoreMcpServerDimension(
    restored: McpServerEntry,
    server: Record<string, unknown>,
    dim: "byRole" | "byWorkspace" | "byModel" | "byAgent"
  ): void {
    const dimSource = server[dim];
    if (!isCorrelationRecord(dimSource)) return;
    for (const [k, v] of Object.entries(dimSource)) {
      if (isFiniteNonnegative(v)) {
        restored[dim][safeMetricLabel(k)] = {
          observed: 1,
          lastSeenAt: null,
          lastStatus: "observed"
        };
      } else if (isCorrelationRecord(v)) {
        const dimBucket = v;
        if (!isFiniteNonnegative(dimBucket.observed)) continue;
        const restoredBucket = this.restoreMcpServerDimensionBucket(dimBucket);
        if (dim === "byAgent") {
          restoredBucket.agentKind = safeMetricLabel(
            dimBucket.agentKind,
            UNATTRIBUTED_DIMENSION
          );
        }
        restored[dim][safeMetricLabel(k)] = restoredBucket;
      }
    }
  }

  private restoreSingleMcpServer(server: CorrelationRecord): void {
    const restored: McpServerEntry = {
      name: safeMetricLabel(server.name),
      lastSeenAt:
        typeof server.lastSeenAt === "string" ? server.lastSeenAt : null,
      failures: 0,
      durationMs: 0,
      durationCount: 0,
      lastStatus: safeMetricLabel(server.lastStatus),
      byRole: {},
      byWorkspace: {},
      byModel: {},
      byAgent: {}
    };
    restoreNumberFields(restored, server, [
      "failures",
      "durationMs",
      "durationCount"
    ]);
    for (const dim of [
      "byRole",
      "byWorkspace",
      "byModel",
      "byAgent"
    ] as const) {
      this.restoreMcpServerDimension(restored, server, dim);
    }
    this.telemetry.mcpServers.set(restored.name, restored);
  }

  private restoreSkillUsedState(source: CorrelationRecord): void {
    restoreNumberFields(this.telemetry.skills.used, source, ["total"]);
    if (typeof source.lastSeenAt === "string") {
      this.telemetry.skills.used.lastSeenAt = source.lastSeenAt;
    }
    for (const dimension of [
      "byRole",
      "byWorkspace",
      "byModel",
      "byAgent"
    ] as const) {
      const map = source[dimension];
      if (!isCorrelationRecord(map)) continue;
      for (const [k, v] of Object.entries(map)) {
        if (isFiniteNonnegative(v)) {
          this.telemetry.skills.used[dimension][safeMetricLabel(k)] = v;
        }
      }
    }
    if (Array.isArray(source.bySkill)) {
      for (const entry of source.bySkill) {
        if (!isCorrelationRecord(entry) || typeof entry.skill !== "string")
          continue;
        this.restoreSkillUsedBucketEntry(entry);
      }
    }
  }

  private restoreSkillUsedBucketEntry(entry: CorrelationRecord): void {
    const bucket = this.skillUsedBucket(safeMetricLabel(entry.skill));
    restoreNumberFields(bucket, entry, ["total"]);
    if (typeof entry.lastSeenAt === "string") {
      bucket.lastSeenAt = entry.lastSeenAt;
    }
    for (const dimension of [
      "byRole",
      "byWorkspace",
      "byModel",
      "byAgent"
    ] as const) {
      const map = entry[dimension];
      if (!isCorrelationRecord(map)) continue;
      for (const [k, v] of Object.entries(map)) {
        if (isFiniteNonnegative(v)) {
          bucket[dimension][safeMetricLabel(k)] = v;
        }
      }
    }
  }

  private restoreCorrelationSkills(snapshot: CorrelationRestoreInput): void {
    if (!isCorrelationRecord(snapshot.skills)) return;
    const skills = snapshot.skills;
    if (isCorrelationRecord(skills.used)) {
      this.restoreSkillUsedState(skills.used);
    }
  }

  restoreCorrelation(snapshot: unknown): void {
    if (!isCorrelationRestoreInput(snapshot)) return;
    this.restoreCorrelationDimensions(snapshot);
    this.restoreCorrelationMcpServers(snapshot);
    this.restoreCorrelationSkills(snapshot);
    this.restoreCorrelationCounters(snapshot);
  }
}

let defaultCorrelationTracker = new CorrelationTracker();

export function getDefaultCorrelationTracker(): CorrelationTracker {
  return defaultCorrelationTracker;
}

export function setDefaultCorrelationTracker(
  tracker: CorrelationTracker
): void {
  defaultCorrelationTracker = tracker;
}

export function mcpServer(name: string): McpServerEntry {
  return defaultCorrelationTracker.mcpServer(name);
}

export function telemetryConversationId(
  attributes: AttributeMap = {},
  resourceAttributes: AttributeMap = {},
  options: { conversationId?: unknown } = {}
): string | null {
  return defaultCorrelationTracker.telemetryConversationId(
    attributes,
    resourceAttributes,
    options
  );
}

export function resolveCorrelationContext(
  attributes: AttributeMap = {},
  resourceAttributes: AttributeMap = {},
  options: ResolveCorrelationContextOptions = {}
): CorrelationContext {
  return defaultCorrelationTracker.resolveCorrelationContext(
    attributes,
    resourceAttributes,
    options
  );
}

export function recordBridgeToolObservation({
  event,
  context
}: {
  event: BridgeObservationEventInput;
  context: BridgeObservationContextInput;
}): void {
  defaultCorrelationTracker.recordBridgeToolObservation({ event, context });
}

export function recordMcpExposure({
  server,
  source = null,
  context,
  requestId = null
}: {
  server: string;
  source?: string | null;
  context: BridgeObservationContextInput;
  requestId?: string | null;
}): boolean {
  return defaultCorrelationTracker.recordMcpExposure({
    server,
    source,
    context,
    requestId
  });
}

export function recordBridgeMcpExposure({
  event,
  context,
  requestId = null
}: {
  event: BridgeObservationEventInput;
  context: BridgeObservationContextInput;
  requestId?: string | null;
}): boolean {
  return defaultCorrelationTracker.recordBridgeMcpExposure({
    event,
    context,
    requestId
  });
}

export function recordBridgeSkillExposure({
  event,
  context
}: {
  event: BridgeObservationEventInput;
  context: BridgeObservationContextInput;
}): boolean {
  return defaultCorrelationTracker.recordBridgeSkillExposure({
    event,
    context
  });
}

export function recordBridgeSkillUsed({
  event,
  context
}: {
  event: BridgeObservationEventInput;
  context: BridgeObservationContextInput;
}): boolean {
  return defaultCorrelationTracker.recordBridgeSkillUsed({ event, context });
}

export function resetCorrelation(): void {
  defaultCorrelationTracker.resetCorrelation();
}

export function correlationStatus(now: number = Date.now()): CorrelationStatus {
  return defaultCorrelationTracker.correlationStatus(now);
}

/**
 * The Runtime's health verdict for an MCP server, in the Control API's
 * vocabulary.
 *
 * The telemetry records a free-form status; the contract publishes the five
 * words the Runtime actually uses. Anything else is reported as `stale`: an
 * unrecognized verdict is not a readiness claim.
 */
function mcpHealthVerdict(value: string): ControlApiMcpRuntimeHealth {
  if (
    value === "ready" ||
    value === "error" ||
    value === "configured" ||
    value === "observed"
  ) {
    return value;
  }
  return "stale";
}

/** Sorts the observed role and tool names the same way every read does. */
const MCP_OBSERVATION_COLLATOR = new Intl.Collator();

/**
 * What the Runtime has observed of each MCP server.
 *
 * The telemetry already tracks every MCP server the Runtime has seen: the
 * initialization and tool-discovery attempts, the failures, the call
 * durations, the roles the server was used from, and the tools it was observed
 * calling. This projects that per-server view into the shape the Control API
 * publishes, so the page can show the Runtime's own evidence next to the
 * canonical declaration instead of a placeholder.
 *
 * A server the Runtime has never observed has no evidence at all, which is a
 * distinct state from a server it observed and counted zero: the first means
 * "nothing has been seen", the second would mean "something was seen and it
 * did nothing". The projection therefore carries only the servers the Runtime
 * actually saw.
 */
export function mcpServerObservations(): ControlApiMcpRuntimeServer[] {
  const telemetry = correlationStatus();
  // The observed tool calls are the ones the bridges reported executing. The
  // router records one row per call, so the rows are folded back into one
  // entry per tool before they are published.
  const toolsByServer = new Map<
    string,
    Map<string, { count: number; errors: number }>
  >();
  for (const row of telemetry.bridgeEvents.toolExecuted.byTool) {
    if (!row.server) continue;
    const byTool = toolsByServer.get(row.server) ?? new Map();
    const tool = byTool.get(row.tool) ?? { count: 0, errors: 0 };
    tool.count += row.count;
    tool.errors += row.byStatus.error ?? 0;
    byTool.set(row.tool, tool);
    toolsByServer.set(row.server, byTool);
  }
  return telemetry.mcpServers.map((server) => {
    const byTool = toolsByServer.get(server.name) ?? new Map();
    const tools = Array.from(byTool.entries(), ([name, counts]) => ({
      name,
      count: counts.count,
      errors: counts.errors
    }));
    return {
      name: server.name,
      health: mcpHealthVerdict(server.health),
      lastSeenAt: server.lastSeenAt,
      lastStatus: server.lastStatus,
      // The router does not observe the MCP client's own initialization, so
      // it publishes no count for it: a count of zero would claim the server
      // was never brought up, which is a claim about a read that never
      // happens.
      initAttempts: null,
      toolDiscoveryAttempts: null,
      failures: server.failures,
      toolCalls: tools.reduce((total, tool) => total + tool.count, 0),
      averageDurationMs: server.averageDurationMs,
      roles: Object.entries(server.byRole)
        .map(([role, bucket]) => ({
          role,
          health: mcpHealthVerdict(bucket.health ?? "stale"),
          lastSeenAt: bucket.lastSeenAt,
          lastStatus: bucket.lastStatus
        }))
        .sort((left, right) =>
          MCP_OBSERVATION_COLLATOR.compare(left.role, right.role)
        ),
      tools: tools.sort((left, right) =>
        MCP_OBSERVATION_COLLATOR.compare(left.name, right.name)
      )
    };
  });
}

export function correlationSnapshot(): CorrelationSnapshot {
  return defaultCorrelationTracker.correlationSnapshot();
}

export function restoreCorrelation(snapshot: unknown): void {
  defaultCorrelationTracker.restoreCorrelation(snapshot);
}
