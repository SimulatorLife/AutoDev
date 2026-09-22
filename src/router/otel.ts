import { createHash } from "node:crypto";

import { safeMetricLabel } from "./subagents.ts";
import {
  extractWorkspaceIdWithAmbiguity,
  getDefaultUsageTracker,
  MAX_UNKNOWN_WORKSPACE_IDS,
  readNamedAttribute,
  safeAgentIdentity,
  safePrivacyWorkspace,
  safeWorkspaceId,
  toolKey,
  toolNameAttribute,
  toolServerAttribute,
  UNATTRIBUTED_DIMENSION,
  type UsageTracker
} from "./usage.ts";

export const OTEL_HEALTH_TTL_MS_DEFAULT = 120_000;
export const OTEL_HEALTH_TTL_MS = Number.parseInt(
  process.env.CODEX_ROUTER_OTEL_HEALTH_TTL_MS ?? "120000"
);
export const OTEL_RECORD_IDENTITY_LIMIT = 10_000;
export const PENDING_MCP_MODEL_CONVERSATION_LIMIT = 1000;
export const PENDING_MCP_MODEL_OBSERVATION_LIMIT = 200;
export const OTEL_PERSISTENCE_SCHEMA_VERSION = 6;

export const MCP_DISCOVERY_SPAN_NAMES = new Set([
  "list_tools_for_client_uncached",
  "list_tools_with_connector_ids"
]);

export const REMOVED_SHADOW_SELECTION_METRICS = new Set([
  "codex.skills.shadow_selection",
  "codex.skills.shadow_selection.invocation",
  "codex.skills.shadow_selection.catalog_entries",
  "codex.skills.shadow_selection.selected_entries",
  "codex.skills.shadow_selection.query_terms",
  "codex.skills.shadow_selection.reduction_bps",
  "codex.skills.shadow_selection.duration_ms"
]);

export const SKILL_TURN_HISTOGRAMS: Record<string, keyof SkillTurnHistograms> =
  {
    "codex.skill.turn.duration_seconds": "durationSeconds"
  };

export const THREAD_SKILLS_HISTOGRAMS: Record<
  string,
  keyof SkillThreadHistograms
> = {
  "codex.thread.skills.enabled_total": "enabled",
  "codex.thread.skills.kept_total": "kept",
  "codex.thread.skills.truncated": "truncated",
  "codex.thread.skills.description_truncated_chars": "descriptionTruncatedChars"
};

export const AUTODEV_ATTRIBUTES_FLAG = "AUTODEV_OTEL_ATTRIBUTES";
export const AUTODEV_ATTRIBUTES_VERSION = "v1";
export const AUTODEV_ATTRIBUTE_VALUE_MAX_LENGTH = 64;
export const AUTODEV_RESOURCE_ROLE_ALIASES = [
  "role",
  "agent_role",
  "agent.role"
];
export const AUTODEV_RESOURCE_WORKSPACE_ALIASES = [
  "workspace_id",
  "workspace.id",
  "workspaceId",
  "workspace"
];
export const AUTODEV_RESOURCE_PROVIDER_ALIASES = [
  "provider",
  "provider_id",
  "provider.id"
];
export const AUTODEV_RESOURCE_MODEL_ALIASES = [
  "model",
  "model_slug",
  "model.slug",
  "requested_model",
  "requested.model"
];
export const AUTODEV_SPAWN_MECHANISM_ALIASES = [
  "spawn_mechanism",
  "spawn.mechanism"
];
export const AUTODEV_SKILL_ALIASES = ["skill", "skill_name", "skill.name"];
export const AUTODEV_MCP_SERVER_ALIASES = [
  "server_name",
  "serverName",
  "server",
  "mcp_server"
];
export const AUTODEV_SPAWN_LOG_EVENTS = new Set([
  "codex.subagent_spawn",
  "codex.subagent_spawned"
]);

export const OTEL_DELTA_TEMPORALITY_VALUES = new Set<unknown>([
  1,
  "1",
  "AGGREGATION_TEMPORALITY_DELTA"
]);

export const CONTEXT_DIMENSION_FIELDS = [
  ["byRole", "role"],
  ["byWorkspace", "workspace"],
  ["byModel", "model"],
  ["byAgent", "agent"]
] as const;
export const MODEL_CONTEXT_DIMENSIONS = new Set(["byModel"]);
export const NON_MODEL_CONTEXT_DIMENSIONS = new Set([
  "byRole",
  "byWorkspace",
  "byAgent"
]);

export type OtelSignal = "logs" | "traces" | "metrics";

export interface OtelReceiverTelemetry {
  logs: number;
  traces: number;
  metrics: number;
  invalid: number;
  lastReceivedAt: string | null;
}

export interface SessionEntry {
  id: string;
  model: string | null;
  mcpServers: Set<string>;
  lastSeenAt: string | null;
}

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
  initAttempts: number;
  toolDiscoveryAttempts: number;
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

export interface MetricInventoryEntry {
  name: string;
  exports: number;
  dataPoints: number;
}

export interface ToolEntry {
  tool: string;
  source: string;
  server: string;
  count: number;
  byStatus: Record<string, number>;
  durationCount: number;
  durationMs: number;
  averageDurationMs?: number;
}

export interface HookEntry {
  hook: string;
  source: string;
  handlerType: string;
  count: number;
  byStatus: Record<string, number>;
  durationCount: number;
  durationMs: number;
  averageDurationMs?: number;
}

export interface SqliteEntry {
  db: string;
  status: string;
  count: number;
  average?: number;
}

export interface SqliteDurationEntry extends SqliteEntry {
  sum: number;
}

export interface SkillInjectedSkillBucket {
  skill: string;
  total: number;
  byStatus: Record<string, number>;
  byInvokeType: Record<string, number>;
  byAgentKind: Record<string, number>;
  byModel: Record<string, number>;
  byPlugin: Record<string, number>;
}

export interface SkillInjectedEntry {
  total: number;
  byStatus: Record<string, number>;
  byInvokeType: Record<string, number>;
  byAgentKind: Record<string, number>;
  byModel: Record<string, number>;
  byPlugin: Record<string, number>;
  bySkill: Map<string, SkillInjectedSkillBucket>;
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

export interface HistogramBucket {
  count: number;
  sum: number;
  average?: number;
}

export interface SkillTurnHistograms {
  durationSeconds: HistogramBucket;
}

export interface SkillThreadHistograms {
  enabled: HistogramBucket;
  kept: HistogramBucket;
  truncated: HistogramBucket;
  descriptionTruncatedChars: HistogramBucket;
}

export interface ToolResultsRow {
  tool: string;
  source: string;
  server: string;
  count: number;
  byStatus: Record<string, number>;
}

export interface ToolResultsState {
  total: number;
  executed: number;
  unattributed: number;
  byStatus: Record<string, number>;
  byTool: Map<string, ToolResultsRow>;
  executionDurationMs: HistogramBucket;
  causeResolved: number;
  causeUnresolved: number;
  seenKeys: Set<string>;
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

export interface OtelTelemetryState {
  receiver: OtelReceiverTelemetry;
  sessions: Map<string, SessionEntry>;
  mcpServers: Map<string, McpServerEntry>;
  recordIdentities: {
    logs: Set<string>;
    spans: Set<string>;
    datapoints: Set<string>;
  };
  dimensions: {
    mcp: ContextDimensions;
    tools: ContextDimensions;
    hooks: ContextDimensions;
    skills: ContextDimensions;
    bridge: ContextDimensions;
  };
  turns: {
    prompts: number;
    completed: number;
    promptLength: number;
    ttftMs: number;
    ttftCount: number;
  };
  tokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
    tool: number;
  };
  metricInventory: Map<string, MetricInventoryEntry>;
  tools: Map<string, ToolEntry>;
  hooks: Map<string, HookEntry>;
  threads: {
    started: { total: number; bySource: Record<string, number> };
    spawns: {
      total: number;
      byStatus: Record<string, number>;
      byRole: Record<string, number>;
      byModel: Record<string, number>;
    };
  };
  sqlite: {
    init: Map<string, SqliteEntry>;
    initDurationMs: Map<string, SqliteDurationEntry>;
    fallbacks: Map<string, SqliteEntry>;
  };
  skills: {
    injected: SkillInjectedEntry;
    used: SkillUsedEntry;
    turnDuration: SkillTurnHistograms;
    threads: SkillThreadHistograms;
  };
  toolResults: ToolResultsState;
  bridgeEvents: BridgeEventsState;
}

export interface TelemetryContext {
  workspace: string;
  role: string;
  model: string;
  agent: string;
  agentKind: string;
  timestamp: string;
  timestampSource: "source" | "ingestion";
}

export interface OtelTrackerOptions {
  healthTtlMs?: number;
  usageTracker?: UsageTracker;
  getConversationThread?: (conversationId: string) => RequestContext | null | undefined;
  getBridgeRequestContext?: (requestId: string) => RequestContext | null | undefined;
  onSchedulePersist?: () => void;
}

// Wire-level OTel attribute shapes (JSON-shaped OTLP records).
export interface OtelAttributeValueRaw {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtelAttributeValueRaw[] };
}

export interface OtelAttribute {
  key: string;
  value?: OtelAttributeValueRaw | undefined;
}

export type OtelAttributesInput = OtelAttribute[] | undefined | null;
export type OtelAttributeMap = Record<string, unknown>;

interface RequestContext {
  workspace?: unknown;
  role?: unknown;
  model?: unknown;
  requestedModel?: unknown;
  childId?: unknown;
  agentId?: unknown;
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

export interface OtelScope {
  name?: string;
  version?: string;
}

export interface OtelResource {
  attributes?: OtelAttributesInput;
}

export interface OtelLogRecord {
  timeUnixNano?: string | number | null;
  observedTimeUnixNano?: string | number | null;
  severityNumber?: number | string | null;
  body?: unknown;
  attributes?: OtelAttributesInput;
}

export interface OtelScopeLogs {
  scope?: OtelScope;
  logRecords?: OtelLogRecord[];
}

export interface OtelResourceLogs {
  resource?: OtelResource;
  scopeLogs?: OtelScopeLogs[];
}

export interface OtelSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string | number | null;
  endTimeUnixNano?: string | number | null;
  status?: { code?: string | number } | unknown;
  attributes?: OtelAttributesInput;
}

export interface OtelScopeSpans {
  scope?: OtelScope;
  spans?: OtelSpan[];
}

export interface OtelResourceSpans {
  resource?: OtelResource;
  scopeSpans?: OtelScopeSpans[];
}

export interface OtelSum {
  dataPoints?: OtelDataPoint[];
  aggregationTemporality?: unknown;
}

export interface OtelHistogram {
  dataPoints?: OtelDataPoint[];
  aggregationTemporality?: unknown;
}

export interface OtelGauge {
  dataPoints?: OtelDataPoint[];
}

export interface OtelExponentialHistogram {
  dataPoints?: OtelDataPoint[];
}

export interface OtelDataPoint {
  attributes?: OtelAttributesInput;
  startTimeUnixNano?: string | number | null;
  timeUnixNano?: string | number | null;
  asInt?: string | number;
  asDouble?: number;
  count?: number | string;
  sum?: number | string;
}

export interface OtelMetric {
  name?: string;
  sum?: OtelSum;
  histogram?: OtelHistogram;
  gauge?: OtelGauge;
  exponentialHistogram?: OtelExponentialHistogram;
}

export interface OtelScopeMetrics {
  scope?: OtelScope;
  metrics?: OtelMetric[];
}

export interface OtelResourceMetrics {
  resource?: OtelResource;
  scopeMetrics?: OtelScopeMetrics[];
}

export interface OtelPayload {
  resourceLogs?: OtelResourceLogs[];
  resourceSpans?: OtelResourceSpans[];
  resourceMetrics?: OtelResourceMetrics[];
}

export interface OtelMetricsSeriesEntry {
  timestamp: bigint;
  value: number;
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
}

export interface BridgeObservationContextInput {
  workspace?: unknown;
  [key: string]: unknown;
}

export interface ResolveTelemetryContextOptions {
  context?: RequestContext | null | undefined;
  requestId?: string | null | undefined;
  timestamp?: string | null | undefined;
  timeUnixNano?: string | number | null | undefined;
  conversationId?: string | null | undefined;
}

export interface OtelRestoreSnapshot {
  schemaVersion?: number;
  receiver?: Partial<OtelReceiverTelemetry>;
  turns?: Partial<OtelTelemetryState["turns"]>;
  tokens?: Partial<OtelTelemetryState["tokens"]>;
  dimensions?: Record<string, ContextDimensions>;
  mcpServers?: Array<Record<string, unknown>>;
  skills?: {
    injected?: Record<string, unknown>;
    used?: Record<string, unknown>;
    threads?: Record<string, unknown>;
  };
  metrics?: { observed?: Array<Record<string, unknown>> };
  tools?: { byTool?: Array<Record<string, unknown>> };
  hooks?: { byHook?: Array<Record<string, unknown>> };
  threads?: {
    started?: Record<string, unknown>;
    spawns?: Record<string, unknown>;
  };
  sqlite?: {
    init?: { byDbStatus?: unknown };
    fallbacks?: { byDbStatus?: unknown };
    initDurationMs?: { byDbStatus?: unknown };
  };
  toolResults?: Record<string, unknown>;
  bridgeEvents?: Record<string, unknown>;
  series?: Array<Record<string, unknown>>;
}

export function otelAttributeValue(value: OtelAttributeValueRaw | undefined): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Object.hasOwn(value, "stringValue")) {
    return value.stringValue;
  }
  if (Object.hasOwn(value, "intValue")) {
    return Number(value.intValue);
  }
  if (Object.hasOwn(value, "doubleValue")) {
    return value.doubleValue;
  }
  if (Object.hasOwn(value, "boolValue")) {
    return value.boolValue;
  }
  // Unrecognized OTel value shapes are dropped (returning the input would
  // let raw wrapper objects leak into attribute maps).
  if (value.arrayValue?.values) {
    return value.arrayValue.values.map(otelAttributeValue);
  }
  return value;
}

export function otelAttributes(attributes: OtelAttributeMap | OtelAttributesInput = []): OtelAttributeMap {
  if (!Array.isArray(attributes)) {
    return { ...(attributes as OtelAttributeMap) };
  }
  return Object.fromEntries(
    (attributes as OtelAttribute[])
      .map((item) => [item.key, otelAttributeValue(item.value)])
      .filter(([key, value]) => typeof key === "string" && value !== undefined)
  );
}

export function otelTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const nanos = BigInt(String(value));
    return new Date(Number(nanos / 1_000_000n)).toISOString();
  } catch {
    return null;
  }
}

export function otelNanoTimestamp(value: unknown): bigint {
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

export function otelDurationMs(span: OtelSpan): number {
  try {
    const start = BigInt(String(span.startTimeUnixNano));
    const end = BigInt(String(span.endTimeUnixNano));
    return Math.max(0, Number(end - start) / 1_000_000);
  } catch {
    return 0;
  }
}

export function numberAttribute(attributes: OtelAttributeMap, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(attributes?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

export function isDeltaTemporality(temporality: unknown): boolean {
  return OTEL_DELTA_TEMPORALITY_VALUES.has(temporality);
}

export function otelSumDataPointValue(dataPoint: OtelDataPoint): number {
  if (dataPoint.asInt !== undefined)
    return numberAttribute({ value: dataPoint.asInt }, "value");
  if (dataPoint.asDouble !== undefined)
    return numberAttribute({ value: dataPoint.asDouble }, "value");
  return 0;
}

export function metricDataPointCount(metric: OtelMetric): number {
  return (
    (metric.sum?.dataPoints?.length ?? 0) +
    (metric.histogram?.dataPoints?.length ?? 0) +
    (metric.gauge?.dataPoints?.length ?? 0) +
    (metric.exponentialHistogram?.dataPoints?.length ?? 0)
  );
}

export function toolStatusAttribute(attributes: OtelAttributeMap): string {
  if (typeof attributes.success === "boolean")
    return attributes.success ? "ok" : "error";
  if (typeof attributes.success === "string") {
    const success = attributes.success.trim().toLowerCase();
    if (success === "true") return "ok";
    if (success === "false") return "error";
  }
  if (typeof attributes.status === "string" && attributes.status.trim())
    return safeMetricLabel(attributes.status);
  return "unknown";
}

export function toolResultKey(attributes: OtelAttributeMap): string {
  const callId =
    typeof attributes.call_id === "string" && attributes.call_id.trim()
      ? attributes.call_id.trim()
      : typeof attributes.tool_call_id === "string" &&
          attributes.tool_call_id.trim()
        ? attributes.tool_call_id.trim()
        : null;
  const tool = toolNameAttribute(attributes);
  const source = safeMetricLabel(attributes.source);
  const server = toolServerAttribute(attributes);
  const conversationId =
    typeof attributes["conversation.id"] === "string"
      ? attributes["conversation.id"].trim()
      : "";
  return [conversationId, callId ?? "no_call_id", tool, source, server].join(
    "\0"
  );
}

export function toolSeriesIdentity(
  attributes: OtelAttributeMap,
  workspaceId: string = ""
): Record<string, string> {
  return {
    tool_name: toolNameAttribute(attributes),
    source: safeMetricLabel(attributes.source),
    server: toolServerAttribute(attributes),
    workspace_id: workspaceId || ""
  };
}

const UNKNOWN_HOOK_LABEL = "unknown-hook";
const UNKNOWN_TOOL_LABEL = "unknown-tool";
export function hookKey(attributes: OtelAttributeMap): string {
  return [
    safeMetricLabel(attributes.hook_name, UNKNOWN_HOOK_LABEL),
    safeMetricLabel(attributes.source),
    safeMetricLabel(attributes.handler_type, "")
  ].join("::");
}

export function sqliteKey(attributes: OtelAttributeMap): string {
  return `${safeMetricLabel(attributes.db)}::${safeMetricLabel(attributes.status)}`;
}

export function skillAgentKind(attributes: OtelAttributeMap): string {
  const sessionSource =
    typeof attributes.session_source === "string"
      ? attributes.session_source.trim()
      : "";
  if (!sessionSource) return "unknown";
  return sessionSource.startsWith("subagent_thread_spawn_")
    ? "subagent"
    : "root";
}

export function skillActivationStatus(status: unknown): boolean {
  return !["skipped", "error", "failure", "unavailable"].includes(
    String(status).toLowerCase()
  );
}

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

export function otelRecordIdentity(kind: string, parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, ...parts]))
    .digest("hex");
}

export function otelLogRecordIdentity(
  record: OtelLogRecord,
  resourceAttributes: OtelAttributesInput,
  scope: OtelScope | undefined
): string | null {
  const time = record.timeUnixNano ?? record.observedTimeUnixNano;
  if (
    time === undefined ||
    time === null ||
    String(time) === "" ||
    String(time) === "0"
  )
    return null;
  return otelRecordIdentity("log", [
    String(time),
    record.severityNumber ?? null,
    record.body ?? null,
    record.attributes ?? [],
    resourceAttributes ?? [],
    scope?.name ?? null,
    scope?.version ?? null
  ]);
}

export function otelSpanIdentity(
  span: OtelSpan,
  resourceAttributes: OtelAttributesInput,
  scope: OtelScope | undefined
): string | null {
  if (span.traceId && span.spanId) return `span:${span.traceId}:${span.spanId}`;
  if (!span.startTimeUnixNano && !span.endTimeUnixNano) return null;
  return otelRecordIdentity("span", [
    span.name ?? null,
    String(span.startTimeUnixNano ?? ""),
    String(span.endTimeUnixNano ?? ""),
    span.status ?? null,
    span.attributes ?? [],
    resourceAttributes ?? [],
    scope?.name ?? null
  ]);
}

export function datapointDiagnosticIdentity(
  kind: string,
  metricName: string,
  dataPoint: OtelDataPoint,
  resourceAttributes: OtelAttributesInput
): string | null {
  if (!dataPoint?.timeUnixNano) return null;
  return otelRecordIdentity("datapoint", [
    kind,
    metricName,
    String(dataPoint.startTimeUnixNano ?? ""),
    String(dataPoint.timeUnixNano),
    dataPoint.attributes ?? [],
    resourceAttributes ?? {}
  ]);
}

export function otelSeriesKey(
  seriesName: string,
  attributes: Record<string, unknown>,
  startTimeUnixNano: unknown
): string {
  const identity = JSON.stringify(
    Object.fromEntries(
      Object.entries(attributes).sort(([a], [b]) =>
        STRING_COLLATOR.compare(a, b)
      )
    )
  );
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${seriesName}::${digest}::${startTimeUnixNano ?? ""}`;
}

export function emptyContextDimensions(): ContextDimensions {
  return { byRole: {}, byWorkspace: {}, byModel: {}, byAgent: {} };
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
  healthTtlMs: number = OTEL_HEALTH_TTL_MS
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

export function formatToolResults(toolResults: ToolResultsState): Record<string, unknown> {
  const byTool = Array.from(toolResults.byTool.values(), (entry) => ({
    ...entry,
    byStatus: { ...entry.byStatus }
  })).sort((a, b) =>
    STRING_COLLATOR.compare(
      `${a.tool}/${a.source}/${a.server}`,
      `${b.tool}/${b.source}/${b.server}`
    )
  );
  return {
    total: toolResults.total,
    executed: toolResults.executed,
    unattributed: toolResults.unattributed,
    causeResolved: toolResults.causeResolved,
    causeUnresolved: toolResults.causeUnresolved,
    byStatus: { ...toolResults.byStatus },
    byTool,
    executionDurationMs: {
      count: toolResults.executionDurationMs.count,
      sum: toolResults.executionDurationMs.sum,
      average: toolResults.executionDurationMs.count
        ? toolResults.executionDurationMs.sum /
          toolResults.executionDurationMs.count
        : 0
    },
    dedupeWindow: toolResults.seenKeys.size
  };
}

export function formatBridgeEvents(events: BridgeEventsState): Record<string, unknown> {
  const formatBucket = (bucket: BridgeToolBucket) => ({
    total: bucket.total,
    byTool: Array.from(bucket.byTool.values(), (entry) => ({
      ...entry,
      byStatus: { ...entry.byStatus }
    })).sort((a, b) =>
      STRING_COLLATOR.compare(
        `${a.tool}/${a.server}`,
        `${b.tool}/${b.server}`
      )
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
    toolExecuted: { ...formatBucket(events.toolExecuted), byReason: {} },
    toolRequested: { ...formatBucket(events.toolRequested), byReason: {} },
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

export function isAutodevAttributesEnabled(): boolean {
  return process.env[AUTODEV_ATTRIBUTES_FLAG] === AUTODEV_ATTRIBUTES_VERSION;
}

export function readAutodevAliasValue(
  attributes: OtelAttributesInput,
  aliases: string[]
): string | null {
  if (!Array.isArray(attributes) || !Array.isArray(aliases)) return null;
  for (const alias of aliases) {
    if (typeof alias !== "string" || !alias) continue;
    const entry = attributes.find(
      (item) => item && typeof item === "object" && item.key === alias
    );
    if (!entry) continue;
    const value = otelAttributeValue(entry.value);
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > AUTODEV_ATTRIBUTE_VALUE_MAX_LENGTH) continue;
    return trimmed;
  }
  return null;
}

export function pushAutodevStringAttr(
  attributes: OtelAttributesInput,
  key: string,
  value: unknown
): boolean {
  if (!Array.isArray(attributes)) return false;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > AUTODEV_ATTRIBUTE_VALUE_MAX_LENGTH)
    return false;
  if (
    attributes.some(
      (entry) => entry && typeof entry === "object" && entry.key === key
    )
  )
    return false;
  attributes.push({ key, value: { stringValue: trimmed } });
  return true;
}

export function isAutodevSpawnLogAttributes(attributes: OtelAttributesInput): boolean {
  if (!Array.isArray(attributes)) return false;
  const eventName = readAutodevAliasValue(attributes, ["event.name"]);
  return (
    typeof eventName === "string" && AUTODEV_SPAWN_LOG_EVENTS.has(eventName)
  );
}

export function enrichAutodevResourceAttributes(
  resource: { attributes?: OtelAttributeMap | OtelAttributesInput } | undefined
): void {
  if (!resource || !Array.isArray(resource.attributes)) return;
  const attrs = resource.attributes;
  pushAutodevStringAttr(
    attrs,
    "autodev.role",
    readAutodevAliasValue(attrs, AUTODEV_RESOURCE_ROLE_ALIASES)
  );
  pushAutodevStringAttr(
    attrs,
    "autodev.workspace",
    readAutodevAliasValue(attrs, AUTODEV_RESOURCE_WORKSPACE_ALIASES)
  );
  pushAutodevStringAttr(
    attrs,
    "autodev.provider",
    readAutodevAliasValue(attrs, AUTODEV_RESOURCE_PROVIDER_ALIASES)
  );
  pushAutodevStringAttr(
    attrs,
    "autodev.model",
    readAutodevAliasValue(attrs, AUTODEV_RESOURCE_MODEL_ALIASES)
  );
}

export function enrichAutodevLogRecord(record: OtelLogRecord): void {
  if (!record || !Array.isArray(record.attributes)) return;
  if (isAutodevSpawnLogAttributes(record.attributes)) {
    pushAutodevStringAttr(
      record.attributes,
      "autodev.spawn.mechanism",
      readAutodevAliasValue(record.attributes, AUTODEV_SPAWN_MECHANISM_ALIASES)
    );
  }
  pushAutodevStringAttr(
    record.attributes,
    "autodev.skill",
    readAutodevAliasValue(record.attributes, AUTODEV_SKILL_ALIASES)
  );
  pushAutodevStringAttr(
    record.attributes,
    "autodev.mcp.server",
    readAutodevAliasValue(record.attributes, AUTODEV_MCP_SERVER_ALIASES)
  );
}

export function enrichAutodevSpan(span: OtelSpan): void {
  if (!span || !Array.isArray(span.attributes)) return;
  pushAutodevStringAttr(
    span.attributes,
    "autodev.mcp.server",
    readAutodevAliasValue(span.attributes, AUTODEV_MCP_SERVER_ALIASES)
  );
}

export function enrichAutodevDataPoint(dataPoint: OtelDataPoint): void {
  if (!dataPoint || !Array.isArray(dataPoint.attributes)) return;
  pushAutodevStringAttr(
    dataPoint.attributes,
    "autodev.skill",
    readAutodevAliasValue(dataPoint.attributes, AUTODEV_SKILL_ALIASES)
  );
}

function enrichAutodevLogs(clone: OtelPayload): void {
  for (const resourceLog of clone.resourceLogs ?? []) {
    enrichAutodevResourceAttributes(resourceLog.resource);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? [])
        enrichAutodevLogRecord(record);
    }
  }
}

function enrichAutodevTraces(clone: OtelPayload): void {
  for (const resourceSpan of clone.resourceSpans ?? []) {
    enrichAutodevResourceAttributes(resourceSpan.resource);
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) enrichAutodevSpan(span);
    }
  }
}

function enrichAutodevMetricDataPoints(metric: OtelMetric): void {
  for (const dataPoint of metric.sum?.dataPoints ?? [])
    enrichAutodevDataPoint(dataPoint);
  for (const dataPoint of metric.histogram?.dataPoints ?? [])
    enrichAutodevDataPoint(dataPoint);
  for (const dataPoint of metric.gauge?.dataPoints ?? [])
    enrichAutodevDataPoint(dataPoint);
}

function enrichAutodevMetrics(clone: OtelPayload): void {
  for (const resourceMetric of clone.resourceMetrics ?? []) {
    enrichAutodevResourceAttributes(resourceMetric.resource);
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? [])
        enrichAutodevMetricDataPoints(metric);
    }
  }
}

function autodevEnrichClone(
  signal: OtelSignal | string,
  clone: OtelPayload
): void {
  if (signal === "logs") enrichAutodevLogs(clone);
  else if (signal === "traces") enrichAutodevTraces(clone);
  else if (signal === "metrics") enrichAutodevMetrics(clone);
}

export function autodevEnrichOtlpPayload(
  signal: OtelSignal | string,
  payload: OtelPayload
): OtelPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  let clone: OtelPayload;
  try {
    clone = structuredClone(payload) as OtelPayload;
  } catch {
    return null;
  }
  autodevEnrichClone(signal, clone);
  return clone;
}

export function createEmptyOtelTelemetry(): OtelTelemetryState {
  return {
    receiver: {
      logs: 0,
      traces: 0,
      metrics: 0,
      invalid: 0,
      lastReceivedAt: null
    },
    sessions: new Map(),
    mcpServers: new Map(),
    recordIdentities: {
      logs: new Set(),
      spans: new Set(),
      datapoints: new Set()
    },
    dimensions: {
      mcp: emptyContextDimensions(),
      tools: emptyContextDimensions(),
      hooks: emptyContextDimensions(),
      skills: emptyContextDimensions(),
      bridge: emptyContextDimensions()
    },
    turns: {
      prompts: 0,
      completed: 0,
      promptLength: 0,
      ttftMs: 0,
      ttftCount: 0
    },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0, tool: 0 },
    metricInventory: new Map(),
    tools: new Map(),
    hooks: new Map(),
    threads: {
      started: { total: 0, bySource: {} },
      spawns: { total: 0, byStatus: {}, byRole: {}, byModel: {} }
    },
    sqlite: {
      init: new Map(),
      initDurationMs: new Map(),
      fallbacks: new Map()
    },
    skills: {
      injected: {
        total: 0,
        byStatus: {},
        byInvokeType: {},
        byAgentKind: {},
        byModel: {},
        byPlugin: {},
        bySkill: new Map()
      },
      used: {
        total: 0,
        bySkill: new Map(),
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {},
        lastSeenAt: null
      },
      turnDuration: { durationSeconds: { count: 0, sum: 0 } },
      threads: {
        enabled: { count: 0, sum: 0 },
        kept: { count: 0, sum: 0 },
        truncated: { count: 0, sum: 0 },
        descriptionTruncatedChars: { count: 0, sum: 0 }
      }
    },
    toolResults: {
      total: 0,
      executed: 0,
      unattributed: 0,
      byStatus: {},
      byTool: new Map(),
      executionDurationMs: { count: 0, sum: 0 },
      causeResolved: 0,
      causeUnresolved: 0,
      seenKeys: new Set()
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

function threadHistogramView(bucket: HistogramBucket): HistogramBucket {
  return {
    ...bucket,
    average: bucket.count ? bucket.sum / bucket.count : 0
  };
}

const METRIC_NAME_TRAILING_PARTS_PATTERN = /#(?:count|sum)$/;

// Reusable collators used by hot sort paths. Hoisted so the same instance
// can be shared across calls instead of constructing a new one each time.
const STRING_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "variant",
  usage: "sort"
});

function restoreNumberFields(
  target: Record<string, unknown>,
  source: { [key: string]: unknown } | null | undefined,
  fields: string[]
): void {
  for (const field of fields) {
    const value = source?.[field];
    if (isFiniteNonnegative(value)) target[field] = value;
  }
}

function sqliteBucketView(
  bucket: SqliteEntry | SqliteDurationEntry
): SqliteEntry | SqliteDurationEntry {
  const isDuration = Object.hasOwn(bucket, "sum");
  if (!isDuration) return { ...bucket };
  const sum = (bucket as SqliteDurationEntry).sum;
  const average =
    bucket.count && Number.isFinite(sum) ? sum / bucket.count : 0;
  return { ...bucket, average };
}

function sqliteBucketsView(
  collection: Map<string, SqliteEntry | SqliteDurationEntry>
): Array<SqliteEntry | SqliteDurationEntry> {
  return Array.from(collection.values(), sqliteBucketView).sort((a, b) =>
    STRING_COLLATOR.compare(`${a.db}/${a.status}`, `${b.db}/${b.status}`)
  );
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
  const fresh =
    Number.isFinite(lastSeenMs) && now - lastSeenMs <= healthTtlMs;
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

export class OtelTracker {
  healthTtlMs: number;
  usageTracker: UsageTracker;
  getConversationThread?:
    ((conversationId: string) => RequestContext | null | undefined) | undefined;
  getBridgeRequestContext?: ((requestId: string) => RequestContext | null | undefined) | undefined;
  onSchedulePersist?: (() => void) | undefined;

  readonly telemetry: OtelTelemetryState;
  readonly metricSeries: Map<string, OtelMetricsSeriesEntry>;
  readonly pendingMcpModelAttribution: Map<
    string,
    Array<{ serverName: string; context: TelemetryContext; status: string }>
  >;

  constructor(options: OtelTrackerOptions = {}) {
    this.healthTtlMs = options.healthTtlMs ?? OTEL_HEALTH_TTL_MS;
    this.usageTracker = options.usageTracker ?? getDefaultUsageTracker();
    this.getConversationThread = options.getConversationThread;
    this.getBridgeRequestContext = options.getBridgeRequestContext;
    this.onSchedulePersist = options.onSchedulePersist;

    this.telemetry = createEmptyOtelTelemetry();
    this.metricSeries = new Map();
    this.pendingMcpModelAttribution = new Map();
  }

  configure(options: Partial<OtelTrackerOptions>): this {
    if (options.healthTtlMs !== undefined) this.healthTtlMs = options.healthTtlMs;
    if (options.usageTracker !== undefined) this.usageTracker = options.usageTracker;
    if (options.getConversationThread !== undefined)
      this.getConversationThread = options.getConversationThread;
    if (options.getBridgeRequestContext !== undefined)
      this.getBridgeRequestContext = options.getBridgeRequestContext;
    if (options.onSchedulePersist !== undefined)
      this.onSchedulePersist = options.onSchedulePersist;
    return this;
  }

  get otelTelemetry(): OtelTelemetryState {
    return this.telemetry;
  }

  get otelMetricSeries(): Map<string, OtelMetricsSeriesEntry> {
    return this.metricSeries;
  }

  mcpServer(name: string): McpServerEntry {
    const cleanName = safeMetricLabel(name, "unknown");
    if (!this.telemetry.mcpServers.has(cleanName)) {
      this.telemetry.mcpServers.set(cleanName, {
        name: cleanName,
        lastSeenAt: null,
        initAttempts: 0,
        toolDiscoveryAttempts: 0,
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

  telemetryConversationId(
    attributes: OtelAttributeMap = {},
    resourceAttributes: OtelAttributeMap = {},
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

  localWorkspaceForConversation(
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap = {}
  ): unknown {
    const conversationId =
      attributes?.["conversation.id"] ??
      resourceAttributes?.["conversation.id"];
    if (typeof conversationId !== "string" || !conversationId.trim())
      return null;
    const thread = this.getConversationThread?.(conversationId.trim()) ?? null;
    const key = (thread as RequestContext | null)?.projectKey ?? (thread as RequestContext | null)?.workspaceKey;
    if (
      !thread ||
      typeof key !== "string" ||
      !key.trim()
    ) {
      return null;
    }
    return thread;
  }

  private resolveWorkspaceDimension(
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap,
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
    if (reqContext?.workspace) return safePrivacyWorkspace(reqContext.workspace);
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
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap,
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
    const threadRole = (thread as RequestContext | null)?.agentRole ?? (thread as RequestContext | null)?.role;
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
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap,
    reqContext: RequestContext | null,
    session: SessionEntry | null,
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
    if (session?.model) return safeMetricLabel(session.model as string);
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
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap,
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
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap,
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
    attributes: OtelAttributeMap,
    options: ResolveTelemetryContextOptions
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
    if (options?.timeUnixNano) {
      const iso = otelTimestamp(options.timeUnixNano);
      if (iso) return { timestamp: iso, timestampSource: "source" };
    }
    return { timestamp: new Date().toISOString(), timestampSource: "ingestion" };
  }

  resolveTelemetryContext(
    attributes: OtelAttributeMap = {},
    resourceAttributes: OtelAttributeMap = {},
    options: ResolveTelemetryContextOptions = {}
  ): TelemetryContext {
    const reqContext = this.resolveRequestContext(attributes, options);
    const conversationId = this.telemetryConversationId(
      attributes,
      resourceAttributes,
      options
    );
    const thread = conversationId
      ? (this.getConversationThread?.(conversationId) ?? null)
      : null;
    const session = conversationId
      ? (this.telemetry.sessions.get(conversationId) ?? null)
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
        session,
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
      agentKind: agentKind as string,
      timestamp: timestamp as string,
      timestampSource
    };
  }

  private resolveRequestContext(
    attributes: OtelAttributeMap,
    options: ResolveTelemetryContextOptions
  ): RequestContext | null {
    if (options?.context) return options.context;
    if (options?.requestId) {
      return this.getBridgeRequestContext?.(options.requestId) ?? null;
    }
    if (attributes?.requestId) {
      return this.getBridgeRequestContext?.(attributes.requestId) ?? null;
    }
    if (attributes?.request_id) {
      return this.getBridgeRequestContext?.(attributes.request_id) ?? null;
    }
    return null;
  }

  firstOtelRecordObservation(
    seen: Set<string>,
    identity: string | null
  ): boolean {
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    while (seen.size > OTEL_RECORD_IDENTITY_LIMIT) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    return true;
  }

  otelSeriesDelta(
    seriesKey: string,
    timeUnixNano: unknown,
    value: number,
    temporality: unknown
  ): number {
    const timestamp = otelNanoTimestamp(timeUnixNano);
    const previous = this.metricSeries.get(seriesKey);
    if (previous && timestamp > 0n && timestamp <= previous.timestamp) return 0;
    const delta =
      !isDeltaTemporality(temporality) && previous && value >= previous.value
        ? value - previous.value
        : value;
    this.metricSeries.set(seriesKey, { timestamp, value });
    return Math.max(0, delta);
  }

  noteConversation(
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap = {}
  ): SessionEntry | null {
    const id =
      attributes["conversation.id"] ?? resourceAttributes["conversation.id"];
    if (typeof id !== "string" || !id) return null;
    const session = this.telemetry.sessions.get(id) ?? {
      id,
      model: null,
      mcpServers: new Set(),
      lastSeenAt: null
    };
    session.model = (attributes.model as string | undefined) ?? (resourceAttributes.model as string | undefined) ?? session.model;
    session.lastSeenAt =
      (attributes["event.timestamp"] as string | undefined) ?? new Date().toISOString();
    const names = resourceAttributes.mcp_servers;
    if (typeof names === "string") {
      for (const name of names
        .split(",")
        .map((item: string) => item.trim())
        .filter(Boolean)) {
        session.mcpServers.add(name);
        const server = this.mcpServer(name);
        if (server.lastStatus === "unknown") server.lastStatus = "configured";
        const context = this.resolveTelemetryContext(
          attributes,
          resourceAttributes,
          { conversationId: id, timestamp: attributes["event.timestamp"] }
        );
        this.noteMcpObservation(
          server,
          context,
          this.telemetryConversationId({}, {}, { conversationId: id }),
          "configured"
        );
      }
    }
    this.telemetry.sessions.set(id, session);
    if (session.model)
      this.resolvePendingMcpModelAttribution(id, session.model);
    return session;
  }

  noteContextDimension(
    family: keyof OtelTelemetryState["dimensions"],
    context: TelemetryContext,
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
    context: TelemetryContext,
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

  noteMcpDimension(
    server: McpServerEntry,
    dimension: "byRole" | "byWorkspace" | "byModel" | "byAgent",
    key: string,
    context: TelemetryContext,
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
    context: TelemetryContext,
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

  noteMcpObservation(
    server: McpServerEntry,
    context: TelemetryContext,
    conversationId: string | null,
    status: string
  ): void {
    this.noteMcpDimension(server, "byRole", context.role, context, status);
    this.noteMcpDimension(
      server,
      "byWorkspace",
      context.workspace,
      context,
      status
    );
    this.noteMcpDimension(server, "byAgent", context.agent, context, status);
    this.noteContextDimension("mcp", context, 1, NON_MODEL_CONTEXT_DIMENSIONS);
    if (context.model === UNATTRIBUTED_DIMENSION && conversationId) {
      this.deferMcpModelAttribution(
        conversationId,
        server.name,
        context,
        status
      );
      return;
    }
    this.applyMcpModelObservation(server, context.model, context, status);
  }

  applyMcpModelObservation(
    server: McpServerEntry,
    model: string,
    context: TelemetryContext,
    status: string
  ): void {
    this.noteMcpDimension(server, "byModel", model, context, status);
    this.noteContextDimension(
      "mcp",
      { ...context, model },
      1,
      MODEL_CONTEXT_DIMENSIONS
    );
  }

  commitMcpModelObservations(
    observations: Array<{
      serverName: string;
      context: TelemetryContext;
      status: string;
    }>,
    model: string
  ): void {
    for (const { serverName, context, status } of observations) {
      this.applyMcpModelObservation(
        this.mcpServer(serverName),
        model,
        context,
        status
      );
    }
  }

  deferMcpModelAttribution(
    conversationId: string,
    serverName: string,
    context: TelemetryContext,
    status: string
  ): void {
    let observations = this.pendingMcpModelAttribution.get(conversationId);
    if (!observations) {
      observations = [];
      this.pendingMcpModelAttribution.set(conversationId, observations);
      while (
        this.pendingMcpModelAttribution.size >
        PENDING_MCP_MODEL_CONVERSATION_LIMIT
      ) {
        const oldestEntry = this.pendingMcpModelAttribution
          .entries()
          .next().value;
        if (oldestEntry) {
          const [oldest, oldestObservations] = oldestEntry;
          this.pendingMcpModelAttribution.delete(oldest);
          this.commitMcpModelObservations(
            oldestObservations,
            UNATTRIBUTED_DIMENSION
          );
        }
      }
    }
    observations.push({ serverName, context, status });
    if (observations.length > PENDING_MCP_MODEL_OBSERVATION_LIMIT) {
      this.commitMcpModelObservations(
        observations.splice(
          0,
          observations.length - PENDING_MCP_MODEL_OBSERVATION_LIMIT
        ),
        UNATTRIBUTED_DIMENSION
      );
    }
  }

  resolvePendingMcpModelAttribution(
    conversationId: string,
    model: string
  ): void {
    const key = conversationId.trim();
    const observations = this.pendingMcpModelAttribution.get(key);
    if (!observations) return;
    this.pendingMcpModelAttribution.delete(key);
    this.commitMcpModelObservations(observations, safeMetricLabel(model));
  }

  mcpModelDimensionsView(): {
    serverByModel: Map<string, Record<string, McpServerDimensionBucket>>;
    dimensionByModel: Record<string, ContextDimensionBucket>;
  } {
    const cloneBuckets = <T extends Record<string, unknown>>(
      buckets: T | null | undefined
    ): T =>
      Object.fromEntries(
        Object.entries(buckets ?? {}).map(([key, bucket]) => [
          key,
          { ...(bucket as object) }
        ])
      ) as T;
    const serverByModel = new Map<
      string,
      Record<string, McpServerDimensionBucket>
    >();
    const dimensionByModel = cloneBuckets(
      this.telemetry.dimensions.mcp.byModel
    );
    for (const observations of this.pendingMcpModelAttribution.values()) {
      for (const { serverName, context, status } of observations) {
        if (!serverByModel.has(serverName)) {
          serverByModel.set(
            serverName,
            cloneBuckets(this.telemetry.mcpServers.get(serverName)?.byModel)
          );
        }
        const serverBuckets = serverByModel.get(serverName)!;
        this.mergeMcpDimensionBucket(
          serverBuckets,
          "byModel",
          UNATTRIBUTED_DIMENSION,
          context,
          status
        );
        this.mergeContextDimensionBucket(
          dimensionByModel,
          "byModel",
          UNATTRIBUTED_DIMENSION,
          context,
          1,
          context.timestamp ?? new Date().toISOString()
        );
      }
    }
    return { serverByModel, dimensionByModel };
  }

  noteMcpServer(
    name: string | null | undefined,
    span: OtelSpan,
    attributes: OtelAttributeMap = {},
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const serverName =
      name ??
      attributes.server_name ??
      attributes.server ??
      attributes.mcp_server;
    if (typeof serverName !== "string" || !serverName.trim()) return;
    const server = this.mcpServer(serverName.trim());
    const durationMs = span ? otelDurationMs(span) : 0;
    const timestamp = span
      ? (otelTimestamp(span.endTimeUnixNano) ??
        otelTimestamp(span.startTimeUnixNano))
      : null;
    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timestamp }
    );
    const statusCode = (span?.status as { code?: string | number } | undefined)?.code;
    if (
      !server.lastSeenAt ||
      timestampNotOlder(context.timestamp, server.lastSeenAt)
    )
      server.lastSeenAt = context.timestamp;
    if (span) {
      server.durationMs += durationMs;
      server.durationCount += 1;
      if (
        span.name === "make_rmcp_client" ||
        span.name === "start_server_task" ||
        span.name === "new"
      )
        server.initAttempts += 1;
      if (
        span.name === "list_tools_for_client_uncached" ||
        span.name === "list_tools_with_connector_ids"
      )
        server.toolDiscoveryAttempts += 1;
      if (statusCode === 2 || statusCode === "ERROR") {
        server.failures += 1;
        server.lastStatus = "error";
      } else if (
        span.name === "list_tools_for_client_uncached" ||
        span.name === "list_tools_with_connector_ids" ||
        span.name === "initialize"
      ) {
        server.lastStatus = "ready";
      } else if (server.lastStatus === "unknown") {
        server.lastStatus = "observed";
      }
      if (attributes["error.type"] || attributes["error.message"])
        server.lastStatus = "error";
    }

    this.noteMcpObservation(
      server,
      context,
      this.telemetryConversationId(attributes, resourceAttributes),
      server.lastStatus
    );

    if (context.workspace !== UNATTRIBUTED_DIMENSION) {
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        context.workspace
      );
      wsBucket.mcpCapable = true;
      if (!span || !MCP_DISCOVERY_SPAN_NAMES.has(span.name)) return;
      wsBucket.byMcp[server.name] = (wsBucket.byMcp[server.name] ?? 0) + 1;
    }
  }

  noteCodexToolResultLog(
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const tool = toolNameAttribute(attributes, UNKNOWN_TOOL_LABEL);
    const source = safeMetricLabel(
      attributes.tool_origin ?? attributes.source,
      "codex"
    );
    const server = toolServerAttribute(attributes);
    const callId =
      typeof (attributes.call_id ?? attributes.tool_call_id) === "string"
        ? String(attributes.call_id ?? attributes.tool_call_id).trim()
        : "";
    const key = `log:${toolResultKey({ ...attributes, call_id: callId || attributes.call_id, tool, source, server })}`;
    if (this.telemetry.toolResults.seenKeys.has(key)) return;
    this.telemetry.toolResults.seenKeys.add(key);
    while (this.telemetry.toolResults.seenKeys.size > 5000) {
      const first = this.telemetry.toolResults.seenKeys.values().next().value;
      if (first === undefined) break;
      this.telemetry.toolResults.seenKeys.delete(first);
    }
    const status = toolStatusAttribute(attributes);
    const count = 1;
    this.telemetry.toolResults.total += count;
    this.telemetry.toolResults.executed += count;
    this.telemetry.toolResults.causeResolved += callId ? count : 0;
    this.telemetry.toolResults.causeUnresolved += callId ? 0 : count;
    if (!callId) this.telemetry.toolResults.unattributed += count;
    this.telemetry.toolResults.byStatus[status] =
      (this.telemetry.toolResults.byStatus[status] ?? 0) + count;
    const rowKey = [tool, source, server].join("::");
    const row = this.telemetry.toolResults.byTool.get(rowKey) ?? {
      tool,
      source,
      server,
      count: 0,
      byStatus: {}
    };
    row.count += count;
    row.byStatus[status] = (row.byStatus[status] ?? 0) + count;
    this.telemetry.toolResults.byTool.set(rowKey, row);
    const duration = Number(attributes.duration_ms);

    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timestamp: attributes["event.timestamp"] }
    );
    this.noteContextDimension("tools", context, count);
    if (server) {
      const mcp = this.mcpServer(server);
      this.noteMcpDimension(mcp, "byRole", context.role, context, "observed");
      this.noteMcpDimension(
        mcp,
        "byWorkspace",
        context.workspace,
        context,
        "observed"
      );
      this.noteMcpDimension(mcp, "byModel", context.model, context, "observed");
      this.noteMcpDimension(mcp, "byAgent", context.agent, context, "observed");
    }

    const thread = this.localWorkspaceForConversation(
      attributes,
      resourceAttributes
    );
    if (!thread && context.workspace === UNATTRIBUTED_DIMENSION) {
      this.usageTracker.attributionDiagnostics.total += 1;
      this.usageTracker.attributionDiagnostics.unattributed += 1;
      this.usageTracker.attributionDiagnostics.byReason.missing_workspace += 1;
      return;
    }
    this.usageTracker.attributionDiagnostics.total += 1;
    this.usageTracker.attributionDiagnostics.attributed += 1;
    this.usageTracker.attributionDiagnostics.bySource.datapoint += 1;
    const wsKey =
      (thread?.projectKey ?? thread?.workspaceKey) ||
      (context.workspace === UNATTRIBUTED_DIMENSION ? null : context.workspace);
    const wsBucket = this.usageTracker.workspaceBucket(
      this.usageTracker.usageTelemetry.byWorkspace,
      wsKey,
      thread?.cwdBasename ?? null
    );
    wsBucket.toolsCapable = true;
    const wsTool = this.usageTracker.workspaceToolBucket(wsBucket, {
      tool,
      source,
      server
    });
    wsTool.count += count;
    wsTool.byStatus[status] = (wsTool.byStatus[status] ?? 0) + count;
    if (Number.isFinite(duration) && duration >= 0) {
      wsTool.durationCount += 1;
      wsTool.durationMs += duration;
    }
    if (server) {
      wsBucket.mcpCapable = true;
      wsBucket.byMcp[server] = (wsBucket.byMcp[server] ?? 0) + count;
    }
  }

  private recordTurnLogEvent(
    eventName: unknown,
    attributes: OtelAttributeMap
  ): void {
    if (eventName === "codex.conversation_starts") {
      // Conversation start is already noted by noteConversation at the call site.
      return;
    }
    if (eventName === "codex.user_prompt") {
      this.telemetry.turns.prompts += 1;
      this.telemetry.turns.promptLength += numberAttribute(
        attributes,
        "prompt_length"
      );
      return;
    }
    if (eventName === "codex.turn_ttft") {
      const duration = numberAttribute(attributes, "duration_ms");
      this.telemetry.turns.ttftMs += duration;
      this.telemetry.turns.ttftCount += duration > 0 ? 1 : 0;
      return;
    }
    if (eventName === "codex.tool_result") {
      // Handled by noteCodexToolResultLog at the call site.
      return;
    }
    if (
      eventName === "codex.sse_event" &&
      attributes["event.kind"] === "response.completed"
    ) {
      this.telemetry.turns.completed += 1;
      this.telemetry.tokens.input += numberAttribute(
        attributes,
        "input_token_count"
      );
      this.telemetry.tokens.output += numberAttribute(
        attributes,
        "output_token_count"
      );
      this.telemetry.tokens.cached += numberAttribute(
        attributes,
        "cached_token_count"
      );
      this.telemetry.tokens.reasoning += numberAttribute(
        attributes,
        "reasoning_token_count"
      );
      this.telemetry.tokens.tool += numberAttribute(
        attributes,
        "tool_token_count"
      );
    }
  }

  ingestOtelLogs(payload: OtelPayload): void {
    for (const resourceLog of payload?.resourceLogs ?? []) {
      const resource = otelAttributes(resourceLog.resource?.attributes);
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          const recordIdentity = otelLogRecordIdentity(
            record,
            resourceLog.resource?.attributes,
            scopeLog.scope
          );
          if (
            !this.firstOtelRecordObservation(
              this.telemetry.recordIdentities.logs,
              recordIdentity
            )
          ) {
            continue;
          }
          const attributes = otelAttributes(record.attributes);
          this.noteConversation(attributes, resource);
          this.recordTurnLogEvent(attributes["event.name"], attributes);
          if (attributes["event.name"] === "codex.tool_result") {
            this.noteCodexToolResultLog(attributes, resource);
          }
        }
      }
    }
  }

  ingestOtelTraces(payload: OtelPayload): void {
    for (const resourceSpan of payload?.resourceSpans ?? []) {
      const resource = otelAttributes(resourceSpan.resource?.attributes);
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        for (const span of scopeSpan.spans ?? []) {
          if (
            !this.firstOtelRecordObservation(
              this.telemetry.recordIdentities.spans,
              otelSpanIdentity(
                span,
                resourceSpan.resource?.attributes,
                scopeSpan.scope
              )
            )
          )
            continue;
          const attributes = otelAttributes(span.attributes);
          this.noteConversation(attributes, resource);
          const serverName =
            attributes.server_name ??
            attributes.server ??
            attributes.mcp_server;
          this.noteMcpServer(serverName, span, attributes, resource);
        }
      }
    }
  }

  private isWorkspaceAmbiguous(
    dp: { id: string | null; ambiguous: boolean },
    resource: { id: string | null; ambiguous: boolean },
    dpId: string | null,
    resourceId: string | null
  ): boolean {
    return (
      dp.ambiguous ||
      resource.ambiguous ||
      (dpId !== null && resourceId !== null && dpId !== resourceId)
    );
  }

  private recordUnattributedReason(
    record: boolean,
    reason: "ambiguous_resource" | "missing_workspace" | "unknown_workspace_id"
  ): void {
    if (!record) return;
    this.usageTracker.attributionDiagnostics.total += 1;
    this.usageTracker.attributionDiagnostics.unattributed += 1;
    this.usageTracker.attributionDiagnostics.byReason[reason] += 1;
  }

  private rememberUnknownWorkspaceId(workspaceId: string): void {
    const ids = this.usageTracker.attributionDiagnostics.unknownWorkspaceIds;
    ids.delete(workspaceId);
    ids.add(workspaceId);
    while (ids.size > MAX_UNKNOWN_WORKSPACE_IDS) {
      const oldest = ids.values().next().value;
      if (oldest === undefined) break;
      ids.delete(oldest);
    }
  }

  resolveDatapointWorkspace(
    dataPointAttributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap = {},
    diagnosticIdentity: string | null = null
  ): {
    status: "attributed" | "unattributed";
    workspaceKey: string | null;
    workspaceId: string | null;
    source: "datapoint" | "resource" | null;
    reason?: string;
  } {
    const record = this.firstOtelRecordObservation(
      this.telemetry.recordIdentities.datapoints,
      diagnosticIdentity
    );
    const dp = extractWorkspaceIdWithAmbiguity(dataPointAttributes);
    const resource = extractWorkspaceIdWithAmbiguity(resourceAttributes);
    const dpId = dp.id ? safeWorkspaceId(dp.id) : null;
    const resourceId = resource.id ? safeWorkspaceId(resource.id) : null;
    if (this.isWorkspaceAmbiguous(dp, resource, dpId, resourceId)) {
      this.recordUnattributedReason(record, "ambiguous_resource");
      return {
        status: "unattributed",
        workspaceKey: null,
        workspaceId: null,
        reason: "ambiguous_resource",
        source: dp.id ? "datapoint" : "resource"
      };
    }

    const workspaceId = dpId ?? resourceId;
    const source = dpId ? "datapoint" : resourceId ? "resource" : null;
    if (!workspaceId) {
      this.recordUnattributedReason(record, "missing_workspace");
      return {
        status: "unattributed",
        workspaceKey: null,
        workspaceId: null,
        reason: "missing_workspace",
        source: null
      };
    }

    if (record) this.usageTracker.attributionDiagnostics.total += 1;
    const workspaceKey = this.usageTracker.workspaceIdConflicts.has(workspaceId)
      ? null
      : this.usageTracker.workspaceIdRegistry.get(workspaceId);
    if (workspaceKey) {
      if (record) {
        this.usageTracker.attributionDiagnostics.attributed += 1;
        if (source)
          this.usageTracker.attributionDiagnostics.bySource[source] += 1;
      }
      return { status: "attributed", workspaceKey, workspaceId, source };
    }

    this.recordUnattributedReason(record, "unknown_workspace_id");
    this.rememberUnknownWorkspaceId(workspaceId);
    return {
      status: "unattributed",
      workspaceKey: null,
      workspaceId,
      reason: "unknown_workspace_id",
      source
    };
  }

  skillBucket(name: string): SkillInjectedSkillBucket {
    if (!this.telemetry.skills.injected.bySkill.has(name)) {
      this.telemetry.skills.injected.bySkill.set(name, {
        skill: name,
        total: 0,
        byStatus: {},
        byInvokeType: {},
        byAgentKind: {},
        byModel: {},
        byPlugin: {}
      });
    }
    return this.telemetry.skills.injected.bySkill.get(name)!;
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
    context: TelemetryContext,
    count: number = 1,
    timestamp: string | null = null
  ): void {
    if (!skill || !Number.isFinite(count) || count <= 0) return;
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

  noteSkillInjected(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown,
    dpAttributes: OtelAttributeMap = {},
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const wsResolution = this.resolveDatapointWorkspace(
      dpAttributes ?? attributes,
      resourceAttributes,
      datapointDiagnosticIdentity(
        "skill",
        metricName,
        dataPoint,
        resourceAttributes
      )
    );
    const seriesAttributes = {
      ...attributes,
      workspace_id: wsResolution.workspaceId || ""
    };
    const delta = this.otelSeriesDelta(
      otelSeriesKey(metricName, seriesAttributes, dataPoint.startTimeUnixNano),
      dataPoint.timeUnixNano,
      otelSumDataPointValue(dataPoint),
      temporality
    );
    if (delta === 0) return;
    const context = this.resolveTelemetryContext(
      { ...attributes, ...dpAttributes },
      resourceAttributes,
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    this.noteContextDimension("skills", context, delta);
    const skill = readNamedAttribute(
      attributes,
      "unknown",
      "skillName",
      "skill",
      "skill_name"
    );
    const status = safeMetricLabel(attributes.status);
    const invokeType =
      typeof attributes.invoke_type === "string" && attributes.invoke_type
        ? safeMetricLabel(attributes.invoke_type)
        : null;
    const agentKind = context.agentKind;
    const model = context.model;
    const plugin = safeMetricLabel(attributes.plugin_id, "none");
    const injected = this.telemetry.skills.injected;
    injected.total += delta;
    injected.byStatus[status] = (injected.byStatus[status] ?? 0) + delta;
    if (invokeType)
      injected.byInvokeType[invokeType] =
        (injected.byInvokeType[invokeType] ?? 0) + delta;
    injected.byAgentKind[agentKind] =
      (injected.byAgentKind[agentKind] ?? 0) + delta;
    injected.byModel[model] = (injected.byModel[model] ?? 0) + delta;
    injected.byPlugin[plugin] = (injected.byPlugin[plugin] ?? 0) + delta;
    const bucket = this.skillBucket(skill);
    bucket.total += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
    if (invokeType)
      bucket.byInvokeType[invokeType] =
        (bucket.byInvokeType[invokeType] ?? 0) + delta;
    bucket.byAgentKind[agentKind] =
      (bucket.byAgentKind[agentKind] ?? 0) + delta;
    bucket.byModel[model] = (bucket.byModel[model] ?? 0) + delta;
    bucket.byPlugin[plugin] = (bucket.byPlugin[plugin] ?? 0) + delta;

    if (wsResolution.status === "attributed" && wsResolution.workspaceKey) {
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        wsResolution.workspaceKey
      );
      wsBucket.skillsCapable = true;
      const explicitUse =
        invokeType === "explicit" && skillActivationStatus(status);
      if (explicitUse) {
        this.recordSkillUse(skill, context, delta, context.timestamp);
      }
      const wsSkill = this.usageTracker.workspaceSkillBucket(wsBucket, skill);
      wsSkill.total += delta;
      wsSkill.byStatus[status] = (wsSkill.byStatus[status] ?? 0) + delta;
      if (invokeType)
        wsSkill.byInvokeType[invokeType] =
          (wsSkill.byInvokeType[invokeType] ?? 0) + delta;
      wsSkill.byAgentKind[agentKind] =
        (wsSkill.byAgentKind[agentKind] ?? 0) + delta;
      wsSkill.byModel[model] = (wsSkill.byModel[model] ?? 0) + delta;
      wsSkill.byPlugin[plugin] = (wsSkill.byPlugin[plugin] ?? 0) + delta;
    }
    if (
      wsResolution.status !== "attributed" &&
      invokeType === "explicit" &&
      skillActivationStatus(status)
    ) {
      this.recordSkillUse(skill, context, delta, context.timestamp);
    }
    if (
      wsResolution.status === "attributed" &&
      wsResolution.workspaceKey &&
      (!skill || skill === "unknown")
    ) {
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        wsResolution.workspaceKey
      );
      wsBucket.skillsUnattributed = (wsBucket.skillsUnattributed ?? 0) + delta;
    }
  }

  noteThreadSkillsHistogram(
    bucket: HistogramBucket,
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown
  ): void {
    const countDelta = this.otelSeriesDelta(
      otelSeriesKey(
        `${metricName}#count`,
        attributes,
        dataPoint.startTimeUnixNano
      ),
      dataPoint.timeUnixNano,
      numberAttribute({ count: dataPoint.count }, "count"),
      temporality
    );
    const sumDelta = this.otelSeriesDelta(
      otelSeriesKey(
        `${metricName}#sum`,
        attributes,
        dataPoint.startTimeUnixNano
      ),
      dataPoint.timeUnixNano,
      numberAttribute({ sum: dataPoint.sum }, "sum"),
      temporality
    );
    bucket.count += countDelta;
    bucket.sum += sumDelta;
    const context = this.resolveTelemetryContext(
      attributes,
      {},
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    this.noteContextDimension("skills", context, countDelta);
  }

  noteMetricInventory(metric: OtelMetric): void {
    if (typeof metric.name !== "string" || !metric.name) return;
    const entry = this.telemetry.metricInventory.get(metric.name) ?? {
      name: metric.name,
      exports: 0,
      dataPoints: 0
    };
    entry.exports += 1;
    entry.dataPoints += metricDataPointCount(metric);
    this.telemetry.metricInventory.set(metric.name, entry);
  }

  sqliteBucket(
    collection: Map<string, SqliteEntry>,
    attributes: OtelAttributeMap
  ): SqliteEntry {
    const key = sqliteKey(attributes);
    if (!collection.has(key))
      collection.set(key, {
        db: safeMetricLabel(attributes.db),
        status: safeMetricLabel(attributes.status),
        count: 0
      });
    return collection.get(key)!;
  }

  sqliteDurationBucket(attributes: OtelAttributeMap): SqliteDurationEntry {
    const key = sqliteKey(attributes);
    if (!this.telemetry.sqlite.initDurationMs.has(key)) {
      this.telemetry.sqlite.initDurationMs.set(key, {
        db: safeMetricLabel(attributes.db),
        status: safeMetricLabel(attributes.status),
        count: 0,
        sum: 0
      });
    }
    return this.telemetry.sqlite.initDurationMs.get(key)!;
  }

  noteSqliteCounter(
    collection: Map<string, SqliteEntry>,
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown
  ): void {
    const value = otelSumDataPointValue(dataPoint);
    const delta = this.otelSeriesDelta(
      otelSeriesKey(
        metricName,
        {
          db: safeMetricLabel(attributes.db),
          status: safeMetricLabel(attributes.status)
        },
        dataPoint.startTimeUnixNano
      ),
      dataPoint.timeUnixNano,
      value,
      temporality
    );
    this.sqliteBucket(collection, attributes).count += delta;
  }

  toolBucket(attributes: OtelAttributeMap): ToolEntry {
    const tool = toolNameAttribute(attributes);
    const source = safeMetricLabel(attributes.source);
    const server = toolServerAttribute(attributes);
    const key = toolKey(attributes);
    if (!this.telemetry.tools.has(key))
      this.telemetry.tools.set(key, {
        tool,
        source,
        server,
        count: 0,
        byStatus: {},
        durationCount: 0,
        durationMs: 0
      });
    return this.telemetry.tools.get(key)!;
  }

  noteToolCounter(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown,
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const wsResolution = this.resolveDatapointWorkspace(
      attributes,
      resourceAttributes,
      datapointDiagnosticIdentity(
        "tool-counter",
        metricName,
        dataPoint,
        resourceAttributes
      )
    );
    const identity = toolSeriesIdentity(
      attributes,
      wsResolution.workspaceId || ""
    );
    const delta = this.otelSeriesDelta(
      otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano),
      dataPoint.timeUnixNano,
      otelSumDataPointValue(dataPoint),
      temporality
    );
    if (delta === 0) return;
    const bucket = this.toolBucket(attributes);
    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    this.noteContextDimension("tools", context, delta);
    const status = toolStatusAttribute(attributes);
    bucket.count += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;

    if (wsResolution.status === "attributed" && wsResolution.workspaceKey) {
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        wsResolution.workspaceKey
      );
      wsBucket.toolsCapable = true;
      const wsTool = this.usageTracker.workspaceToolBucket(
        wsBucket,
        attributes
      );
      wsTool.count += delta;
      wsTool.byStatus[status] = (wsTool.byStatus[status] ?? 0) + delta;
    }
  }

  noteToolDuration(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown,
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const wsResolution = this.resolveDatapointWorkspace(
      attributes,
      resourceAttributes,
      datapointDiagnosticIdentity(
        "tool-duration",
        metricName,
        dataPoint,
        resourceAttributes
      )
    );
    const identity = toolSeriesIdentity(
      attributes,
      wsResolution.workspaceId || ""
    );
    const count = this.otelSeriesDelta(
      otelSeriesKey(
        `${metricName}#count`,
        identity,
        dataPoint.startTimeUnixNano
      ),
      dataPoint.timeUnixNano,
      numberAttribute({ count: dataPoint.count }, "count"),
      temporality
    );
    const sum = this.otelSeriesDelta(
      otelSeriesKey(`${metricName}#sum`, identity, dataPoint.startTimeUnixNano),
      dataPoint.timeUnixNano,
      numberAttribute({ sum: dataPoint.sum }, "sum"),
      temporality
    );
    const bucket = this.toolBucket(attributes);
    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    this.noteContextDimension("tools", context, count);
    bucket.durationCount += count;
    bucket.durationMs += sum;

    if (wsResolution.status === "attributed" && wsResolution.workspaceKey) {
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        wsResolution.workspaceKey
      );
      wsBucket.toolsCapable = true;
      const wsTool = this.usageTracker.workspaceToolBucket(
        wsBucket,
        attributes
      );
      wsTool.durationCount += count;
      wsTool.durationMs += sum;
    }
  }

  private resolveToolResultCallId(attributes: OtelAttributeMap): string | null {
    if (typeof attributes.call_id === "string" && attributes.call_id.trim()) {
      return attributes.call_id.trim();
    }
    if (
      typeof attributes.tool_call_id === "string" &&
      attributes.tool_call_id.trim()
    ) {
      return attributes.tool_call_id.trim();
    }
    return null;
  }

  private recordToolResultStatus(
    status: string,
    delta: number
  ): void {
    this.telemetry.toolResults.byStatus[status] =
      (this.telemetry.toolResults.byStatus[status] ?? 0) + delta;
  }

  private accumulateToolResultRow(
    tool: string,
    source: string,
    server: string,
    status: string,
    delta: number
  ): void {
    if (!tool || tool === UNKNOWN_TOOL_LABEL) return;
    const resultBucketKey = [tool, source, server].join("::");
    const resultBucket =
      this.telemetry.toolResults.byTool.get(resultBucketKey) ?? {
        tool,
        source,
        server,
        count: 0,
        byStatus: {}
      };
    resultBucket.count += delta;
    resultBucket.byStatus[status] =
      (resultBucket.byStatus[status] ?? 0) + delta;
    this.telemetry.toolResults.byTool.set(resultBucketKey, resultBucket);
  }

  private trimToolResultSeenKeys(): void {
    while (this.telemetry.toolResults.seenKeys.size > 5000) {
      const first = this.telemetry.toolResults.seenKeys.values().next().value;
      if (first === undefined) break;
      this.telemetry.toolResults.seenKeys.delete(first);
    }
  }

  private applyToolResultCallAttribution(
    callId: string | null,
    duplicateMetric: boolean,
    delta: number,
    wsResolution: ReturnType<OtelTracker["resolveDatapointWorkspace"]>
  ): void {
    if (callId && !duplicateMetric) {
      this.telemetry.toolResults.executed += delta;
      this.telemetry.toolResults.causeResolved += delta;
      this.trimToolResultSeenKeys();
      return;
    }
    if (!duplicateMetric) {
      this.telemetry.toolResults.unattributed += delta;
      if (!callId) this.telemetry.toolResults.causeUnresolved += delta;
      if (wsResolution.status === "attributed" && wsResolution.workspaceKey) {
        const wsBucket = this.usageTracker.workspaceBucket(
          this.usageTracker.usageTelemetry.byWorkspace,
          wsResolution.workspaceKey
        );
        wsBucket.toolsUnattributed =
          (wsBucket.toolsUnattributed ?? 0) + delta;
      }
    }
  }

  private recordToolResultMcpObservation(
    attributes: OtelAttributeMap,
    resourceAttributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    server: string,
    delta: number
  ): void {
    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    const mcp = this.mcpServer(server);
    this.noteMcpDimension(mcp, "byRole", context.role, context, "observed");
    this.noteMcpDimension(
      mcp,
      "byWorkspace",
      context.workspace,
      context,
      "observed"
    );
    this.noteMcpDimension(mcp, "byModel", context.model, context, "observed");
    this.noteMcpDimension(mcp, "byAgent", context.agent, context, "observed");
    this.noteContextDimension("tools", context, delta);
    if (context.workspace !== UNATTRIBUTED_DIMENSION) {
      const wsBucket = this.usageTracker.workspaceBucket(
        this.usageTracker.usageTelemetry.byWorkspace,
        context.workspace
      );
      wsBucket.mcpCapable = true;
      wsBucket.byMcp[server] = (wsBucket.byMcp[server] ?? 0) + delta;
    }
  }

  noteToolResultCounter(
    metricName: string,
    resourceAttributes: OtelAttributeMap,
    dataPoints: OtelDataPoint[],
    temporality: unknown
  ): void {
    for (const dataPoint of dataPoints ?? []) {
      const attributes = otelAttributes(dataPoint.attributes);
      const wsResolution = this.resolveDatapointWorkspace(
        attributes,
        resourceAttributes,
        datapointDiagnosticIdentity(
          "tool-result-counter",
          metricName,
          dataPoint,
          resourceAttributes
        )
      );
      if (wsResolution.status === "attributed" && wsResolution.workspaceKey) {
        this.usageTracker.workspaceBucket(
          this.usageTracker.usageTelemetry.byWorkspace,
          wsResolution.workspaceKey
        ).toolsCapable = true;
      }
      const identity = toolSeriesIdentity(
        attributes,
        wsResolution.workspaceId || ""
      );
      const tool = toolNameAttribute(attributes);
      const source = safeMetricLabel(attributes.source);
      const server = toolServerAttribute(attributes);
      const status = toolStatusAttribute(attributes);
      const callId = this.resolveToolResultCallId(attributes);
      const resultIdentity = { ...identity, call_id: callId ?? "" };
      const delta = this.otelSeriesDelta(
        otelSeriesKey(
          `${metricName}#count`,
          resultIdentity,
          dataPoint.startTimeUnixNano
        ),
        dataPoint.timeUnixNano,
        otelSumDataPointValue(dataPoint),
        temporality
      );
      if (delta === 0) continue;
      const resultKey = toolResultKey(attributes);
      const logSeen = this.telemetry.toolResults.seenKeys.has(
        `log:${resultKey}`
      );
      const metricSeen = this.telemetry.toolResults.seenKeys.has(
        `metric:${resultKey}`
      );
      if (logSeen) continue;
      this.telemetry.toolResults.total += delta;
      const duplicateMetric = metricSeen;
      if (duplicateMetric) {
        this.telemetry.toolResults.unattributed += delta;
      } else {
        this.telemetry.toolResults.seenKeys.add(`metric:${resultKey}`);
      }
      this.applyToolResultCallAttribution(
        callId,
        duplicateMetric,
        delta,
        wsResolution
      );
      this.recordToolResultStatus(status, delta);
      this.accumulateToolResultRow(tool, source, server, status, delta);
      if (server && delta > 0 && !duplicateMetric) {
        this.recordToolResultMcpObservation(
          attributes,
          resourceAttributes,
          dataPoint,
          server,
          delta
        );
      }
    }
  }

  noteToolResultDuration(
    metricName: string,
    resourceAttributes: OtelAttributeMap,
    dataPoints: OtelDataPoint[],
    temporality: unknown
  ): void {
    for (const dataPoint of dataPoints ?? []) {
      const attributes = otelAttributes(dataPoint.attributes);
      const wsResolution = this.resolveDatapointWorkspace(
        attributes,
        resourceAttributes,
        datapointDiagnosticIdentity(
          "tool-result-duration",
          metricName,
          dataPoint,
          resourceAttributes
        )
      );
      const identity = toolSeriesIdentity(
        attributes,
        wsResolution.workspaceId || ""
      );
      const count = this.otelSeriesDelta(
        otelSeriesKey(
          `${metricName}#count`,
          identity,
          dataPoint.startTimeUnixNano
        ),
        dataPoint.timeUnixNano,
        numberAttribute({ count: dataPoint.count }, "count"),
        temporality
      );
      const sum = this.otelSeriesDelta(
        otelSeriesKey(
          `${metricName}#sum`,
          identity,
          dataPoint.startTimeUnixNano
        ),
        dataPoint.timeUnixNano,
        numberAttribute({ sum: dataPoint.sum }, "sum"),
        temporality
      );
      if (count === 0 && sum === 0) continue;
      this.telemetry.toolResults.executionDurationMs.count += count;
      this.telemetry.toolResults.executionDurationMs.sum += sum;
      const context = this.resolveTelemetryContext(
        attributes,
        resourceAttributes,
        { timeUnixNano: dataPoint.timeUnixNano }
      );
      this.noteContextDimension("tools", context, count);
    }
  }

  hookBucket(attributes: OtelAttributeMap): HookEntry {
    const hook = safeMetricLabel(attributes.hook_name, UNKNOWN_HOOK_LABEL);
    const source = safeMetricLabel(attributes.source);
    const handlerType = safeMetricLabel(attributes.handler_type, "");
    const key = hookKey(attributes);
    if (!this.telemetry.hooks.has(key))
      this.telemetry.hooks.set(key, {
        hook,
        source,
        handlerType,
        count: 0,
        byStatus: {},
        durationCount: 0,
        durationMs: 0
      });
    return this.telemetry.hooks.get(key)!;
  }

  noteHookCounter(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown,
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const identity = {
      hook_name: safeMetricLabel(attributes.hook_name, UNKNOWN_HOOK_LABEL),
      source: safeMetricLabel(attributes.source),
      handler_type: safeMetricLabel(attributes.handler_type, "")
    };
    const delta = this.otelSeriesDelta(
      otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano),
      dataPoint.timeUnixNano,
      otelSumDataPointValue(dataPoint),
      temporality
    );
    if (delta === 0) return;
    const bucket = this.hookBucket(attributes);
    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    this.noteContextDimension("hooks", context, delta);
    const status = safeMetricLabel(attributes.status);
    bucket.count += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
    const server = toolServerAttribute(attributes);
    if (server) {
      const mcp = this.mcpServer(server);
      this.noteMcpDimension(mcp, "byRole", context.role, context, "observed");
      this.noteMcpDimension(
        mcp,
        "byWorkspace",
        context.workspace,
        context,
        "observed"
      );
      this.noteMcpDimension(mcp, "byModel", context.model, context, "observed");
      this.noteMcpDimension(mcp, "byAgent", context.agent, context, "observed");
      if (context.workspace !== UNATTRIBUTED_DIMENSION) {
        this.usageTracker.workspaceBucket(
          this.usageTracker.usageTelemetry.byWorkspace,
          context.workspace
        ).mcpCapable = true;
      }
    }
  }

  noteHookDuration(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown,
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const identity = {
      hook_name: safeMetricLabel(attributes.hook_name, UNKNOWN_HOOK_LABEL),
      source: safeMetricLabel(attributes.source),
      handler_type: safeMetricLabel(attributes.handler_type, "")
    };
    const count = this.otelSeriesDelta(
      otelSeriesKey(
        `${metricName}#count`,
        identity,
        dataPoint.startTimeUnixNano
      ),
      dataPoint.timeUnixNano,
      numberAttribute({ count: dataPoint.count }, "count"),
      temporality
    );
    const sum = this.otelSeriesDelta(
      otelSeriesKey(`${metricName}#sum`, identity, dataPoint.startTimeUnixNano),
      dataPoint.timeUnixNano,
      numberAttribute({ sum: dataPoint.sum }, "sum"),
      temporality
    );
    const bucket = this.hookBucket(attributes);
    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    this.noteContextDimension("hooks", context, count);
    bucket.durationCount += count;
    bucket.durationMs += sum;
  }

  noteHookHistogramCount(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown,
    resourceAttributes: OtelAttributeMap = {}
  ): void {
    const identity = {
      hook_name: safeMetricLabel(attributes.hook_name, UNKNOWN_HOOK_LABEL),
      source: safeMetricLabel(attributes.source),
      handler_type: safeMetricLabel(attributes.handler_type, "")
    };
    const delta = this.otelSeriesDelta(
      otelSeriesKey(
        `${metricName}#count`,
        identity,
        dataPoint.startTimeUnixNano
      ),
      dataPoint.timeUnixNano,
      numberAttribute({ count: dataPoint.count }, "count"),
      temporality
    );
    if (delta === 0) return;
    const bucket = this.hookBucket(attributes);
    const context = this.resolveTelemetryContext(
      attributes,
      resourceAttributes,
      { timeUnixNano: dataPoint.timeUnixNano }
    );
    this.noteContextDimension("hooks", context, delta);
    const status = safeMetricLabel(attributes.status);
    bucket.count += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
  }

  noteThreadStarted(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown
  ): void {
    const source = safeMetricLabel(
      attributes.source ?? attributes.thread_source ?? attributes.origin
    );
    const delta = this.otelSeriesDelta(
      otelSeriesKey(metricName, { source }, dataPoint.startTimeUnixNano),
      dataPoint.timeUnixNano,
      otelSumDataPointValue(dataPoint),
      temporality
    );
    this.telemetry.threads.started.total += delta;
    this.telemetry.threads.started.bySource[source] =
      (this.telemetry.threads.started.bySource[source] ?? 0) + delta;
  }

  noteHistogramCount(
    target: { total: number; bySource: Record<string, number> },
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown
  ): void {
    const source = safeMetricLabel(
      attributes.source ?? attributes.thread_source ?? attributes.origin
    );
    const delta = this.otelSeriesDelta(
      otelSeriesKey(
        `${metricName}#count`,
        { source },
        dataPoint.startTimeUnixNano
      ),
      dataPoint.timeUnixNano,
      numberAttribute({ count: dataPoint.count }, "count"),
      temporality
    );
    target.total += delta;
    target.bySource[source] = (target.bySource[source] ?? 0) + delta;
  }

  noteThreadSpawn(
    metricName: string,
    attributes: OtelAttributeMap,
    dataPoint: OtelDataPoint,
    temporality: unknown
  ): void {
    const role = safeMetricLabel(attributes.agent_role ?? attributes.role);
    const model = safeMetricLabel(
      attributes.requested_model ?? attributes.model
    );
    const identity = { agent_role: role, requested_model: model };
    const delta = this.otelSeriesDelta(
      otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano),
      dataPoint.timeUnixNano,
      otelSumDataPointValue(dataPoint),
      temporality
    );
    if (delta === 0) return;
    const status = safeMetricLabel(attributes.status ?? attributes.spawned);
    const spawns = this.telemetry.threads.spawns;
    spawns.total += delta;
    spawns.byStatus[status] = (spawns.byStatus[status] ?? 0) + delta;
    spawns.byRole[role] = (spawns.byRole[role] ?? 0) + delta;
    spawns.byModel[model] = (spawns.byModel[model] ?? 0) + delta;
  }
  private dispatchSkillTurnHistogram(metric: OtelMetric): void {
    const name = metric.name ?? "";
    const histKey = SKILL_TURN_HISTOGRAMS[name]!;
    const bucket = this.telemetry.skills.turnDuration[histKey];
    const temporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      this.noteThreadSkillsHistogram(
        bucket,
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality
      );
    }
  }

  private dispatchThreadSkillsHistogram(metric: OtelMetric): void {
    const name = metric.name ?? "";
    const histKey = THREAD_SKILLS_HISTOGRAMS[name]!;
    const bucket = this.telemetry.skills.threads[histKey];
    const temporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      this.noteThreadSkillsHistogram(
        bucket,
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality
      );
    }
  }

  private dispatchSqliteCounter(metric: OtelMetric): void {
    const name = metric.name ?? "";
    const collection = name.endsWith("fallback.count")
      ? this.telemetry.sqlite.fallbacks
      : this.telemetry.sqlite.init;
    const temporality = metric.sum?.aggregationTemporality;
    for (const dataPoint of metric.sum?.dataPoints ?? []) {
      this.noteSqliteCounter(
        collection,
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality
      );
    }
  }

  private dispatchSqliteInitDuration(metric: OtelMetric): void {
    const temporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      const attributes = otelAttributes(dataPoint.attributes);
      const identity = {
        db: safeMetricLabel(attributes.db),
        status: safeMetricLabel(attributes.status)
      };
      const count = this.otelSeriesDelta(
        otelSeriesKey(
          `${metric.name}#count`,
          identity,
          dataPoint.startTimeUnixNano
        ),
        dataPoint.timeUnixNano,
        numberAttribute({ count: dataPoint.count }, "count"),
        temporality
      );
      const sum = this.otelSeriesDelta(
        otelSeriesKey(
          `${metric.name}#sum`,
          identity,
          dataPoint.startTimeUnixNano
        ),
        dataPoint.timeUnixNano,
        numberAttribute({ sum: dataPoint.sum }, "sum"),
        temporality
      );
      const bucket = this.sqliteDurationBucket(attributes);
      bucket.count += count;
      bucket.sum += sum;
    }
  }

  private dispatchToolCall(
    metric: OtelMetric,
    resourceAttributes: OtelAttributeMap
  ): void {
    const temporality = metric.sum?.aggregationTemporality;
    for (const dataPoint of metric.sum?.dataPoints ?? []) {
      this.noteToolCounter(
        metric.name ?? "",
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality,
        resourceAttributes
      );
    }
  }

  private dispatchToolResult(metric: OtelMetric, resourceAttributes: OtelAttributeMap): void {
    const name = metric.name ?? "";
    this.noteToolResultCounter(
      name,
      resourceAttributes,
      metric.sum?.dataPoints ?? [],
      metric.sum?.aggregationTemporality
    );
    const histogramTemporality = metric.histogram?.aggregationTemporality;
    if (metric.histogram?.dataPoints?.length) {
      this.noteToolResultDuration(
        name,
        resourceAttributes,
        metric.histogram.dataPoints,
        histogramTemporality
      );
    }
  }

  private dispatchToolCallDuration(
    metric: OtelMetric,
    resourceAttributes: OtelAttributeMap
  ): void {
    const temporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      this.noteToolDuration(
        metric.name ?? "",
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality,
        resourceAttributes
      );
    }
  }

  private dispatchHooksRun(
    metric: OtelMetric,
    resourceAttributes: OtelAttributeMap
  ): void {
    const name = metric.name ?? "";
    const temporality = metric.sum?.aggregationTemporality;
    for (const dataPoint of metric.sum?.dataPoints ?? []) {
      this.noteHookCounter(
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality,
        resourceAttributes
      );
    }
    const histogramTemporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      this.noteHookHistogramCount(
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        histogramTemporality,
        resourceAttributes
      );
    }
  }

  private dispatchHooksRunDuration(
    metric: OtelMetric,
    resourceAttributes: OtelAttributeMap
  ): void {
    const temporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      this.noteHookDuration(
        metric.name ?? "",
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality,
        resourceAttributes
      );
    }
  }

  private dispatchThreadStarted(metric: OtelMetric): void {
    const name = metric.name ?? "";
    const temporality = metric.sum?.aggregationTemporality;
    for (const dataPoint of metric.sum?.dataPoints ?? []) {
      this.noteThreadStarted(
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality
      );
    }
    const histogramTemporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      this.noteHistogramCount(
        this.telemetry.threads.started,
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        histogramTemporality
      );
    }
  }

  private dispatchMultiAgentSpawn(metric: OtelMetric): void {
    const name = metric.name ?? "";
    const temporality = metric.sum?.aggregationTemporality;
    for (const dataPoint of metric.sum?.dataPoints ?? []) {
      this.noteThreadSpawn(
        name,
        otelAttributes(dataPoint.attributes),
        dataPoint,
        temporality
      );
    }
    const histogramTemporality = metric.histogram?.aggregationTemporality;
    for (const dataPoint of metric.histogram?.dataPoints ?? []) {
      this.noteThreadSpawn(
        name,
        otelAttributes(dataPoint.attributes),
        { ...dataPoint, asInt: dataPoint.count } as OtelDataPoint,
        histogramTemporality
      );
    }
  }

  private dispatchOtelMetric(
    metric: OtelMetric,
    resourceAttributes: OtelAttributeMap
  ): void {
    const name = metric.name;
    if (name && SKILL_TURN_HISTOGRAMS[name]) {
      this.dispatchSkillTurnHistogram(metric);
      return;
    }
    if (name && THREAD_SKILLS_HISTOGRAMS[name]) {
      this.dispatchThreadSkillsHistogram(metric);
      return;
    }
    if (name === "codex.sqlite.init.count" || name === "codex.sqlite.fallback.count") {
      this.dispatchSqliteCounter(metric);
      return;
    }
    if (name === "codex.sqlite.init.duration_ms") {
      this.dispatchSqliteInitDuration(metric);
      return;
    }
    if (name === "codex.tool.call") {
      this.dispatchToolCall(metric, resourceAttributes);
      return;
    }
    if (name === "codex.tool_result") {
      this.dispatchToolResult(metric, resourceAttributes);
      return;
    }
    if (name === "codex.tool.call.duration_ms") {
      this.dispatchToolCallDuration(metric, resourceAttributes);
      return;
    }
    if (name === "codex.hooks.run") {
      this.dispatchHooksRun(metric, resourceAttributes);
      return;
    }
    if (name === "codex.hooks.run.duration_ms") {
      this.dispatchHooksRunDuration(metric, resourceAttributes);
      return;
    }
    if (name === "codex.thread.started") {
      this.dispatchThreadStarted(metric);
      return;
    }
    if (name === "codex.multi_agent.spawn") {
      this.dispatchMultiAgentSpawn(metric);
    }
  }

  ingestOtelMetrics(payload: OtelPayload): void {
    for (const resourceMetric of payload?.resourceMetrics ?? []) {
      for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
        for (const metric of scopeMetric.metrics ?? []) {
          if (REMOVED_SHADOW_SELECTION_METRICS.has(metric.name)) continue;
          this.noteMetricInventory(metric);
          this.dispatchOtelMetric(
            metric,
            otelAttributes(resourceMetric.resource?.attributes)
          );
        }
      }
    }
  }

  ingestOtelSignal(signal: OtelSignal, payload: OtelPayload): void {
    if (this.telemetry.receiver[signal] !== undefined) {
      this.telemetry.receiver[signal] += 1;
    }
    this.telemetry.receiver.lastReceivedAt = new Date().toISOString();
    let ingestPayload = payload;
    if (isAutodevAttributesEnabled()) {
      const enriched = autodevEnrichOtlpPayload(signal, payload);
      if (enriched) ingestPayload = enriched;
    }
    if (signal === "logs") this.ingestOtelLogs(ingestPayload);
    if (signal === "traces") this.ingestOtelTraces(ingestPayload);
    if (signal === "metrics") this.ingestOtelMetrics(ingestPayload);
    this.onSchedulePersist?.();
  }

  private bridgeToolObservationStatus(event: BridgeObservationEventInput): string {
    if (event.type === "tool_unavailable") return "unavailable";
    if (event.status === "error" || event.status === "failure") return "error";
    if (event.status === "ok" || event.status === "success") return "ok";
    return "unknown";
  }

  private bridgeToolBucketFor(eventType: unknown): BridgeToolBucket {
    if (eventType === "tool_executed") return this.telemetry.bridgeEvents.toolExecuted;
    if (eventType === "tool_requested") return this.telemetry.bridgeEvents.toolRequested;
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
    wsBucket.toolsCapable = true;
    wsBucket.toolsExecuted = (wsBucket.toolsExecuted ?? 0) + 1;
    const toolBucket = wsBucket.bridgeObservations.tools.get(tool) ?? {
      tool,
      server: server ?? "",
      count: 0,
      byStatus: {}
    };
    toolBucket.count += 1;
    if (server && !toolBucket.server) toolBucket.server = server;
    toolBucket.byStatus[statusKey] =
      (toolBucket.byStatus[statusKey] ?? 0) + 1;
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

  private noteBridgeToolMcpObservation(
    server: string,
    ctx: TelemetryContext,
    eventType: unknown
  ): void {
    const mcp = this.mcpServer(server);
    this.noteMcpDimension(mcp, "byRole", ctx.role, ctx, "observed");
    this.noteMcpDimension(mcp, "byWorkspace", ctx.workspace, ctx, "observed");
    this.noteMcpDimension(mcp, "byModel", ctx.model, ctx, "observed");
    this.noteMcpDimension(mcp, "byAgent", ctx.agent, ctx, "observed");
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
    const eventMap = event as unknown as OtelAttributeMap;
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
    const ctx = this.resolveTelemetryContext(eventMap, {}, { context });
    this.noteContextDimension("bridge", ctx);
    if (server) {
      this.noteBridgeToolMcpObservation(server, ctx, event.type);
    }
    const toolBucketKey = callId ? `${tool}::${callId}` : tool;
    this.incrementBridgeToolRow(bucket, toolBucketKey, tool, server, callId, status);
    if (workspaceKey) {
      this.incrementBridgeWorkspaceRow(bucket, workspaceKey, tool, server, status);
    }
    if (event.type === "tool_unavailable") {
      this.accumulateBridgeUnavailableReason(bucket, event.reason);
    }
    if (workspaceKey && event.type === "tool_executed") {
      this.accumulateWorkspaceBridgeObservation(workspaceKey, tool, server, status);
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
    const contextMap = context as unknown as OtelAttributeMap;
    const mcpContext = this.resolveTelemetryContext({}, {}, { context: contextMap });
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
      server: event?.server,
      source: event?.source,
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
  }): void {
    const eventMap = event as unknown as OtelAttributeMap;
    const skill =
      typeof event.skill === "string" && event.skill.trim()
        ? safeMetricLabel(event.skill)
        : null;
    if (!skill) return;
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
    const skillContext = this.resolveTelemetryContext(eventMap, {}, { context });
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
  }

  recordBridgeSkillUsed({
    event,
    context
  }: {
    event: BridgeObservationEventInput;
    context: BridgeObservationContextInput;
  }): boolean {
    const eventMap = event as unknown as OtelAttributeMap;
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
    const ctx = this.resolveTelemetryContext(eventMap, {}, { context });
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
    return true;
  }

  resetOtelTelemetry(): void {
    this.telemetry.receiver = {
      logs: 0,
      traces: 0,
      metrics: 0,
      invalid: 0,
      lastReceivedAt: null
    };
    this.telemetry.sessions.clear();
    this.telemetry.mcpServers.clear();
    this.telemetry.recordIdentities.logs.clear();
    this.telemetry.recordIdentities.spans.clear();
    this.telemetry.recordIdentities.datapoints.clear();
    this.pendingMcpModelAttribution.clear();
    this.telemetry.dimensions = {
      mcp: emptyContextDimensions(),
      tools: emptyContextDimensions(),
      hooks: emptyContextDimensions(),
      skills: emptyContextDimensions(),
      bridge: emptyContextDimensions()
    };
    this.telemetry.turns = {
      prompts: 0,
      completed: 0,
      promptLength: 0,
      ttftMs: 0,
      ttftCount: 0
    };
    this.telemetry.tokens = {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      tool: 0
    };
    this.telemetry.metricInventory.clear();
    this.telemetry.tools.clear();
    this.telemetry.hooks.clear();
    this.telemetry.threads = {
      started: { total: 0, bySource: {} },
      spawns: { total: 0, byStatus: {}, byRole: {}, byModel: {} }
    };
    this.telemetry.sqlite = {
      init: new Map(),
      initDurationMs: new Map(),
      fallbacks: new Map()
    };
    this.telemetry.skills.injected = {
      total: 0,
      byStatus: {},
      byInvokeType: {},
      byAgentKind: {},
      byModel: {},
      byPlugin: {},
      bySkill: new Map()
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
    this.telemetry.skills.turnDuration = {
      durationSeconds: { count: 0, sum: 0 }
    };
    this.telemetry.skills.threads = {
      enabled: { count: 0, sum: 0 },
      kept: { count: 0, sum: 0 },
      truncated: { count: 0, sum: 0 },
      descriptionTruncatedChars: { count: 0, sum: 0 }
    };
    this.telemetry.toolResults = {
      total: 0,
      executed: 0,
      unattributed: 0,
      byStatus: {},
      byTool: new Map(),
      executionDurationMs: { count: 0, sum: 0 },
      causeResolved: 0,
      causeUnresolved: 0,
      seenKeys: new Set()
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
    this.metricSeries.clear();
    this.usageTracker.resetAttributionDiagnostics();
    this.usageTracker.clearWorkspaceCapabilities();
  }

  codexTelemetryStatus(now: number = Date.now()): Record<string, unknown> {
    const mcpModelView = this.mcpModelDimensionsView();
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
            mcpModelView.serverByModel.get(server.name) ?? server.byModel,
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
    const sessions = [...this.telemetry.sessions.values()];
    const summarizeDimension = summarizeMcpDimension(mcpServers, now, this.healthTtlMs);
    const mcpSummary: { observed: number; ready: number; error: number; stale: number; byRole?: Record<string, unknown>; byWorkspace?: Record<string, unknown>; byModel?: Record<string, unknown>; byAgent?: Record<string, unknown> } = mcpServers.reduce(
      (summary, server) => {
        summary.observed += 1;
        if (server.health === "ready") summary.ready += 1;
        if (server.health === "error") summary.error += 1;
        if (server.health === "stale") summary.stale += 1;
        return summary;
      },
      { observed: 0, ready: 0, error: 0, stale: 0 }
    );
    mcpSummary.byRole = summarizeDimension("byRole");
    mcpSummary.byWorkspace = summarizeDimension("byWorkspace");
    mcpSummary.byModel = summarizeDimension("byModel");
    mcpSummary.byAgent = summarizeDimension("byAgent");
    const skillsInjected = this.telemetry.skills.injected;
    const globalSkillInvokeTypes = Object.entries(skillsInjected.byInvokeType);
    const skillRows = Array.from(skillsInjected.bySkill.values(), (bucket) => {
      const byInvokeType = { ...bucket.byInvokeType };
      if (
        Object.keys(byInvokeType).length === 0 &&
        globalSkillInvokeTypes.length === 1
      ) {
        const first = globalSkillInvokeTypes[0];
        if (first && first[1] === skillsInjected.total) {
          byInvokeType[first[0]] = bucket.total;
        }
      }
      return {
        ...bucket,
        byStatus: { ...bucket.byStatus },
        byInvokeType,
        byAgentKind: { ...bucket.byAgentKind },
        byModel: { ...bucket.byModel },
        byPlugin: { ...bucket.byPlugin }
      };
    });
    const threadHistogram = threadHistogramView;
    const sqliteBuckets = sqliteBucketsView;

    const dimensions = formatContextDimensions(this.telemetry.dimensions);
    if (dimensions.mcp) {
      dimensions.mcp.byModel = mcpModelView.dimensionByModel;
    }

    return {
      receiver: { ...this.telemetry.receiver },
      sessionsObserved: sessions.length,
      sessionsRecent: sessions.filter(
        (session) =>
          session.lastSeenAt &&
          now - Date.parse(session.lastSeenAt) <= this.healthTtlMs
      ).length,
      turns: {
        ...this.telemetry.turns,
        averageTtftMs: this.telemetry.turns.ttftCount
          ? Math.round(
              this.telemetry.turns.ttftMs / this.telemetry.turns.ttftCount
            )
          : 0
      },
      tokens: {
        ...this.telemetry.tokens,
        total: Object.values(this.telemetry.tokens).reduce(
          (sum, value) => sum + value,
          0
        )
      },
      mcpSummary,
      mcpServers,
      dimensions,
      metrics: {
        observed: [...this.telemetry.metricInventory.values()].sort((a, b) =>
          STRING_COLLATOR.compare(a.name, b.name)
        )
      },
      tools: {
        byTool: Array.from(this.telemetry.tools.values(), (tool) => ({
          ...tool,
          averageDurationMs: tool.durationCount
            ? tool.durationMs / tool.durationCount
            : 0,
          byStatus: { ...tool.byStatus }
        })).sort((a, b) =>
          STRING_COLLATOR.compare(
            `${a.tool}/${a.source}/${a.server}`,
            `${b.tool}/${b.source}/${b.server}`
          )
        )
      },
      hooks: {
        byHook: Array.from(this.telemetry.hooks.values(), (hook) => ({
          ...hook,
          averageDurationMs: hook.durationCount
            ? hook.durationMs / hook.durationCount
            : 0,
          byStatus: { ...hook.byStatus }
        })).sort((a, b) =>
          STRING_COLLATOR.compare(
            `${a.hook}/${a.source}/${a.handlerType}`,
            `${b.hook}/${b.source}/${b.handlerType}`
          )
        )
      },
      threads: {
        started: {
          total: this.telemetry.threads.started.total,
          bySource: { ...this.telemetry.threads.started.bySource }
        },
        spawns: {
          ...this.telemetry.threads.spawns,
          byStatus: { ...this.telemetry.threads.spawns.byStatus },
          byRole: { ...this.telemetry.threads.spawns.byRole },
          byModel: { ...this.telemetry.threads.spawns.byModel }
        }
      },
      sqlite: {
        init: {
          byDbStatus: sqliteBuckets(this.telemetry.sqlite.init),
          total: [...this.telemetry.sqlite.init.values()].reduce(
            (sum, bucket) => sum + bucket.count,
            0
          )
        },
        initDurationMs: {
          byDbStatus: sqliteBuckets(this.telemetry.sqlite.initDurationMs),
          totalCount: [...this.telemetry.sqlite.initDurationMs.values()].reduce(
            (sum, bucket) => sum + bucket.count,
            0
          ),
          totalSum: [...this.telemetry.sqlite.initDurationMs.values()].reduce(
            (sum, bucket) => sum + bucket.sum,
            0
          )
        },
        fallbacks: {
          byDbStatus: sqliteBuckets(this.telemetry.sqlite.fallbacks),
          total: [...this.telemetry.sqlite.fallbacks.values()].reduce(
            (sum, bucket) => sum + bucket.count,
            0
          )
        }
      },
      skills: {
        used: {
          total: this.telemetry.skills.used.total,
          lastSeenAt: this.telemetry.skills.used.lastSeenAt,
          byRole: { ...this.telemetry.skills.used.byRole },
          byWorkspace: { ...this.telemetry.skills.used.byWorkspace },
          byModel: { ...this.telemetry.skills.used.byModel },
          byAgent: { ...this.telemetry.skills.used.byAgent },
          bySkill: Array.from(
            this.telemetry.skills.used.bySkill.values(),
            (entry) => ({
              ...entry,
              byRole: { ...entry.byRole },
              byWorkspace: { ...entry.byWorkspace },
              byModel: { ...entry.byModel },
              byAgent: { ...entry.byAgent }
            })
          ).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill))
        },
        injected: {
          total: skillsInjected.total,
          byStatus: { ...skillsInjected.byStatus },
          byInvokeType: { ...skillsInjected.byInvokeType },
          byAgentKind: { ...skillsInjected.byAgentKind },
          byModel: { ...skillsInjected.byModel },
          byPlugin: { ...skillsInjected.byPlugin },
          bySkill: skillRows.sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill))
        },
        turnDuration: {
          durationSeconds: threadHistogram(
            this.telemetry.skills.turnDuration.durationSeconds
          )
        },
        threads: {
          enabledTotal: threadHistogram(this.telemetry.skills.threads.enabled),
          keptTotal: threadHistogram(this.telemetry.skills.threads.kept),
          truncated: threadHistogram(this.telemetry.skills.threads.truncated),
          descriptionTruncatedChars: threadHistogram(
            this.telemetry.skills.threads.descriptionTruncatedChars
          )
        }
      },
      toolResults: formatToolResults(this.telemetry.toolResults),
      bridgeEvents: formatBridgeEvents(this.telemetry.bridgeEvents)
    };
  }

  otelPersistenceSnapshot(): OtelRestoreSnapshot | Record<string, unknown> {
    const telemetry = this.codexTelemetryStatus();
    const mcpModelView = this.mcpModelDimensionsView();
    const dimensions = formatContextDimensions(this.telemetry.dimensions);
    if (dimensions.mcp) {
      dimensions.mcp.byModel = mcpModelView.dimensionByModel;
    }
    return {
      schemaVersion: OTEL_PERSISTENCE_SCHEMA_VERSION,
      receiver: telemetry.receiver,
      turns: telemetry.turns,
      tokens: telemetry.tokens,
      dimensions,
      mcpServers: Array.from(this.telemetry.mcpServers.values(), (server) => ({
        ...server,
        byRole: { ...server.byRole },
        byWorkspace: { ...server.byWorkspace },
        byModel: {
          ...(mcpModelView.serverByModel.get(server.name) ?? server.byModel)
        },
        byAgent: { ...server.byAgent }
      })),
      skills: telemetry.skills,
      metrics: telemetry.metrics,
      tools: telemetry.tools,
      hooks: telemetry.hooks,
      threads: telemetry.threads,
      sqlite: telemetry.sqlite,
      toolResults: telemetry.toolResults,
      bridgeEvents: telemetry.bridgeEvents,
      series: Array.from(this.metricSeries.entries(), ([key, value]) => ({
        key,
        timestamp: value.timestamp.toString(),
        value: value.value
      }))
    };
  }

  restoreOtelCounters(snapshot: OtelRestoreSnapshot): void {
    if (!snapshot || typeof snapshot !== "object") return;
    if (snapshot.toolResults && typeof snapshot.toolResults === "object") {
      this.restoreToolResultsCounters(snapshot.toolResults);
    }
    if (snapshot.bridgeEvents && typeof snapshot.bridgeEvents === "object") {
      const families: Array<keyof BridgeEventsState> = [
        "toolExecuted",
        "toolRequested",
        "toolUnavailable",
        "skillExposed",
        "skillUsed",
        "mcpExposed"
      ];
      for (const family of families) {
        const source = snapshot.bridgeEvents[family];
        if (source && typeof source === "object") {
          this.restoreBridgeFamily(
            family,
            source as unknown as Record<string, unknown>
          );
        }
      }
    }
  }

  private restoreToolResultsCounters(
    source: Record<string, unknown>
  ): void {
    const target = this.telemetry.toolResults;
    for (const field of [
      "total",
      "executed",
      "unattributed",
      "causeResolved",
      "causeUnresolved"
    ] as const) {
      const value = source[field as string];
      if (typeof value === "number" && value >= 0) {
        target[field] = value;
      }
    }
    const byStatus = source.byStatus;
    if (byStatus && typeof byStatus === "object") {
      for (const [k, v] of Object.entries(byStatus)) {
        if (typeof v === "number" && v >= 0) {
          target.byStatus[safeMetricLabel(k)] = v;
        }
      }
    }
    const exec = source.executionDurationMs as
      | { count?: unknown; sum?: unknown }
      | undefined;
    if (exec && typeof exec === "object") {
      if (typeof exec.count === "number" && exec.count >= 0) {
        target.executionDurationMs.count = exec.count;
      }
      if (typeof exec.sum === "number" && exec.sum >= 0) {
        target.executionDurationMs.sum = exec.sum;
      }
    }
  }

  private restoreSkillUsedEntries(
    source: { bySkill?: Array<Record<string, unknown>> }
  ): void {
    const destination = this.telemetry.bridgeEvents.skillUsed;
    for (const entry of source.bySkill ?? []) {
      if (
        !entry ||
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

  private buildSkillWorkspaceMap(
    row: { bySkill?: Array<Record<string, unknown>> }
  ): Map<string, number> {
    const entries = (row.bySkill ?? []).filter(
      (entry): entry is { skill: string; count: number } =>
        !!entry &&
        typeof entry.skill === "string" &&
        typeof entry.count === "number"
    );
    return new Map(
      entries.map((entry) => [safeMetricLabel(entry.skill), entry.count])
    );
  }

  private restoreSkillUsedWorkspaces(
    source: { byWorkspace?: Array<Record<string, unknown>> }
  ): void {
    const destination = this.telemetry.bridgeEvents.skillUsed;
    for (const row of source.byWorkspace ?? []) {
      if (
        !row ||
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

  private restoreMcpExposedServers(
    source: { byServer?: Array<Record<string, unknown>> }
  ): void {
    const destination = this.telemetry.bridgeEvents.mcpExposed;
    for (const entry of source.byServer ?? []) {
      if (
        !entry ||
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

  private buildMcpWorkspaceMap(
    row: { byServer?: Array<Record<string, unknown>> }
  ): Map<string, number> {
    const entries = (row.byServer ?? []).filter(
      (entry): entry is { server: string; count: number } =>
        !!entry &&
        typeof entry.server === "string" &&
        typeof entry.count === "number"
    );
    return new Map(
      entries.map((entry) => [safeMetricLabel(entry.server), entry.count])
    );
  }

  private restoreMcpExposedWorkspaces(
    source: { byWorkspace?: Array<Record<string, unknown>> }
  ): void {
    const destination = this.telemetry.bridgeEvents.mcpExposed;
    for (const row of source.byWorkspace ?? []) {
      if (
        !row ||
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

  private restoreBridgeFamilyReasons(
    source: { byReason?: Record<string, unknown> } | undefined,
    destination: { byReason?: Record<string, number> }
  ): void {
    if (!source?.byReason || typeof source.byReason !== "object") return;
    destination.byReason = destination.byReason ?? {};
    for (const [k, v] of Object.entries(source.byReason)) {
      if (typeof v === "number" && v >= 0) {
        destination.byReason[safeMetricLabel(k)] = v;
      }
    }
  }

  private restoreBridgeFamily(
    family: keyof BridgeEventsState,
    source: Record<string, unknown>
  ): void {
    const destination = this.telemetry.bridgeEvents[family] as unknown as {
      total: number;
      byReason?: Record<string, number>;
    };
    if (!source || typeof source !== "object") return;
    if (typeof source.total === "number" && source.total >= 0) {
      destination.total = source.total;
    }
    if (family === "skillUsed") {
      this.restoreSkillUsedEntries(source);
      this.restoreSkillUsedWorkspaces(source);
    } else if (family === "mcpExposed") {
      this.restoreMcpExposedServers(source);
      this.restoreMcpExposedWorkspaces(source);
    }
    this.restoreBridgeFamilyReasons(
      source as { byReason?: Record<string, unknown> },
      destination
    );
  }

  private restoreOtelReceiver(snapshot: OtelRestoreSnapshot): void {
    restoreNumberFields(
      this.telemetry.receiver as unknown as Record<string, unknown>,
      snapshot.receiver,
      ["logs", "traces", "metrics", "invalid"]
    );
    if (
      snapshot.receiver?.lastReceivedAt === null ||
      typeof snapshot.receiver?.lastReceivedAt === "string"
    ) {
      this.telemetry.receiver.lastReceivedAt = snapshot.receiver.lastReceivedAt;
    }
  }

  private restoreOtelTurns(snapshot: OtelRestoreSnapshot): void {
    restoreNumberFields(
      this.telemetry.turns as unknown as Record<string, unknown>,
      snapshot.turns,
      ["prompts", "completed", "promptLength", "ttftMs", "ttftCount"]
    );
  }

  private restoreOtelTokens(snapshot: OtelRestoreSnapshot): void {
    restoreNumberFields(
      this.telemetry.tokens as unknown as Record<string, unknown>,
      snapshot.tokens,
      ["input", "output", "cached", "reasoning", "tool"]
    );
  }

  private restoreOtelDimensionBucket(
    dimension: "byRole" | "byWorkspace" | "byModel" | "byAgent",
    bucket: { count?: unknown; lastSeenAt?: unknown; agentKind?: unknown }
  ): ContextDimensionBucket {
    return {
      count: isFiniteNonnegative(bucket.count) ? bucket.count : 0,
      lastSeenAt: typeof bucket.lastSeenAt === "string" ? bucket.lastSeenAt : null,
      ...(dimension === "byAgent"
        ? {
          agentKind: safeMetricLabel(bucket.agentKind, UNATTRIBUTED_DIMENSION)
        }
        : {})
    };
  }

  private restoreOtelDimensionsFamily(
    family: keyof OtelTelemetryState["dimensions"],
    value: Record<string, unknown>
  ): void {
    if (!this.telemetry.dimensions[family] || !value || typeof value !== "object") return;
    for (const dimension of ["byRole", "byWorkspace", "byModel", "byAgent"] as const) {
      const dimMap = value[dimension] as Record<string, unknown> | undefined;
      if (!dimMap || typeof dimMap !== "object") continue;
      for (const [key, bucket] of Object.entries(dimMap)) {
        if (!bucket || typeof bucket !== "object") continue;
        const bucketEntry = bucket as { count?: unknown; lastSeenAt?: unknown; agentKind?: unknown };
        if (!isFiniteNonnegative(bucketEntry.count)) continue;
        this.telemetry.dimensions[family][dimension][safeMetricLabel(key)] =
          this.restoreOtelDimensionBucket(dimension, bucketEntry);
      }
    }
  }

  private restoreOtelDimensions(snapshot: OtelRestoreSnapshot): void {
    if (!snapshot.dimensions || typeof snapshot.dimensions !== "object") return;
    for (const [family, value] of Object.entries(
      snapshot.dimensions as Record<string, ContextDimensions>
    )) {
      this.restoreOtelDimensionsFamily(
        family as keyof OtelTelemetryState["dimensions"],
        value as unknown as Record<string, unknown>
      );
    }
  }

  private restoreOtelMcpServers(snapshot: OtelRestoreSnapshot): void {
    const servers = Array.isArray(snapshot.mcpServers) ? snapshot.mcpServers : [];
    for (const server of servers) {
      if (
        !server ||
        typeof server !== "object" ||
        typeof server.name !== "string" ||
        !server.name
      ) {
        continue;
      }
      this.restoreSingleMcpServer(server as Record<string, unknown>);
    }
  }

  private restoreMcpServerDimensionBucket(
    v: { observed?: unknown; lastSeenAt?: unknown; lastStatus?: unknown; agentKind?: unknown }
  ): McpServerDimensionBucket {
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
    if (!dimSource || typeof dimSource !== "object") return;
    for (const [k, v] of Object.entries(dimSource)) {
      if (isFiniteNonnegative(v)) {
        restored[dim][safeMetricLabel(k)] = {
          observed: 1,
          lastSeenAt: null,
          lastStatus: "observed"
        };
      } else if (v && typeof v === "object") {
        const dimBucket = v as {
          observed?: unknown;
          lastSeenAt?: unknown;
          lastStatus?: unknown;
          agentKind?: unknown;
        };
        if (!isFiniteNonnegative(dimBucket.observed)) continue;
        const restoredBucket = this.restoreMcpServerDimensionBucket(dimBucket);
        if (dim === "byAgent") {
          restoredBucket.agentKind = safeMetricLabel(dimBucket.agentKind, UNATTRIBUTED_DIMENSION);
        }
        restored[dim][safeMetricLabel(k)] = restoredBucket;
      }
    }
  }

  private restoreSingleMcpServer(server: Record<string, unknown>): void {
    const restored: McpServerEntry = {
      name: safeMetricLabel(server.name),
      lastSeenAt: typeof server.lastSeenAt === "string" ? server.lastSeenAt : null,
      initAttempts: 0,
      toolDiscoveryAttempts: 0,
      failures: 0,
      durationMs: 0,
      durationCount: 0,
      lastStatus: safeMetricLabel(server.lastStatus),
      byRole: {},
      byWorkspace: {},
      byModel: {},
      byAgent: {}
    };
    restoreNumberFields(
      restored as unknown as Record<string, unknown>,
      server,
      ["initAttempts", "toolDiscoveryAttempts", "failures", "durationMs", "durationCount"]
    );
    for (const dim of ["byRole", "byWorkspace", "byModel", "byAgent"] as const) {
      this.restoreMcpServerDimension(restored, server, dim);
    }
    this.telemetry.mcpServers.set(restored.name, restored);
  }

  private restoreSkillInjectedState(source: Record<string, unknown>): void {
    restoreNumberFields(
      this.telemetry.skills.injected as unknown as Record<string, unknown>,
      source,
      ["total"]
    );
    for (const field of ["byStatus", "byInvokeType", "byAgentKind", "byModel", "byPlugin"] as const) {
      const map = source[field] as Record<string, unknown> | undefined;
      if (!map || typeof map !== "object") continue;
      for (const [k, v] of Object.entries(map)) {
        if (isFiniteNonnegative(v)) {
          this.telemetry.skills.injected[field][safeMetricLabel(k)] = v;
        }
      }
    }
    const bySkillRows = source.bySkill;
    if (Array.isArray(bySkillRows)) {
      for (const entry of bySkillRows) {
        if (!entry || typeof entry.skill !== "string") continue;
        this.restoreSkillInjectedBucketEntry(entry as Record<string, unknown>);
      }
    }
  }

  private restoreSkillInjectedBucketEntry(entry: Record<string, unknown>): void {
    const bucket = this.skillBucket(safeMetricLabel(entry.skill));
    restoreNumberFields(
      bucket as unknown as Record<string, unknown>,
      entry,
      ["total"]
    );
    for (const field of ["byStatus", "byInvokeType", "byAgentKind", "byModel", "byPlugin"] as const) {
      const map = entry[field] as Record<string, unknown> | undefined;
      if (!map || typeof map !== "object") continue;
      for (const [k, v] of Object.entries(map)) {
        if (isFiniteNonnegative(v)) {
          bucket[field][safeMetricLabel(k)] = v;
        }
      }
    }
  }

  private restoreSkillUsedState(source: Record<string, unknown>): void {
    restoreNumberFields(
      this.telemetry.skills.used as unknown as Record<string, unknown>,
      source,
      ["total"]
    );
    if (typeof source.lastSeenAt === "string") {
      this.telemetry.skills.used.lastSeenAt = source.lastSeenAt;
    }
    for (const dimension of ["byRole", "byWorkspace", "byModel", "byAgent"] as const) {
      const map = source[dimension] as Record<string, unknown> | undefined;
      if (!map || typeof map !== "object") continue;
      for (const [k, v] of Object.entries(map)) {
        if (isFiniteNonnegative(v)) {
          this.telemetry.skills.used[dimension][safeMetricLabel(k)] = v;
        }
      }
    }
    const bySkillRows = source.bySkill;
    if (Array.isArray(bySkillRows)) {
      for (const entry of bySkillRows) {
        if (!entry || typeof entry.skill !== "string") continue;
        this.restoreSkillUsedBucketEntry(entry as Record<string, unknown>);
      }
    }
  }

  private restoreSkillUsedBucketEntry(entry: Record<string, unknown>): void {
    const bucket = this.skillUsedBucket(safeMetricLabel(entry.skill));
    restoreNumberFields(
      bucket as unknown as Record<string, unknown>,
      entry,
      ["total"]
    );
    if (typeof entry.lastSeenAt === "string") {
      bucket.lastSeenAt = entry.lastSeenAt;
    }
    for (const dimension of ["byRole", "byWorkspace", "byModel", "byAgent"] as const) {
      const map = entry[dimension] as Record<string, unknown> | undefined;
      if (!map || typeof map !== "object") continue;
      for (const [k, v] of Object.entries(map)) {
        if (isFiniteNonnegative(v)) {
          bucket[dimension][safeMetricLabel(k)] = v;
        }
      }
    }
  }

  private restoreSkillThreadHistograms(source: Record<string, unknown>): void {
    for (const [targetKey, sourceKey] of [
      ["enabled", "enabledTotal"],
      ["kept", "keptTotal"],
      ["truncated", "truncated"],
      ["descriptionTruncatedChars", "descriptionTruncatedChars"]
    ] as const) {
      restoreNumberFields(
        this.telemetry.skills.threads[targetKey] as unknown as Record<string, unknown>,
        source[sourceKey] as Record<string, unknown> | undefined,
        ["count", "sum"]
      );
    }
  }

  private restoreOtelSkills(snapshot: OtelRestoreSnapshot): void {
    const skills = snapshot.skills;
    if (skills?.injected && typeof skills.injected === "object") {
      this.restoreSkillInjectedState(skills.injected);
    }
    if (skills?.used && typeof skills.used === "object") {
      this.restoreSkillUsedState(skills.used);
    }
    if (skills?.threads) {
      this.restoreSkillThreadHistograms(skills.threads);
    }
  }

  private restoreOtelMetricInventory(snapshot: OtelRestoreSnapshot): void {
    const observed = Array.isArray(snapshot.metrics?.observed)
      ? snapshot.metrics.observed
      : [];
    for (const entry of observed) {
      if (
        !entry ||
        typeof entry.name !== "string" ||
        !entry.name ||
        REMOVED_SHADOW_SELECTION_METRICS.has(entry.name)
      ) {
        continue;
      }
      const restored = {
        name: safeMetricLabel(entry.name),
        exports: 0,
        dataPoints: 0
      };
      restoreNumberFields(restored, entry as Record<string, unknown>, ["exports", "dataPoints"]);
      this.telemetry.metricInventory.set(restored.name, restored);
    }
  }

  private restoreToolStatusMap(source: Record<string, unknown>): Record<string, number> {
    const map: Record<string, number> = {};
    const byStatus = source.byStatus;
    if (!byStatus || typeof byStatus !== "object") return map;
    for (const [status, count] of Object.entries(byStatus)) {
      if (isFiniteNonnegative(count)) {
        map[safeMetricLabel(status)] = count;
      }
    }
    return map;
  }

  private restoreSingleToolEntry(entry: Record<string, unknown>): void {
    if (entry.tool === UNKNOWN_TOOL_LABEL) return;
    const restored: ToolEntry = {
      tool: safeMetricLabel(entry.tool, UNKNOWN_TOOL_LABEL),
      source: safeMetricLabel(entry.source),
      server: toolServerAttribute({
        server: entry.server,
        mcp_server: entry.mcp_server
      }),
      count: 0,
      byStatus: {},
      durationCount: 0,
      durationMs: 0
    };
    restoreNumberFields(
      restored as unknown as Record<string, unknown>,
      entry,
      ["count", "durationCount", "durationMs"]
    );
    restored.byStatus = this.restoreToolStatusMap(entry);
    this.telemetry.tools.set(toolKey(restored), restored);
  }

  private restoreOtelTools(snapshot: OtelRestoreSnapshot): void {
    const byTool = Array.isArray(snapshot.tools?.byTool) ? snapshot.tools.byTool : [];
    for (const entry of byTool) {
      if (!entry || typeof entry.tool !== "string") continue;
      this.restoreSingleToolEntry(entry as Record<string, unknown>);
    }
  }

  private restoreSingleHookEntry(entry: Record<string, unknown>): void {
    const restored: HookEntry = {
      hook: safeMetricLabel(entry.hook, UNKNOWN_HOOK_LABEL),
      source: safeMetricLabel(entry.source),
      handlerType: safeMetricLabel(entry.handlerType, ""),
      count: 0,
      byStatus: {},
      durationCount: 0,
      durationMs: 0
    };
    restoreNumberFields(
      restored as unknown as Record<string, unknown>,
      entry,
      ["count", "durationCount", "durationMs"]
    );
    restored.byStatus = this.restoreToolStatusMap(entry);
    this.telemetry.hooks.set(
      hookKey({
        hook_name: restored.hook,
        source: restored.source,
        handler_type: restored.handlerType
      }),
      restored
    );
  }

  private restoreOtelHooks(snapshot: OtelRestoreSnapshot): void {
    const byHook = Array.isArray(snapshot.hooks?.byHook) ? snapshot.hooks.byHook : [];
    for (const entry of byHook) {
      if (!entry || typeof entry.hook !== "string") continue;
      this.restoreSingleHookEntry(entry as Record<string, unknown>);
    }
  }

  private restoreThreadStartedState(source: Record<string, unknown> | undefined): void {
    restoreNumberFields(
      this.telemetry.threads.started as unknown as Record<string, unknown>,
      source,
      ["total"]
    );
    const startedBySource = source?.bySource;
    if (!startedBySource || typeof startedBySource !== "object") return;
    for (const [srcKey, count] of Object.entries(startedBySource)) {
      if (isFiniteNonnegative(count)) {
        this.telemetry.threads.started.bySource[safeMetricLabel(srcKey)] = count;
      }
    }
  }

  private restoreThreadSpawnsState(source: Record<string, unknown> | undefined): void {
    restoreNumberFields(
      this.telemetry.threads.spawns as unknown as Record<string, unknown>,
      source,
      ["total"]
    );
    for (const target of ["byStatus", "byRole", "byModel"] as const) {
      const map = source?.[target] as Record<string, unknown> | undefined;
      if (!map || typeof map !== "object") continue;
      for (const [key, count] of Object.entries(map)) {
        if (isFiniteNonnegative(count)) {
          this.telemetry.threads.spawns[target][safeMetricLabel(key)] = count;
        }
      }
    }
  }

  private restoreOtelThreads(snapshot: OtelRestoreSnapshot): void {
    this.restoreThreadStartedState(snapshot.threads?.started);
    this.restoreThreadSpawnsState(snapshot.threads?.spawns);
  }

  private restoreSqliteEntry(source: Record<string, unknown>): SqliteEntry | SqliteDurationEntry | null {
    if (typeof source.db !== "string" || typeof source.status !== "string") return null;
    const baseKey: SqliteEntry = {
      db: safeMetricLabel(source.db),
      status: safeMetricLabel(source.status),
      count: 0
    };
    restoreNumberFields(
      baseKey as unknown as Record<string, unknown>,
      source,
      ["count"]
    );
    if (Object.hasOwn(source, "sum")) {
      const restored = { ...baseKey, sum: 0 } as SqliteDurationEntry;
      restoreNumberFields(
        restored as unknown as Record<string, unknown>,
        source,
        ["sum"]
      );
      return restored;
    }
    return baseKey;
  }

  private restoreOtelSqlite(snapshot: OtelRestoreSnapshot): void {
    const sqlite = snapshot.sqlite;
    const collections = [
      [this.telemetry.sqlite.init, sqlite?.init?.byDbStatus],
      [this.telemetry.sqlite.fallbacks, sqlite?.fallbacks?.byDbStatus],
      [this.telemetry.sqlite.initDurationMs, sqlite?.initDurationMs?.byDbStatus]
    ] as const;
    for (const [target, source] of collections) {
      const rows = Array.isArray(source) ? source : [];
      for (const entry of rows) {
        if (!entry || typeof entry !== "object") continue;
        const restored = this.restoreSqliteEntry(entry as Record<string, unknown>);
        if (restored) {
          target.set(sqliteKey(restored as unknown as OtelAttributeMap), restored);
        }
      }
    }
  }

  private restoreOtelSeries(snapshot: OtelRestoreSnapshot): void {
    const series = Array.isArray(snapshot.series) ? snapshot.series : [];
    for (const entry of series) {
      if (
        !entry ||
        typeof entry.key !== "string" ||
        typeof entry.timestamp !== "string" ||
        !isFiniteNonnegative(entry.value)
      ) {
        continue;
      }
      const headEnd = entry.key.indexOf("::");
      const head = headEnd === -1 ? entry.key : entry.key.slice(0, headEnd);
      const metricName = head.replace(METRIC_NAME_TRAILING_PARTS_PATTERN, "");
      if (REMOVED_SHADOW_SELECTION_METRICS.has(metricName)) continue;
      try {
        this.metricSeries.set(entry.key, {
          timestamp: BigInt(entry.timestamp),
          value: entry.value
        });
      } catch {
        /* Ignore malformed cursors. */
      }
    }
  }

  restoreOtelTelemetry(snapshot: OtelRestoreSnapshot): void {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      snapshot.schemaVersion !== OTEL_PERSISTENCE_SCHEMA_VERSION
    ) {
      return;
    }
    this.restoreOtelCounters(snapshot);
    this.restoreOtelReceiver(snapshot);
    this.restoreOtelTurns(snapshot);
    this.restoreOtelTokens(snapshot);
    this.restoreOtelDimensions(snapshot);
    this.restoreOtelMcpServers(snapshot);
    this.restoreOtelSkills(snapshot);
    this.restoreOtelMetricInventory(snapshot);
    this.restoreOtelTools(snapshot);
    this.restoreOtelHooks(snapshot);
    this.restoreOtelThreads(snapshot);
    this.restoreOtelSqlite(snapshot);
    this.restoreOtelSeries(snapshot);
  }

}

let defaultOtelTracker = new OtelTracker();

export function getDefaultOtelTracker(): OtelTracker {
  return defaultOtelTracker;
}

export function setDefaultOtelTracker(tracker: OtelTracker): void {
  defaultOtelTracker = tracker;
}

export const otelTelemetry: OtelTelemetryState = new Proxy(
  {} as OtelTelemetryState,
  {
    get(_target, prop) {
      return (defaultOtelTracker.telemetry as unknown as Record<string | symbol, unknown>)[prop as string];
    },
    set(_target, prop, value) {
      (defaultOtelTracker.telemetry as unknown as Record<string | symbol, unknown>)[prop as string] = value;
      return true;
    },
    has(_target, prop) {
      return prop in defaultOtelTracker.telemetry;
    },
    ownKeys(_target) {
      return Reflect.ownKeys(defaultOtelTracker.telemetry);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return (
        Object.getOwnPropertyDescriptor(defaultOtelTracker.telemetry, prop) ?? {
          configurable: true,
          enumerable: true,
          writable: true,
          value: (defaultOtelTracker.telemetry as unknown as Record<string | symbol, unknown>)[prop as string]
        }
      );
    }
  }
);

export const otelMetricSeries: Map<
  string,
  { timestamp: bigint; value: number }
> = new Proxy(new Map(), {
  get(_target, prop) {
    const val = (defaultOtelTracker.metricSeries as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof val === "function"
      ? val.bind(defaultOtelTracker.metricSeries)
      : val;
  },
  set(_target, prop, value) {
    (defaultOtelTracker.metricSeries as unknown as Record<string | symbol, unknown>)[prop as string] = value;
    return true;
  },
  has(_target, prop) {
    return prop in defaultOtelTracker.metricSeries;
  }
});

export const pendingMcpModelAttribution: Map<
  string,
  Array<{ serverName: string; context: TelemetryContext; status: string }>
> = new Proxy(new Map(), {
  get(_target, prop) {
    const val = (defaultOtelTracker.pendingMcpModelAttribution as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof val === "function"
      ? val.bind(defaultOtelTracker.pendingMcpModelAttribution)
      : val;
  },
  set(_target, prop, value) {
    (defaultOtelTracker.pendingMcpModelAttribution as unknown as Record<string | symbol, unknown>)[prop as string] = value;
    return true;
  },
  has(_target, prop) {
    return prop in defaultOtelTracker.pendingMcpModelAttribution;
  }
});

export function mcpServer(name: string): McpServerEntry {
  return defaultOtelTracker.mcpServer(name);
}

export function telemetryConversationId(
  attributes: OtelAttributeMap = {},
  resourceAttributes: OtelAttributeMap = {},
  options: { conversationId?: unknown } = {}
): string | null {
  return defaultOtelTracker.telemetryConversationId(
    attributes,
    resourceAttributes,
    options
  );
}

export function resolveTelemetryContext(
  attributes: OtelAttributeMap = {},
  resourceAttributes: OtelAttributeMap = {},
  options: ResolveTelemetryContextOptions = {}
): TelemetryContext {
  return defaultOtelTracker.resolveTelemetryContext(
    attributes,
    resourceAttributes,
    options
  );
}

export function ingestOtelLogs(payload: OtelPayload): void {
  defaultOtelTracker.ingestOtelLogs(payload);
}

export function ingestOtelTraces(payload: OtelPayload): void {
  defaultOtelTracker.ingestOtelTraces(payload);
}

export function ingestOtelMetrics(payload: OtelPayload): void {
  defaultOtelTracker.ingestOtelMetrics(payload);
}

export function ingestOtelSignal(signal: OtelSignal, payload: OtelPayload): void {
  defaultOtelTracker.ingestOtelSignal(signal, payload);
}

export function recordBridgeToolObservation({
  event,
  context
}: {
  event: BridgeObservationEventInput;
  context: BridgeObservationContextInput;
}): void {
  defaultOtelTracker.recordBridgeToolObservation({ event, context });
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
  return defaultOtelTracker.recordMcpExposure({
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
  return defaultOtelTracker.recordBridgeMcpExposure({
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
}): void {
  defaultOtelTracker.recordBridgeSkillExposure({ event, context });
}

export function recordBridgeSkillUsed({
  event,
  context
}: {
  event: BridgeObservationEventInput;
  context: BridgeObservationContextInput;
}): boolean {
  return defaultOtelTracker.recordBridgeSkillUsed({ event, context });
}

export function resetOtelTelemetry(): void {
  defaultOtelTracker.resetOtelTelemetry();
}

export function codexTelemetryStatus(now: number = Date.now()): Record<string, unknown> {
  return defaultOtelTracker.codexTelemetryStatus(now);
}

export function otelPersistenceSnapshot(): OtelRestoreSnapshot {
  return defaultOtelTracker.otelPersistenceSnapshot();
}

export function restoreOtelTelemetry(snapshot: OtelRestoreSnapshot): void {
  defaultOtelTracker.restoreOtelTelemetry(snapshot);
}

export { safeMetricLabel } from "./subagents.ts";
