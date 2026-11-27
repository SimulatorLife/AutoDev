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
The attributes a bridge report carries.

The values are untrusted -- they arrive over the wire from a bridge -- so
every read of one goes through a guard rather than a cast.
*/
export type AttributeMap = Record<string, unknown>;

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
The dimensions a context is counted under, and the context field each one
takes its value from.
*/
const CONTEXT_DIMENSION_FIELDS = [
  ["byRole", "role"],
  ["byWorkspace", "workspace"],
  ["byModel", "model"],
  ["byAgent", "agent"]
] as const;

function emptyContextDimensions(): ContextDimensions {
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

export interface BridgeEventsState {
  skillExposed: BridgeSkillBucket;
  skillUsed: BridgeSkillBucket & { seenKeys: Set<string> };
}

/**
The router's live correlation with the agents it serves.

Everything here is observed by the router itself, from the requests it
routes and the reports its bridges send back. The historical aggregation
the router used to build from an OTLP receiver is gone: OpenLIT is the
system of record for history, and the router keeps only what it must answer
a live control question from.
*/
/**
The schema of the persisted live correlation.

It is deliberately not the receiver's version. The historical aggregation
the router used to build from an OTLP receiver is gone -- OpenLIT is the
system of record for history -- so a snapshot an older router wrote
describes a shape this one does not have and must not be read as one.
*/
export const TELEMETRY_CORRELATION_SCHEMA_VERSION = 7;

export interface CorrelationState {
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
  /**
  Exact router identity for bounded active-session correlation only.
  */
  activeAgent?: string | null;
  agentKind: string;
  timestamp: string;
  timestampSource: "source" | "ingestion";
}

export interface CorrelationTrackerOptions {
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
  /**
  How a skill operation failed: `unavailable` for a read that never
  happened (denied or cancelled) and `error` for one that ran and failed.
  */
  outcome?: unknown;
  /**
  How long the call took, when the bridge measured it.
  */
  durationMs?: unknown;
}

export interface BridgeObservationContextInput {
  workspace?: unknown;
  [key: string]: unknown;
}

/**
The outcome of a failed skill operation, or null when the report does not
name one.

The vocabulary is closed: `unavailable` is a read that never happened and
`error` is one that ran and failed. A report naming anything else is not a
failure the router can name, so it is refused rather than rounded to one of
them.
*/
function skillFailureOutcome(value: unknown): "unavailable" | "error" | null {
  if (typeof value !== "string") return null;
  const outcome = value.trim();
  if (outcome === "unavailable" || outcome === "error") return outcome;
  return null;
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
  skills: { used: SkillUsedStatusView };
  bridgeEvents: BridgeEventsStatusView;
}

interface CorrelationRestoreInput {
  schemaVersion: typeof TELEMETRY_CORRELATION_SCHEMA_VERSION;
  dimensions?: unknown;
  skills?: unknown;
  bridgeEvents?: unknown;
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

interface BridgeEventsStatusView {
  skillExposed: BridgeSkillBucketStatusView;
  skillUsed: BridgeSkillBucketStatusView;
}

/**
The router's live correlation, as the router's status publishes it.

Every field is something the router observed itself. The historical
aggregation the router used to build from an OTLP receiver is not here:
OpenLIT is the system of record for history, and a status that carried a
second, stale copy of it was a second answer to a question that has one.
*/
export interface CorrelationStatus {
  dimensions: Record<string, ContextDimensions>;
  skills: { used: SkillUsedStatusView };
  bridgeEvents: BridgeEventsStatusView;
}

function formatContextDimensions(
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

function formatBridgeEvents(events: BridgeEventsState): BridgeEventsStatusView {
  return {
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
    }
  };
}

function createEmptyCorrelation(): CorrelationState {
  return {
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
      skillExposed: { total: 0, bySkill: new Map(), byWorkspace: new Map() },
      skillUsed: {
        total: 0,
        bySkill: new Map(),
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

export class CorrelationTracker {
  usageTracker: UsageTracker;
  getConversationThread?:
    ((conversationId: string) => RequestContext | null | undefined) | undefined;
  getBridgeRequestContext?:
    ((requestId: string) => RequestContext | null | undefined) | undefined;
  onSchedulePersist?: (() => void) | undefined;

  readonly telemetry: CorrelationState;

  /**
  The dedupe keys of the skill failures this tracker has already counted.
  
  A bridge reports a step's outcome as it settles, so the same call is
  reported once; a retry is a different call and is a different key.
  */
  private readonly skillFailureKeys = new Set<string>();

  constructor(options: CorrelationTrackerOptions = {}) {
    this.usageTracker = options.usageTracker ?? getDefaultUsageTracker();
    this.getConversationThread = options.getConversationThread;
    this.getBridgeRequestContext = options.getBridgeRequestContext;
    this.onSchedulePersist = options.onSchedulePersist;

    this.telemetry = createEmptyCorrelation();
  }

  configure(options: Partial<CorrelationTrackerOptions>): this {
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

  /**
  The workspace an observation belongs to, and the record of how it was
  decided.
  
  The router attributes every observation it is given, so the attribution
  diagnostic counts one decision per observation: an observation that
  resolved to a workspace is attributed, and one that did not is counted
  with the reason it did not.
  */
  private resolveWorkspaceDimension(
    attributes: AttributeMap,
    resourceAttributes: AttributeMap,
    requestContext: RequestContext | null,
    thread: RequestContext | null
  ): string | null {
    const dpWs = extractWorkspaceIdWithAmbiguity(attributes);
    if (!dpWs.ambiguous && dpWs.id) {
      const safeId = safeWorkspaceId(dpWs.id);
      const registered = this.usageTracker.workspaceIdRegistry.get(safeId);
      if (registered) return this.attributedWorkspace(registered);
      // The id names a workspace the router was never told about. The
      // observation lands in a privacy-hashed bucket so it is not mistaken
      // for a named workspace, and the diagnostic records that the router
      // could not attribute it.
      this.usageTracker.recordAttributionDiagnostic({
        attributed: false,
        reason: "unknown_workspace_id",
        unknownWorkspaceId: dpWs.id
      });
      return safePrivacyWorkspace(dpWs.id);
    }
    const directWs = firstString([
      attributes?.workspace,
      attributes?.workspace_key,
      attributes?.workspaceKey,
      attributes?.project_key,
      attributes?.projectKey
    ]);
    if (directWs)
      return this.attributedWorkspace(safePrivacyWorkspace(directWs));
    if (requestContext?.workspace)
      return this.attributedWorkspace(
        safePrivacyWorkspace(requestContext.workspace)
      );
    if (thread) {
      const key =
        (thread as RequestContext).projectKey ??
        (thread as RequestContext).workspaceKey ??
        (thread as RequestContext).cwdBasename;
      if (typeof key === "string" && key.trim()) {
        return this.attributedWorkspace(safePrivacyWorkspace(key));
      }
    }
    const resWs = extractWorkspaceIdWithAmbiguity(resourceAttributes);
    if (!resWs.ambiguous && resWs.id) {
      const safeId = safeWorkspaceId(resWs.id);
      const registered = this.usageTracker.workspaceIdRegistry.get(safeId);
      if (registered) return this.attributedWorkspace(registered);
      this.usageTracker.recordAttributionDiagnostic({
        attributed: false,
        reason: "unknown_workspace_id",
        unknownWorkspaceId: resWs.id
      });
      return safePrivacyWorkspace(resWs.id);
    }
    if (
      typeof resourceAttributes?.workspace === "string" &&
      resourceAttributes.workspace.trim()
    ) {
      return this.attributedWorkspace(
        safePrivacyWorkspace(resourceAttributes.workspace)
      );
    }
    this.usageTracker.recordAttributionDiagnostic({
      attributed: false,
      reason: "missing_workspace"
    });
    return null;
  }

  private attributedWorkspace(key: string): string {
    this.usageTracker.recordAttributionDiagnostic({ attributed: true });
    return key;
  }

  private resolveRoleDimension(
    attributes: AttributeMap,
    resourceAttributes: AttributeMap,
    requestContext: RequestContext | null,
    thread: RequestContext | null
  ): string | null {
    const direct = firstString([
      attributes?.role,
      attributes?.agent_role,
      attributes?.["agent.role"]
    ]);
    if (direct) return safeMetricLabel(direct);
    if (requestContext?.role) return safeMetricLabel(requestContext.role);
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
    requestContext: RequestContext | null,
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
    if (requestContext?.model ?? requestContext?.requestedModel) {
      return safeMetricLabel(
        requestContext.model ?? requestContext.requestedModel
      );
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
    requestContext: RequestContext | null,
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
    if (
      requestContext?.childId ??
      requestContext?.agentId ??
      requestContext?.agent
    ) {
      return safeAgentIdentity(
        requestContext.childId ?? requestContext.agentId ?? requestContext.agent
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
    requestContext: RequestContext | null,
    thread: RequestContext | null
  ): string | null {
    const direct = firstString([
      attributes?.agent_kind,
      attributes?.agentKind,
      attributes?.["agent.kind"]
    ]);
    if (direct) return safeMetricLabel(direct);
    if (requestContext?.agentKind)
      return safeMetricLabel(requestContext.agentKind);
    const sessionSource = firstString([
      attributes?.session_source,
      resourceAttributes?.session_source,
      (thread as RequestContext | null)?.threadSource,
      (thread as RequestContext | null)?.source
    ]);
    if (sessionSource) {
      return sessionSource.trimStart().startsWith("subagent_thread_spawn_")
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
  The conversation a report belongs to.
  
  The router correlates its own live threads by this id, so it reads the
  attribute names the bridges and the router write it under.
  */
  private telemetryConversationId(
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
    const requestContext = this.resolveRequestContext(attributes, options);
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
        requestContext,
        thread
      ) || UNATTRIBUTED_DIMENSION;
    const role =
      this.resolveRoleDimension(
        attributes,
        resourceAttributes,
        requestContext,
        thread
      ) || UNATTRIBUTED_DIMENSION;
    const model =
      this.resolveModelDimension(
        attributes,
        resourceAttributes,
        requestContext,
        thread
      ) || UNATTRIBUTED_DIMENSION;
    const agent =
      this.resolveAgentDimension(
        attributes,
        resourceAttributes,
        requestContext,
        thread,
        conversationId
      ) || UNATTRIBUTED_DIMENSION;
    const activeAgent = requestContext?.activitySubject
      ? safeAgentIdentity(requestContext.activitySubject)
      : agent === UNATTRIBUTED_DIMENSION
        ? null
        : agent;
    const agentKind =
      this.resolveAgentKindDimension(
        attributes,
        resourceAttributes,
        requestContext,
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
      ...(dimension === "byAgent" && { agentKind: context.agentKind })
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
    const context_ = this.resolveCorrelationContext(eventMap, {}, { context });
    const timestamp = context_.timestamp;
    if (context_.workspace !== UNATTRIBUTED_DIMENSION) {
      this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        context_.workspace
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
    const wsRow = store.byWorkspace.get(context_.workspace) ?? {
      workspaceKey: context_.workspace,
      count: 0,
      bySkill: new Map()
    };
    wsRow.count += 1;
    wsRow.bySkill.set(skill, (wsRow.bySkill.get(skill) ?? 0) + 1);
    store.byWorkspace.set(context_.workspace, wsRow);
    this.recordSkillUse(skill, context_, 1, timestamp);
    recordSkillObservation({
      event: "used",
      skill,
      source,
      role: typeof context.role === "string" ? context.role : null,
      workspace:
        context_.workspace === UNATTRIBUTED_DIMENSION
          ? null
          : { key: context_.workspace }
    });
    return true;
  }

  /**
  Record a skill operation that did not succeed.
  
  The bridge saw the read itself: it was refused or cancelled, or it ran and
  failed. Both are facts about the skill, and neither is a use -- which is
  why they are counted beside the uses instead of becoming one.
  
  Without this the skill's row says it was exposed and never used, which is
  a claim about a use that did not happen rather than about the failure that
  did, and the Console renders a broken skill as an unused one.
  */
  recordBridgeSkillFailed({
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
    const outcome = skillFailureOutcome(event.outcome);
    if (!outcome) return false;
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
    const key = [
      eventId || "no-id",
      skill,
      source,
      pluginId,
      workspace,
      outcome
    ].join("\0");
    if (this.skillFailureKeys.has(key)) return false;
    this.skillFailureKeys.add(key);
    while (this.skillFailureKeys.size > 5000) {
      const first = this.skillFailureKeys.values().next().value;
      if (first !== undefined) this.skillFailureKeys.delete(first);
    }
    const context_ = this.resolveCorrelationContext(eventMap, {}, { context });
    if (context_.workspace !== UNATTRIBUTED_DIMENSION) {
      const workspaceBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        context_.workspace
      );
      workspaceBucket.skillsCapable = true;
      const wsSkill = this.usageTracker.workspaceSkillBucket(
        workspaceBucket,
        skill
      );
      wsSkill.errors = (wsSkill.errors ?? 0) + 1;
    }
    recordSkillObservation({
      event: outcome,
      skill,
      source,
      role: typeof context.role === "string" ? context.role : null,
      workspace:
        context_.workspace === UNATTRIBUTED_DIMENSION
          ? null
          : { key: context_.workspace }
    });
    return true;
  }

  resetCorrelation(): void {
    this.skillFailureKeys.clear();
    const empty = createEmptyCorrelation();
    this.telemetry.dimensions = empty.dimensions;
    this.telemetry.skills.used = empty.skills.used;
    this.telemetry.bridgeEvents = empty.bridgeEvents;
    // The correlation is what records the attribution decisions and the
    // workspace facts below, so resetting it resets the ones it wrote: a
    // diagnostic that still counted observations the correlation no longer
    // holds would describe a history that is gone.
    this.usageTracker.resetAttributionDiagnostics();
    this.usageTracker.clearWorkspaceCapabilities();
  }

  correlationStatus(): CorrelationStatus {
    const used = this.telemetry.skills.used;
    return {
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
      "skillExposed",
      "skillUsed"
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
      ...(dimension === "byAgent" && {
        agentKind: safeMetricLabel(bucket.agentKind, UNATTRIBUTED_DIMENSION)
      })
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

export function recordBridgeSkillFailed({
  event,
  context
}: {
  event: BridgeObservationEventInput;
  context: BridgeObservationContextInput;
}): boolean {
  return defaultCorrelationTracker.recordBridgeSkillFailed({
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

export function correlationStatus(): CorrelationStatus {
  return defaultCorrelationTracker.correlationStatus();
}

export function correlationSnapshot(): CorrelationSnapshot {
  return defaultCorrelationTracker.correlationSnapshot();
}

export function restoreCorrelation(snapshot: unknown): void {
  defaultCorrelationTracker.restoreCorrelation(snapshot);
}
