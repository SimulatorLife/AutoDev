import { createHash } from 'node:crypto';
import {
  MAX_UNKNOWN_WORKSPACE_IDS,
  UNATTRIBUTED_DIMENSION,
  UsageTracker,
  extractWorkspaceIdWithAmbiguity,
  getDefaultUsageTracker,
  readNamedAttribute,
  safeAgentIdentity,
  safePrivacyWorkspace,
  safeWorkspaceId,
  toolKey,
  toolNameAttribute,
  toolServerAttribute,
} from './usage.ts';
import { safeMetricLabel } from './subagents.ts';

export { safeMetricLabel };

export const OTEL_HEALTH_TTL_MS_DEFAULT = 120_000;
export const OTEL_HEALTH_TTL_MS = Number.parseInt(process.env.CODEX_ROUTER_OTEL_HEALTH_TTL_MS ?? '120000', 10);
export const OTEL_RECORD_IDENTITY_LIMIT = 10_000;
export const PENDING_MCP_MODEL_CONVERSATION_LIMIT = 1_000;
export const PENDING_MCP_MODEL_OBSERVATION_LIMIT = 200;
export const OTEL_PERSISTENCE_SCHEMA_VERSION = 6;

export const MCP_DISCOVERY_SPAN_NAMES = new Set(['list_tools_for_client_uncached', 'list_tools_with_connector_ids']);

export const REMOVED_SHADOW_SELECTION_METRICS = new Set([
  'codex.skills.shadow_selection',
  'codex.skills.shadow_selection.invocation',
  'codex.skills.shadow_selection.catalog_entries',
  'codex.skills.shadow_selection.selected_entries',
  'codex.skills.shadow_selection.query_terms',
  'codex.skills.shadow_selection.reduction_bps',
  'codex.skills.shadow_selection.duration_ms',
]);

export const SKILL_TURN_HISTOGRAMS: Record<string, string> = {
  'codex.skill.turn.duration_seconds': 'durationSeconds',
};

export const THREAD_SKILLS_HISTOGRAMS: Record<string, string> = {
  'codex.thread.skills.enabled_total': 'enabled',
  'codex.thread.skills.kept_total': 'kept',
  'codex.thread.skills.truncated': 'truncated',
  'codex.thread.skills.description_truncated_chars': 'descriptionTruncatedChars',
};

export const AUTODEV_ATTRIBUTES_FLAG = 'AUTODEV_OTEL_ATTRIBUTES';
export const AUTODEV_ATTRIBUTES_VERSION = 'v1';
export const AUTODEV_ATTRIBUTE_VALUE_MAX_LENGTH = 64;
export const AUTODEV_RESOURCE_ROLE_ALIASES = ['role', 'agent_role', 'agent.role'];
export const AUTODEV_RESOURCE_WORKSPACE_ALIASES = ['workspace_id', 'workspace.id', 'workspaceId', 'workspace'];
export const AUTODEV_RESOURCE_PROVIDER_ALIASES = ['provider', 'provider_id', 'provider.id'];
export const AUTODEV_RESOURCE_MODEL_ALIASES = ['model', 'model_slug', 'model.slug', 'requested_model', 'requested.model'];
export const AUTODEV_SPAWN_MECHANISM_ALIASES = ['spawn_mechanism', 'spawn.mechanism'];
export const AUTODEV_SKILL_ALIASES = ['skill', 'skill_name', 'skill.name'];
export const AUTODEV_MCP_SERVER_ALIASES = ['server_name', 'serverName', 'server', 'mcp_server'];
export const AUTODEV_SPAWN_LOG_EVENTS = new Set(['codex.subagent_spawn', 'codex.subagent_spawned']);

export const OTEL_DELTA_TEMPORALITY_VALUES = new Set<unknown>([1, '1', 'AGGREGATION_TEMPORALITY_DELTA']);

export const CONTEXT_DIMENSION_FIELDS = [
  ['byRole', 'role'],
  ['byWorkspace', 'workspace'],
  ['byModel', 'model'],
  ['byAgent', 'agent'],
] as const;
export const MODEL_CONTEXT_DIMENSIONS = new Set(['byModel']);
export const NON_MODEL_CONTEXT_DIMENSIONS = new Set(['byRole', 'byWorkspace', 'byAgent']);

export type OtelSignal = 'logs' | 'traces' | 'metrics';

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
  byWorkspace: Map<string, { workspaceKey: string; count: number; bySkill: Map<string, number> }>;
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
  byWorkspace: Map<string, { workspaceKey: string; count: number; byServer: Map<string, number> }>;
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
  recordIdentities: { logs: Set<string>; spans: Set<string>; datapoints: Set<string> };
  dimensions: {
    mcp: ContextDimensions;
    tools: ContextDimensions;
    hooks: ContextDimensions;
    skills: ContextDimensions;
    bridge: ContextDimensions;
  };
  turns: { prompts: number; completed: number; promptLength: number; ttftMs: number; ttftCount: number };
  tokens: { input: number; output: number; cached: number; reasoning: number; tool: number };
  metricInventory: Map<string, MetricInventoryEntry>;
  tools: Map<string, ToolEntry>;
  hooks: Map<string, HookEntry>;
  threads: {
    started: { total: number; bySource: Record<string, number> };
    spawns: { total: number; byStatus: Record<string, number>; byRole: Record<string, number>; byModel: Record<string, number> };
  };
  sqlite: {
    init: Map<string, SqliteEntry>;
    initDurationMs: Map<string, SqliteDurationEntry>;
    fallbacks: Map<string, SqliteEntry>;
  };
  skills: {
    injected: SkillInjectedEntry;
    used: SkillUsedEntry;
    turnDuration: { durationSeconds: HistogramBucket };
    threads: {
      enabled: HistogramBucket;
      kept: HistogramBucket;
      truncated: HistogramBucket;
      descriptionTruncatedChars: HistogramBucket;
    };
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
  timestampSource: 'source' | 'ingestion';
}

export interface OtelTrackerOptions {
  healthTtlMs?: number;
  usageTracker?: UsageTracker;
  getConversationThread?: (conversationId: string) => any;
  getBridgeRequestContext?: (requestId: string) => any;
  onSchedulePersist?: () => void;
}

export function otelAttributeValue(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
  if (Object.hasOwn(value, 'intValue')) return Number(value.intValue);
  if (Object.hasOwn(value, 'doubleValue')) return value.doubleValue;
  if (Object.hasOwn(value, 'boolValue')) return value.boolValue;
  if (value.arrayValue?.values) return value.arrayValue.values.map(otelAttributeValue);
  return undefined;
}

export function otelAttributes(attributes: any = []): Record<string, any> {
  return Object.fromEntries(
    (Array.isArray(attributes) ? attributes : [])
      .map((item) => [item.key, otelAttributeValue(item.value)])
      .filter(([key, value]) => typeof key === 'string' && value !== undefined),
  );
}

export function otelTimestamp(value: any): string | null {
  if (value === undefined || value === null) return null;
  try {
    const nanos = BigInt(String(value));
    return new Date(Number(nanos / 1_000_000n)).toISOString();
  } catch {
    return null;
  }
}

export function otelNanoTimestamp(value: any): bigint {
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

export function otelDurationMs(span: any): number {
  try {
    const start = BigInt(String(span.startTimeUnixNano));
    const end = BigInt(String(span.endTimeUnixNano));
    return Math.max(0, Number(end - start) / 1_000_000);
  } catch {
    return 0;
  }
}

export function numberAttribute(attributes: any, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(attributes?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

export function isDeltaTemporality(temporality: unknown): boolean {
  return OTEL_DELTA_TEMPORALITY_VALUES.has(temporality);
}

export function otelSumDataPointValue(dataPoint: any): number {
  if (dataPoint.asInt !== undefined) return numberAttribute({ value: dataPoint.asInt }, 'value');
  if (dataPoint.asDouble !== undefined) return numberAttribute({ value: dataPoint.asDouble }, 'value');
  return 0;
}

export function metricDataPointCount(metric: any): number {
  return (
    (metric.sum?.dataPoints?.length ?? 0) +
    (metric.histogram?.dataPoints?.length ?? 0) +
    (metric.gauge?.dataPoints?.length ?? 0) +
    (metric.exponentialHistogram?.dataPoints?.length ?? 0)
  );
}

export function toolStatusAttribute(attributes: any): string {
  if (typeof attributes.success === 'boolean') return attributes.success ? 'ok' : 'error';
  if (typeof attributes.success === 'string') {
    const success = attributes.success.trim().toLowerCase();
    if (success === 'true') return 'ok';
    if (success === 'false') return 'error';
  }
  if (typeof attributes.status === 'string' && attributes.status.trim()) return safeMetricLabel(attributes.status);
  return 'unknown';
}

export function toolResultKey(attributes: any): string {
  const callId = typeof attributes.call_id === 'string' && attributes.call_id.trim()
    ? attributes.call_id.trim()
    : typeof attributes.tool_call_id === 'string' && attributes.tool_call_id.trim()
      ? attributes.tool_call_id.trim()
      : null;
  const tool = toolNameAttribute(attributes);
  const source = safeMetricLabel(attributes.source);
  const server = toolServerAttribute(attributes);
  const conversationId = typeof attributes['conversation.id'] === 'string' ? attributes['conversation.id'].trim() : '';
  return [conversationId, callId ?? 'no_call_id', tool, source, server].join('\0');
}

export function toolSeriesIdentity(attributes: any, workspaceId: string = ''): Record<string, string> {
  return {
    tool_name: toolNameAttribute(attributes),
    source: safeMetricLabel(attributes.source),
    server: toolServerAttribute(attributes),
    workspace_id: workspaceId || '',
  };
}

export function hookKey(attributes: any): string {
  return [safeMetricLabel(attributes.hook_name, 'unknown-hook'), safeMetricLabel(attributes.source), safeMetricLabel(attributes.handler_type, '')].join('::');
}

export function sqliteKey(attributes: any): string {
  return `${safeMetricLabel(attributes.db)}::${safeMetricLabel(attributes.status)}`;
}

export function skillAgentKind(attributes: any): string {
  const sessionSource = typeof attributes.session_source === 'string' ? attributes.session_source.trim() : '';
  if (!sessionSource) return 'unknown';
  return sessionSource.startsWith('subagent_thread_spawn_') ? 'subagent' : 'root';
}

export function skillActivationStatus(status: unknown): boolean {
  return !['skipped', 'error', 'failure', 'unavailable'].includes(String(status).toLowerCase());
}

export function timestampNotOlder(next: string | null | undefined, previous: string | null | undefined): boolean {
  if (!next || !previous) return true;
  const nextMs = Date.parse(next);
  const previousMs = Date.parse(previous);
  return !Number.isFinite(nextMs) || !Number.isFinite(previousMs) || nextMs >= previousMs;
}

export function otelRecordIdentity(kind: string, parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify([kind, ...parts])).digest('hex');
}

export function otelLogRecordIdentity(record: any, resourceAttributes: any, scope: any): string | null {
  const time = record.timeUnixNano ?? record.observedTimeUnixNano;
  if (time === undefined || time === null || String(time) === '' || String(time) === '0') return null;
  return otelRecordIdentity('log', [String(time), record.severityNumber ?? null, record.body ?? null, record.attributes ?? [], resourceAttributes ?? [], scope?.name ?? null, scope?.version ?? null]);
}

export function otelSpanIdentity(span: any, resourceAttributes: any, scope: any): string | null {
  if (span.traceId && span.spanId) return `span:${span.traceId}:${span.spanId}`;
  if (!span.startTimeUnixNano && !span.endTimeUnixNano) return null;
  return otelRecordIdentity('span', [span.name ?? null, String(span.startTimeUnixNano ?? ''), String(span.endTimeUnixNano ?? ''), span.status ?? null, span.attributes ?? [], resourceAttributes ?? [], scope?.name ?? null]);
}

export function datapointDiagnosticIdentity(kind: string, metricName: string, dataPoint: any, resourceAttributes: any): string | null {
  if (!dataPoint?.timeUnixNano) return null;
  return otelRecordIdentity('datapoint', [kind, metricName, String(dataPoint.startTimeUnixNano ?? ''), String(dataPoint.timeUnixNano), dataPoint.attributes ?? [], resourceAttributes ?? {}]);
}

export function otelSeriesKey(seriesName: string, attributes: Record<string, unknown>, startTimeUnixNano: unknown): string {
  const identity = JSON.stringify(Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))));
  const digest = createHash('sha256').update(identity).digest('hex');
  return `${seriesName}::${digest}::${startTimeUnixNano ?? ''}`;
}

export function emptyContextDimensions(): ContextDimensions {
  return { byRole: {}, byWorkspace: {}, byModel: {}, byAgent: {} };
}

export function formatContextDimensions(dimensions: Record<string, ContextDimensions> | null | undefined): Record<string, ContextDimensions> {
  return Object.fromEntries(
    Object.entries(dimensions ?? {}).map(([family, value]) => [
      family,
      {
        byRole: { ...(value?.byRole ?? {}) },
        byWorkspace: { ...(value?.byWorkspace ?? {}) },
        byModel: { ...(value?.byModel ?? {}) },
        byAgent: { ...(value?.byAgent ?? {}) },
      },
    ]),
  );
}

export function formatMcpDimensionBuckets(dimensions: Record<string, McpServerDimensionBucket> | null | undefined, now: number, healthTtlMs: number = OTEL_HEALTH_TTL_MS): Record<string, McpServerDimensionBucket> {
  return Object.fromEntries(
    Object.entries(dimensions ?? {}).map(([key, bucket]) => {
      const lastSeenMs = bucket.lastSeenAt ? Date.parse(bucket.lastSeenAt) : NaN;
      const health = Number.isFinite(lastSeenMs) && now - lastSeenMs <= healthTtlMs ? bucket.lastStatus : 'stale';
      return [
        key,
        {
          ...bucket,
          observed: 1,
          ready: health === 'ready' ? 1 : 0,
          error: health === 'error' ? 1 : 0,
          stale: health === 'stale' ? 1 : 0,
          health,
        },
      ];
    }),
  );
}

export function formatToolResults(toolResults: ToolResultsState): any {
  const byTool = [...toolResults.byTool.values()]
    .map((entry) => ({ ...entry, byStatus: { ...entry.byStatus } }))
    .sort((a, b) => `${a.tool}/${a.source}/${a.server}`.localeCompare(`${b.tool}/${b.source}/${b.server}`));
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
      average: toolResults.executionDurationMs.count ? toolResults.executionDurationMs.sum / toolResults.executionDurationMs.count : 0,
    },
    dedupeWindow: toolResults.seenKeys.size,
  };
}

export function formatBridgeEvents(events: BridgeEventsState): any {
  const formatBucket = (bucket: BridgeToolBucket) => ({
    total: bucket.total,
    byTool: [...bucket.byTool.values()]
      .map((entry) => ({ ...entry, byStatus: { ...entry.byStatus } }))
      .sort((a, b) => `${a.tool}/${a.server}`.localeCompare(`${b.tool}/${b.server}`)),
    byWorkspace: [...bucket.byWorkspace.entries()]
      .map(([workspaceKey, row]) => ({
        workspaceKey,
        count: row.count,
        byTool: [...row.byTool.values()].map((entry) => ({ ...entry, byStatus: { ...entry.byStatus } })).sort((a, b) => a.tool.localeCompare(b.tool)),
        bySkill: row.bySkill ? [...row.bySkill.entries()].map(([skill, count]) => ({ skill, count })).sort((a, b) => a.skill.localeCompare(b.skill)) : [],
        byStatus: { ...row.byStatus },
      }))
      .sort((a, b) => a.workspaceKey.localeCompare(b.workspaceKey)),
  });
  return {
    toolExecuted: { ...formatBucket(events.toolExecuted), byReason: {} },
    toolRequested: { ...formatBucket(events.toolRequested), byReason: {} },
    toolUnavailable: { ...formatBucket(events.toolUnavailable), byReason: { ...(events.toolUnavailable.byReason ?? {}) } },
    skillExposed: {
      total: events.skillExposed.total,
      bySkill: [...events.skillExposed.bySkill.values()].map((entry) => ({ ...entry })).sort((a, b) => a.skill.localeCompare(b.skill)),
      byWorkspace: [...events.skillExposed.byWorkspace.entries()]
        .map(([workspaceKey, row]) => ({
          workspaceKey,
          count: row.count,
          bySkill: [...row.bySkill.entries()].map(([skill, count]) => ({ skill, count })),
        }))
        .sort((a, b) => a.workspaceKey.localeCompare(b.workspaceKey)),
    },
    skillUsed: {
      total: events.skillUsed.total,
      bySkill: [...events.skillUsed.bySkill.values()].map((entry) => ({ ...entry })).sort((a, b) => a.skill.localeCompare(b.skill)),
      byWorkspace: [...events.skillUsed.byWorkspace.entries()].map(([workspaceKey, row]) => ({
        workspaceKey,
        count: row.count,
        bySkill: [...row.bySkill.entries()].map(([skill, count]) => ({ skill, count })),
      })),
    },
    mcpExposed: {
      total: events.mcpExposed.total,
      byServer: [...events.mcpExposed.byServer.values()].map((entry) => ({ ...entry })).sort((a, b) => a.server.localeCompare(b.server)),
      byWorkspace: [...events.mcpExposed.byWorkspace.entries()]
        .map(([workspaceKey, row]) => ({
          workspaceKey,
          count: row.count,
          byServer: [...row.byServer.entries()].map(([server, count]) => ({ server, count })),
        }))
        .sort((a, b) => a.workspaceKey.localeCompare(b.workspaceKey)),
    },
  };
}

export function isAutodevAttributesEnabled(): boolean {
  return process.env[AUTODEV_ATTRIBUTES_FLAG] === AUTODEV_ATTRIBUTES_VERSION;
}

export function readAutodevAliasValue(attributes: any, aliases: string[]): string | null {
  if (!Array.isArray(attributes) || !Array.isArray(aliases)) return null;
  for (const alias of aliases) {
    if (typeof alias !== 'string' || !alias) continue;
    const entry = attributes.find((item) => item && typeof item === 'object' && item.key === alias);
    if (!entry) continue;
    const value = otelAttributeValue(entry.value);
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > AUTODEV_ATTRIBUTE_VALUE_MAX_LENGTH) continue;
    return trimmed;
  }
  return null;
}

export function pushAutodevStringAttr(attributes: any, key: string, value: unknown): boolean {
  if (!Array.isArray(attributes)) return false;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > AUTODEV_ATTRIBUTE_VALUE_MAX_LENGTH) return false;
  if (attributes.some((entry) => entry && typeof entry === 'object' && entry.key === key)) return false;
  attributes.push({ key, value: { stringValue: trimmed } });
  return true;
}

export function isAutodevSpawnLogAttributes(attributes: any): boolean {
  if (!Array.isArray(attributes)) return false;
  const eventName = readAutodevAliasValue(attributes, ['event.name']);
  return typeof eventName === 'string' && AUTODEV_SPAWN_LOG_EVENTS.has(eventName);
}

export function enrichAutodevResourceAttributes(resource: any): void {
  if (!resource || !Array.isArray(resource.attributes)) return;
  pushAutodevStringAttr(resource.attributes, 'autodev.role', readAutodevAliasValue(resource.attributes, AUTODEV_RESOURCE_ROLE_ALIASES));
  pushAutodevStringAttr(resource.attributes, 'autodev.workspace', readAutodevAliasValue(resource.attributes, AUTODEV_RESOURCE_WORKSPACE_ALIASES));
  pushAutodevStringAttr(resource.attributes, 'autodev.provider', readAutodevAliasValue(resource.attributes, AUTODEV_RESOURCE_PROVIDER_ALIASES));
  pushAutodevStringAttr(resource.attributes, 'autodev.model', readAutodevAliasValue(resource.attributes, AUTODEV_RESOURCE_MODEL_ALIASES));
}

export function enrichAutodevLogRecord(record: any): void {
  if (!record || !Array.isArray(record.attributes)) return;
  if (isAutodevSpawnLogAttributes(record.attributes)) {
    pushAutodevStringAttr(record.attributes, 'autodev.spawn.mechanism', readAutodevAliasValue(record.attributes, AUTODEV_SPAWN_MECHANISM_ALIASES));
  }
  pushAutodevStringAttr(record.attributes, 'autodev.skill', readAutodevAliasValue(record.attributes, AUTODEV_SKILL_ALIASES));
  pushAutodevStringAttr(record.attributes, 'autodev.mcp.server', readAutodevAliasValue(record.attributes, AUTODEV_MCP_SERVER_ALIASES));
}

export function enrichAutodevSpan(span: any): void {
  if (!span || !Array.isArray(span.attributes)) return;
  pushAutodevStringAttr(span.attributes, 'autodev.mcp.server', readAutodevAliasValue(span.attributes, AUTODEV_MCP_SERVER_ALIASES));
}

export function enrichAutodevDataPoint(dataPoint: any): void {
  if (!dataPoint || !Array.isArray(dataPoint.attributes)) return;
  pushAutodevStringAttr(dataPoint.attributes, 'autodev.skill', readAutodevAliasValue(dataPoint.attributes, AUTODEV_SKILL_ALIASES));
}

export function autodevEnrichOtlpPayload(signal: OtelSignal | string, payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  let clone: any;
  try {
    clone = structuredClone(payload);
  } catch {
    return null;
  }
  if (signal === 'logs') {
    for (const resourceLog of clone.resourceLogs ?? []) {
      enrichAutodevResourceAttributes(resourceLog.resource);
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) enrichAutodevLogRecord(record);
      }
    }
  } else if (signal === 'traces') {
    for (const resourceSpan of clone.resourceSpans ?? []) {
      enrichAutodevResourceAttributes(resourceSpan.resource);
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        for (const span of scopeSpan.spans ?? []) enrichAutodevSpan(span);
      }
    }
  } else if (signal === 'metrics') {
    for (const resourceMetric of clone.resourceMetrics ?? []) {
      enrichAutodevResourceAttributes(resourceMetric.resource);
      for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
        for (const metric of scopeMetric.metrics ?? []) {
          for (const dataPoint of metric.sum?.dataPoints ?? []) enrichAutodevDataPoint(dataPoint);
          for (const dataPoint of metric.histogram?.dataPoints ?? []) enrichAutodevDataPoint(dataPoint);
          for (const dataPoint of metric.gauge?.dataPoints ?? []) enrichAutodevDataPoint(dataPoint);
        }
      }
    }
  }
  return clone;
}

export function createEmptyOtelTelemetry(): OtelTelemetryState {
  return {
    receiver: { logs: 0, traces: 0, metrics: 0, invalid: 0, lastReceivedAt: null },
    sessions: new Map(),
    mcpServers: new Map(),
    recordIdentities: { logs: new Set(), spans: new Set(), datapoints: new Set() },
    dimensions: {
      mcp: emptyContextDimensions(),
      tools: emptyContextDimensions(),
      hooks: emptyContextDimensions(),
      skills: emptyContextDimensions(),
      bridge: emptyContextDimensions(),
    },
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
      used: { total: 0, bySkill: new Map(), byRole: {}, byWorkspace: {}, byModel: {}, byAgent: {}, lastSeenAt: null },
      turnDuration: { durationSeconds: { count: 0, sum: 0 } },
      threads: {
        enabled: { count: 0, sum: 0 },
        kept: { count: 0, sum: 0 },
        truncated: { count: 0, sum: 0 },
        descriptionTruncatedChars: { count: 0, sum: 0 },
      },
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
      seenKeys: new Set(),
    },
    bridgeEvents: {
      toolExecuted: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolRequested: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolUnavailable: { total: 0, byTool: new Map(), byWorkspace: new Map(), byReason: {} },
      skillExposed: { total: 0, bySkill: new Map(), byWorkspace: new Map() },
      skillUsed: { total: 0, bySkill: new Map(), byWorkspace: new Map(), seenKeys: new Set() },
      mcpExposed: { total: 0, byServer: new Map(), byWorkspace: new Map(), seenKeys: new Set() },
    },
  };
}

export class OtelTracker {
  readonly healthTtlMs: number;
  readonly usageTracker: UsageTracker;
  readonly getConversationThread?: ((conversationId: string) => any) | undefined;
  readonly getBridgeRequestContext?: ((requestId: string) => any) | undefined;
  readonly onSchedulePersist?: (() => void) | undefined;

  readonly telemetry: OtelTelemetryState;
  readonly metricSeries: Map<string, { timestamp: bigint; value: number }>;
  readonly pendingMcpModelAttribution: Map<string, Array<{ serverName: string; context: TelemetryContext; status: string }>>;

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
    if (options.healthTtlMs !== undefined) (this as any).healthTtlMs = options.healthTtlMs;
    if (options.usageTracker !== undefined) (this as any).usageTracker = options.usageTracker;
    if (options.getConversationThread !== undefined) (this as any).getConversationThread = options.getConversationThread;
    if (options.getBridgeRequestContext !== undefined) (this as any).getBridgeRequestContext = options.getBridgeRequestContext;
    if (options.onSchedulePersist !== undefined) (this as any).onSchedulePersist = options.onSchedulePersist;
    return this;
  }

  get otelTelemetry(): OtelTelemetryState {
    return this.telemetry;
  }

  get otelMetricSeries(): Map<string, { timestamp: bigint; value: number }> {
    return this.metricSeries;
  }

  mcpServer(name: string): McpServerEntry {
    const cleanName = safeMetricLabel(name, 'unknown');
    if (!this.telemetry.mcpServers.has(cleanName)) {
      this.telemetry.mcpServers.set(cleanName, {
        name: cleanName,
        lastSeenAt: null,
        initAttempts: 0,
        toolDiscoveryAttempts: 0,
        failures: 0,
        durationMs: 0,
        durationCount: 0,
        lastStatus: 'unknown',
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {},
      });
    }
    return this.telemetry.mcpServers.get(cleanName)!;
  }

  telemetryConversationId(attributes: any = {}, resourceAttributes: any = {}, options: any = {}): string | null {
    const convId = attributes?.['conversation.id']
      ?? attributes?.conversation_id
      ?? attributes?.conversationId
      ?? resourceAttributes?.['conversation.id']
      ?? resourceAttributes?.conversation_id
      ?? resourceAttributes?.conversationId
      ?? options?.conversationId;
    return typeof convId === 'string' && convId.trim() ? convId.trim() : null;
  }

  localWorkspaceForConversation(attributes: any, resourceAttributes: any = {}): any {
    const conversationId = attributes?.['conversation.id'] ?? resourceAttributes?.['conversation.id'];
    if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
    const thread = this.getConversationThread?.(conversationId.trim());
    if (!thread || typeof (thread.projectKey ?? thread.workspaceKey) !== 'string' || !(thread.projectKey ?? thread.workspaceKey).trim()) {
      return null;
    }
    return thread;
  }

  resolveTelemetryContext(attributes: any = {}, resourceAttributes: any = {}, options: any = {}): TelemetryContext {
    const reqContext = options?.context
      ?? (options?.requestId ? this.getBridgeRequestContext?.(options.requestId) : null)
      ?? (attributes?.requestId ? this.getBridgeRequestContext?.(attributes.requestId) : null)
      ?? (attributes?.request_id ? this.getBridgeRequestContext?.(attributes.request_id) : null);

    const conversationId = this.telemetryConversationId(attributes, resourceAttributes, options);
    const thread = conversationId ? (this.getConversationThread?.(conversationId) ?? null) : null;
    const session = conversationId ? (this.telemetry.sessions.get(conversationId) ?? null) : null;

    // 1. Workspace
    let resolvedWorkspace: string | null = null;
    const dpWs = extractWorkspaceIdWithAmbiguity(attributes);
    if (!dpWs.ambiguous && dpWs.id) {
      const safeId = safeWorkspaceId(dpWs.id);
      resolvedWorkspace = this.usageTracker.workspaceIdRegistry.get(safeId) ?? safePrivacyWorkspace(dpWs.id);
    }
    if (!resolvedWorkspace) {
      const directWs = attributes?.workspace ?? attributes?.workspace_key ?? attributes?.workspaceKey ?? attributes?.project_key ?? attributes?.projectKey;
      if (typeof directWs === 'string' && directWs.trim()) {
        resolvedWorkspace = safePrivacyWorkspace(directWs);
      }
    }
    if (!resolvedWorkspace && reqContext?.workspace) {
      resolvedWorkspace = safePrivacyWorkspace(reqContext.workspace);
    }
    if (!resolvedWorkspace && thread) {
      const key = thread.projectKey ?? thread.workspaceKey ?? thread.cwdBasename;
      if (typeof key === 'string' && key.trim()) {
        resolvedWorkspace = safePrivacyWorkspace(key);
      }
    }
    if (!resolvedWorkspace) {
      const resWs = extractWorkspaceIdWithAmbiguity(resourceAttributes);
      if (!resWs.ambiguous && resWs.id) {
        const safeId = safeWorkspaceId(resWs.id);
        resolvedWorkspace = this.usageTracker.workspaceIdRegistry.get(safeId) ?? safePrivacyWorkspace(resWs.id);
      }
    }
    if (!resolvedWorkspace && typeof resourceAttributes?.workspace === 'string' && resourceAttributes.workspace.trim()) {
      resolvedWorkspace = safePrivacyWorkspace(resourceAttributes.workspace);
    }
    const workspace = resolvedWorkspace || UNATTRIBUTED_DIMENSION;

    // 2. Role
    let resolvedRole: string | null = null;
    const directRole = attributes?.role ?? attributes?.agent_role ?? attributes?.['agent.role'];
    if (typeof directRole === 'string' && directRole.trim()) {
      resolvedRole = safeMetricLabel(directRole);
    }
    if (!resolvedRole && reqContext?.role) {
      resolvedRole = safeMetricLabel(reqContext.role);
    }
    if (!resolvedRole && (thread?.agentRole ?? thread?.role)) {
      resolvedRole = safeMetricLabel(thread.agentRole ?? thread.role);
    }
    if (!resolvedRole) {
      const resRole = resourceAttributes?.role ?? resourceAttributes?.agent_role ?? resourceAttributes?.['agent.role'];
      if (typeof resRole === 'string' && resRole.trim()) {
        resolvedRole = safeMetricLabel(resRole);
      }
    }
    const role = resolvedRole || UNATTRIBUTED_DIMENSION;

    // 3. Model
    let resolvedModel: string | null = null;
    const directModel = attributes?.model ?? attributes?.requested_model ?? attributes?.['requested.model'] ?? attributes?.model_slug ?? attributes?.['model.slug'];
    if (typeof directModel === 'string' && directModel.trim()) {
      resolvedModel = safeMetricLabel(directModel);
    }
    if (!resolvedModel && (reqContext?.model ?? reqContext?.requestedModel)) {
      resolvedModel = safeMetricLabel(reqContext.model ?? reqContext.requestedModel);
    }
    if (!resolvedModel && session?.model) {
      resolvedModel = safeMetricLabel(session.model);
    }
    if (!resolvedModel && thread?.model) {
      resolvedModel = safeMetricLabel(thread.model);
    }
    if (!resolvedModel) {
      const resModel = resourceAttributes?.model ?? resourceAttributes?.requested_model ?? resourceAttributes?.model_slug;
      if (typeof resModel === 'string' && resModel.trim()) {
        resolvedModel = safeMetricLabel(resModel);
      }
    }
    const model = resolvedModel || UNATTRIBUTED_DIMENSION;

    // 4. Agent identity and kind
    let resolvedAgent: string | null = null;
    let resolvedAgentKind: string | null = null;
    const directAgent = attributes?.agent_id ?? attributes?.['agent.id'] ?? attributes?.agentId ?? attributes?.child_id ?? attributes?.childId ?? attributes?.agent_name ?? attributes?.['agent.name'] ?? attributes?.agentName;
    if (typeof directAgent === 'string' && directAgent.trim()) {
      resolvedAgent = safeAgentIdentity(directAgent);
    }
    if (!resolvedAgent && (reqContext?.childId ?? reqContext?.agentId ?? reqContext?.agent)) {
      resolvedAgent = safeAgentIdentity(reqContext.childId ?? reqContext.agentId ?? reqContext.agent);
    }
    if (!resolvedAgent && (thread?.agentId ?? thread?.agent_id ?? thread?.threadId)) {
      resolvedAgent = safeAgentIdentity(thread.agentId ?? thread.agent_id ?? thread.threadId);
    }
    if (!resolvedAgent && conversationId) {
      resolvedAgent = safeAgentIdentity(conversationId);
    }
    if (!resolvedAgent) {
      const resAgent = resourceAttributes?.agent_id ?? resourceAttributes?.['agent.id'] ?? resourceAttributes?.agentId ?? resourceAttributes?.agent_name;
      if (typeof resAgent === 'string' && resAgent.trim()) {
        resolvedAgent = safeAgentIdentity(resAgent);
      }
    }
    const agent = resolvedAgent || UNATTRIBUTED_DIMENSION;
    const directAgentKind = attributes?.agent_kind ?? attributes?.agentKind ?? attributes?.['agent.kind'];
    if (typeof directAgentKind === 'string' && directAgentKind.trim()) resolvedAgentKind = safeMetricLabel(directAgentKind);
    if (!resolvedAgentKind && reqContext?.agentKind) resolvedAgentKind = safeMetricLabel(reqContext.agentKind);
    const sessionSource = attributes?.session_source ?? resourceAttributes?.session_source ?? thread?.threadSource ?? thread?.source;
    if (!resolvedAgentKind && typeof sessionSource === 'string' && sessionSource.trim()) {
      resolvedAgentKind = sessionSource.trim().startsWith('subagent_thread_spawn_') ? 'subagent' : 'root';
    }
    if (!resolvedAgentKind && thread?.agentRole) resolvedAgentKind = thread.agentRole === 'orchestrator' ? 'root' : 'subagent';
    const agentKind = resolvedAgentKind || UNATTRIBUTED_DIMENSION;

    // 5. Timestamp (source or fallback to ingestion time)
    let timestamp: string | null = null;
    let timestampSource: 'source' | 'ingestion' = 'ingestion';
    if (options?.timestamp && typeof options.timestamp === 'string') {
      timestamp = options.timestamp;
      timestampSource = 'source';
    } else if (attributes?.['event.timestamp']) {
      timestamp = String(attributes['event.timestamp']);
      timestampSource = 'source';
    } else if (attributes?.timestamp) {
      timestamp = String(attributes.timestamp);
      timestampSource = 'source';
    } else if (options?.timeUnixNano) {
      timestamp = otelTimestamp(options.timeUnixNano);
      timestampSource = 'source';
    }
    if (!timestamp) {
      timestamp = new Date().toISOString();
    }

    return {
      workspace,
      role,
      model,
      agent,
      agentKind,
      timestamp,
      timestampSource,
    };
  }

  firstOtelRecordObservation(seen: Set<string>, identity: string | null): boolean {
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    while (seen.size > OTEL_RECORD_IDENTITY_LIMIT) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    return true;
  }

  otelSeriesDelta(seriesKey: string, timeUnixNano: unknown, value: number, temporality: unknown): number {
    const timestamp = otelNanoTimestamp(timeUnixNano);
    const previous = this.metricSeries.get(seriesKey);
    if (previous && timestamp > 0n && timestamp <= previous.timestamp) return 0;
    const delta = !isDeltaTemporality(temporality) && previous && value >= previous.value ? value - previous.value : value;
    this.metricSeries.set(seriesKey, { timestamp, value });
    return Math.max(0, delta);
  }

  noteConversation(attributes: any, resourceAttributes: any = {}): SessionEntry | null {
    const id = attributes['conversation.id'] ?? resourceAttributes['conversation.id'];
    if (typeof id !== 'string' || !id) return null;
    const session = this.telemetry.sessions.get(id) ?? { id, model: null, mcpServers: new Set(), lastSeenAt: null };
    session.model = attributes.model ?? resourceAttributes.model ?? session.model;
    session.lastSeenAt = attributes['event.timestamp'] ?? new Date().toISOString();
    const names = resourceAttributes.mcp_servers;
    if (typeof names === 'string') {
      for (const name of names.split(',').map((item: string) => item.trim()).filter(Boolean)) {
        session.mcpServers.add(name);
        const server = this.mcpServer(name);
        if (server.lastStatus === 'unknown') server.lastStatus = 'configured';
        const context = this.resolveTelemetryContext(attributes, resourceAttributes, { conversationId: id, timestamp: attributes['event.timestamp'] });
        this.noteMcpObservation(server, context, this.telemetryConversationId({}, {}, { conversationId: id }), 'configured');
      }
    }
    this.telemetry.sessions.set(id, session);
    if (session.model) this.resolvePendingMcpModelAttribution(id, session.model);
    return session;
  }

  noteContextDimension(family: keyof OtelTelemetryState['dimensions'], context: TelemetryContext, count: number = 1, dimensions: Set<string> | null = null): void {
    if (!Number.isFinite(count) || count <= 0) return;
    const target = this.telemetry.dimensions[family] ?? (this.telemetry.dimensions[family] = emptyContextDimensions());
    const timestamp = context.timestamp ?? new Date().toISOString();
    for (const [dimension, field] of CONTEXT_DIMENSION_FIELDS) {
      if (dimensions && !dimensions.has(dimension)) continue;
      this.mergeContextDimensionBucket(target[dimension], dimension, context[field], context, count, timestamp);
    }
  }

  mergeContextDimensionBucket(buckets: Record<string, ContextDimensionBucket>, dimension: string, key: string, context: TelemetryContext, count: number, timestamp: string): void {
    const bucket = buckets[key] ?? { count: 0, lastSeenAt: null, ...(dimension === 'byAgent' ? { agentKind: context.agentKind } : {}) };
    bucket.count += count;
    if (!bucket.lastSeenAt || Date.parse(timestamp) >= Date.parse(bucket.lastSeenAt)) bucket.lastSeenAt = timestamp;
    if (dimension === 'byAgent') bucket.agentKind = context.agentKind;
    buckets[key] = bucket;
  }

  noteMcpDimension(server: McpServerEntry, dimension: 'byRole' | 'byWorkspace' | 'byModel' | 'byAgent', key: string, context: TelemetryContext, status?: string): void {
    this.mergeMcpDimensionBucket(server[dimension], dimension, key, context, status);
  }

  mergeMcpDimensionBucket(buckets: Record<string, McpServerDimensionBucket>, dimension: string, key: string, context: TelemetryContext, status?: string): void {
    const existing = buckets[key];
    const bucket = existing ?? { observed: 1, lastSeenAt: null, lastStatus: 'observed' };
    bucket.observed = 1;
    const nextStatus = status ?? bucket.lastStatus;
    const replace = !existing || !bucket.lastSeenAt || (nextStatus === 'configured'
      ? bucket.lastStatus === 'configured'
      : bucket.lastStatus === 'configured' || timestampNotOlder(context.timestamp, bucket.lastSeenAt));
    if (replace) {
      bucket.lastSeenAt = context.timestamp;
      bucket.lastStatus = nextStatus;
    }
    if (dimension === 'byAgent') bucket.agentKind = context.agentKind;
    buckets[key] = bucket;
  }

  noteMcpObservation(server: McpServerEntry, context: TelemetryContext, conversationId: string | null, status: string): void {
    this.noteMcpDimension(server, 'byRole', context.role, context, status);
    this.noteMcpDimension(server, 'byWorkspace', context.workspace, context, status);
    this.noteMcpDimension(server, 'byAgent', context.agent, context, status);
    this.noteContextDimension('mcp', context, 1, NON_MODEL_CONTEXT_DIMENSIONS);
    if (context.model === UNATTRIBUTED_DIMENSION && conversationId) {
      this.deferMcpModelAttribution(conversationId, server.name, context, status);
      return;
    }
    this.applyMcpModelObservation(server, context.model, context, status);
  }

  applyMcpModelObservation(server: McpServerEntry, model: string, context: TelemetryContext, status: string): void {
    this.noteMcpDimension(server, 'byModel', model, context, status);
    this.noteContextDimension('mcp', { ...context, model }, 1, MODEL_CONTEXT_DIMENSIONS);
  }

  commitMcpModelObservations(observations: Array<{ serverName: string; context: TelemetryContext; status: string }>, model: string): void {
    for (const { serverName, context, status } of observations) {
      this.applyMcpModelObservation(this.mcpServer(serverName), model, context, status);
    }
  }

  deferMcpModelAttribution(conversationId: string, serverName: string, context: TelemetryContext, status: string): void {
    let observations = this.pendingMcpModelAttribution.get(conversationId);
    if (!observations) {
      observations = [];
      this.pendingMcpModelAttribution.set(conversationId, observations);
      while (this.pendingMcpModelAttribution.size > PENDING_MCP_MODEL_CONVERSATION_LIMIT) {
        const oldestEntry = this.pendingMcpModelAttribution.entries().next().value;
        if (oldestEntry) {
          const [oldest, oldestObservations] = oldestEntry;
          this.pendingMcpModelAttribution.delete(oldest);
          this.commitMcpModelObservations(oldestObservations, UNATTRIBUTED_DIMENSION);
        }
      }
    }
    observations.push({ serverName, context, status });
    if (observations.length > PENDING_MCP_MODEL_OBSERVATION_LIMIT) {
      this.commitMcpModelObservations(observations.splice(0, observations.length - PENDING_MCP_MODEL_OBSERVATION_LIMIT), UNATTRIBUTED_DIMENSION);
    }
  }

  resolvePendingMcpModelAttribution(conversationId: string, model: string): void {
    const key = conversationId.trim();
    const observations = this.pendingMcpModelAttribution.get(key);
    if (!observations) return;
    this.pendingMcpModelAttribution.delete(key);
    this.commitMcpModelObservations(observations, safeMetricLabel(model));
  }

  mcpModelDimensionsView(): { serverByModel: Map<string, Record<string, McpServerDimensionBucket>>; dimensionByModel: Record<string, ContextDimensionBucket> } {
    const cloneBuckets = <T extends Record<string, any>>(buckets: T | null | undefined): T =>
      Object.fromEntries(Object.entries(buckets ?? {}).map(([key, bucket]) => [key, { ...bucket }])) as T;
    const serverByModel = new Map<string, Record<string, McpServerDimensionBucket>>();
    const dimensionByModel = cloneBuckets(this.telemetry.dimensions.mcp.byModel);
    for (const observations of this.pendingMcpModelAttribution.values()) {
      for (const { serverName, context, status } of observations) {
        if (!serverByModel.has(serverName)) {
          serverByModel.set(serverName, cloneBuckets(this.telemetry.mcpServers.get(serverName)?.byModel));
        }
        const serverBuckets = serverByModel.get(serverName)!;
        this.mergeMcpDimensionBucket(serverBuckets, 'byModel', UNATTRIBUTED_DIMENSION, context, status);
        this.mergeContextDimensionBucket(dimensionByModel, 'byModel', UNATTRIBUTED_DIMENSION, context, 1, context.timestamp ?? new Date().toISOString());
      }
    }
    return { serverByModel, dimensionByModel };
  }

  noteMcpServer(name: string | null | undefined, span: any, attributes: any = {}, resourceAttributes: any = {}): void {
    const serverName = name ?? attributes.server_name ?? attributes.server ?? attributes.mcp_server;
    if (typeof serverName !== 'string' || !serverName.trim()) return;
    const server = this.mcpServer(serverName.trim());
    const durationMs = span ? otelDurationMs(span) : 0;
    const timestamp = span ? (otelTimestamp(span.endTimeUnixNano) ?? otelTimestamp(span.startTimeUnixNano)) : null;
    const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timestamp });
    const statusCode = span?.status?.code;
    if (!server.lastSeenAt || timestampNotOlder(context.timestamp, server.lastSeenAt)) server.lastSeenAt = context.timestamp;
    if (span) {
      server.durationMs += durationMs;
      server.durationCount += 1;
      if (span.name === 'make_rmcp_client' || span.name === 'start_server_task' || span.name === 'new') server.initAttempts += 1;
      if (span.name === 'list_tools_for_client_uncached' || span.name === 'list_tools_with_connector_ids') server.toolDiscoveryAttempts += 1;
      if (statusCode === 2 || statusCode === 'ERROR') {
        server.failures += 1;
        server.lastStatus = 'error';
      } else if (span.name === 'list_tools_for_client_uncached' || span.name === 'list_tools_with_connector_ids' || span.name === 'initialize') {
        server.lastStatus = 'ready';
      } else if (server.lastStatus === 'unknown') {
        server.lastStatus = 'observed';
      }
      if (attributes['error.type'] || attributes['error.message']) server.lastStatus = 'error';
    }

    this.noteMcpObservation(server, context, this.telemetryConversationId(attributes, resourceAttributes), server.lastStatus);

    if (context.workspace !== UNATTRIBUTED_DIMENSION) {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, context.workspace);
      wsBucket.mcpCapable = true;
      if (!span || !MCP_DISCOVERY_SPAN_NAMES.has(span.name)) return;
      wsBucket.byMcp[server.name] = (wsBucket.byMcp[server.name] ?? 0) + 1;
    }
  }

  noteCodexToolResultLog(attributes: any, resourceAttributes: any = {}): void {
    const tool = toolNameAttribute(attributes, 'unknown-tool');
    const source = safeMetricLabel(attributes.tool_origin ?? attributes.source, 'codex');
    const server = toolServerAttribute(attributes);
    const callId = typeof (attributes.call_id ?? attributes.tool_call_id) === 'string'
      ? String(attributes.call_id ?? attributes.tool_call_id).trim()
      : '';
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
    this.telemetry.toolResults.byStatus[status] = (this.telemetry.toolResults.byStatus[status] ?? 0) + count;
    const rowKey = [tool, source, server].join('::');
    const row = this.telemetry.toolResults.byTool.get(rowKey) ?? { tool, source, server, count: 0, byStatus: {} };
    row.count += count;
    row.byStatus[status] = (row.byStatus[status] ?? 0) + count;
    this.telemetry.toolResults.byTool.set(rowKey, row);
    const duration = Number(attributes.duration_ms);

    const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timestamp: attributes['event.timestamp'] });
    this.noteContextDimension('tools', context, count);
    if (server) {
      const mcp = this.mcpServer(server);
      this.noteMcpDimension(mcp, 'byRole', context.role, context, 'observed');
      this.noteMcpDimension(mcp, 'byWorkspace', context.workspace, context, 'observed');
      this.noteMcpDimension(mcp, 'byModel', context.model, context, 'observed');
      this.noteMcpDimension(mcp, 'byAgent', context.agent, context, 'observed');
    }

    const thread = this.localWorkspaceForConversation(attributes, resourceAttributes);
    if (!thread && context.workspace === UNATTRIBUTED_DIMENSION) {
      this.usageTracker.attributionDiagnostics.total += 1;
      this.usageTracker.attributionDiagnostics.unattributed += 1;
      this.usageTracker.attributionDiagnostics.byReason.missing_workspace += 1;
      return;
    }
    this.usageTracker.attributionDiagnostics.total += 1;
    this.usageTracker.attributionDiagnostics.attributed += 1;
    this.usageTracker.attributionDiagnostics.bySource.datapoint += 1;
    const wsKey = (thread?.projectKey ?? thread?.workspaceKey) || (context.workspace !== UNATTRIBUTED_DIMENSION ? context.workspace : null);
    const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsKey, thread?.cwdBasename ?? null);
    wsBucket.toolsCapable = true;
    const wsTool = this.usageTracker.workspaceToolBucket(wsBucket, { tool, source, server });
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

  ingestOtelLogs(payload: any): void {
    for (const resourceLog of payload?.resourceLogs ?? []) {
      const resource = otelAttributes(resourceLog.resource?.attributes);
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          if (!this.firstOtelRecordObservation(this.telemetry.recordIdentities.logs, otelLogRecordIdentity(record, resourceLog.resource?.attributes, scopeLog.scope))) continue;
          const attributes = otelAttributes(record.attributes);
          const eventName = attributes['event.name'];
          this.noteConversation(attributes, resource);
          if (eventName === 'codex.conversation_starts') {
            this.noteConversation(attributes, resource);
          } else if (eventName === 'codex.user_prompt') {
            this.telemetry.turns.prompts += 1;
            this.telemetry.turns.promptLength += numberAttribute(attributes, 'prompt_length');
          } else if (eventName === 'codex.turn_ttft') {
            const duration = numberAttribute(attributes, 'duration_ms');
            this.telemetry.turns.ttftMs += duration;
            this.telemetry.turns.ttftCount += duration > 0 ? 1 : 0;
          } else if (eventName === 'codex.tool_result') {
            this.noteCodexToolResultLog(attributes, resource);
          } else if (eventName === 'codex.sse_event' && attributes['event.kind'] === 'response.completed') {
            this.telemetry.turns.completed += 1;
            this.telemetry.tokens.input += numberAttribute(attributes, 'input_token_count');
            this.telemetry.tokens.output += numberAttribute(attributes, 'output_token_count');
            this.telemetry.tokens.cached += numberAttribute(attributes, 'cached_token_count');
            this.telemetry.tokens.reasoning += numberAttribute(attributes, 'reasoning_token_count');
            this.telemetry.tokens.tool += numberAttribute(attributes, 'tool_token_count');
          }
        }
      }
    }
  }

  ingestOtelTraces(payload: any): void {
    for (const resourceSpan of payload?.resourceSpans ?? []) {
      const resource = otelAttributes(resourceSpan.resource?.attributes);
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        for (const span of scopeSpan.spans ?? []) {
          if (!this.firstOtelRecordObservation(this.telemetry.recordIdentities.spans, otelSpanIdentity(span, resourceSpan.resource?.attributes, scopeSpan.scope))) continue;
          const attributes = otelAttributes(span.attributes);
          this.noteConversation(attributes, resource);
          const serverName = attributes.server_name ?? attributes.server ?? attributes.mcp_server;
          this.noteMcpServer(serverName, span, attributes, resource);
        }
      }
    }
  }

  resolveDatapointWorkspace(dataPointAttributes: any, resourceAttributes: any = {}, diagnosticIdentity: string | null = null): {
    status: 'attributed' | 'unattributed';
    workspaceKey: string | null;
    workspaceId: string | null;
    source: 'datapoint' | 'resource' | null;
    reason?: string;
  } {
    const record = this.firstOtelRecordObservation(this.telemetry.recordIdentities.datapoints, diagnosticIdentity);
    const dp = extractWorkspaceIdWithAmbiguity(dataPointAttributes);
    const resource = extractWorkspaceIdWithAmbiguity(resourceAttributes);
    const dpId = dp.id ? safeWorkspaceId(dp.id) : null;
    const resourceId = resource.id ? safeWorkspaceId(resource.id) : null;
    if (dp.ambiguous || resource.ambiguous || (dpId && resourceId && dpId !== resourceId)) {
      if (record) {
        this.usageTracker.attributionDiagnostics.total += 1;
        this.usageTracker.attributionDiagnostics.unattributed += 1;
        this.usageTracker.attributionDiagnostics.byReason.ambiguous_resource += 1;
      }
      return { status: 'unattributed', workspaceKey: null, workspaceId: null, reason: 'ambiguous_resource', source: dp.id ? 'datapoint' : 'resource' };
    }

    const workspaceId = dpId ?? resourceId;
    const source = dpId ? 'datapoint' : resourceId ? 'resource' : null;
    if (!workspaceId) {
      if (record) {
        this.usageTracker.attributionDiagnostics.total += 1;
        this.usageTracker.attributionDiagnostics.unattributed += 1;
        this.usageTracker.attributionDiagnostics.byReason.missing_workspace += 1;
      }
      return { status: 'unattributed', workspaceKey: null, workspaceId: null, reason: 'missing_workspace', source: null };
    }

    if (record) this.usageTracker.attributionDiagnostics.total += 1;
    const workspaceKey = this.usageTracker.workspaceIdConflicts.has(workspaceId) ? null : this.usageTracker.workspaceIdRegistry.get(workspaceId);
    if (workspaceKey) {
      if (record) {
        this.usageTracker.attributionDiagnostics.attributed += 1;
        if (source) this.usageTracker.attributionDiagnostics.bySource[source] += 1;
      }
      return { status: 'attributed', workspaceKey, workspaceId, source };
    }

    if (record) {
      this.usageTracker.attributionDiagnostics.unattributed += 1;
      this.usageTracker.attributionDiagnostics.byReason.unknown_workspace_id += 1;
    }
    this.usageTracker.attributionDiagnostics.unknownWorkspaceIds.delete(workspaceId);
    this.usageTracker.attributionDiagnostics.unknownWorkspaceIds.add(workspaceId);
    while (this.usageTracker.attributionDiagnostics.unknownWorkspaceIds.size > MAX_UNKNOWN_WORKSPACE_IDS) {
      const oldest = this.usageTracker.attributionDiagnostics.unknownWorkspaceIds.values().next().value;
      if (oldest !== undefined) this.usageTracker.attributionDiagnostics.unknownWorkspaceIds.delete(oldest);
    }
    return { status: 'unattributed', workspaceKey: null, workspaceId, reason: 'unknown_workspace_id', source };
  }

  skillBucket(name: string): SkillInjectedSkillBucket {
    if (!this.telemetry.skills.injected.bySkill.has(name)) {
      this.telemetry.skills.injected.bySkill.set(name, { skill: name, total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {} });
    }
    return this.telemetry.skills.injected.bySkill.get(name)!;
  }

  skillUsedBucket(name: string): SkillUsedSkillBucket {
    const used = this.telemetry.skills.used;
    if (!used.bySkill.has(name)) {
      used.bySkill.set(name, { skill: name, total: 0, byRole: {}, byWorkspace: {}, byModel: {}, byAgent: {}, lastSeenAt: null });
    }
    return used.bySkill.get(name)!;
  }

  recordSkillUse(skill: string, context: TelemetryContext, count: number = 1, timestamp: string | null = null): void {
    if (!skill || !Number.isFinite(count) || count <= 0) return;
    const used = this.telemetry.skills.used;
    const at = timestamp ?? context.timestamp ?? new Date().toISOString();
    used.total += count;
    used.lastSeenAt = at;
    const bucket = this.skillUsedBucket(skill);
    bucket.total += count;
    bucket.lastSeenAt = at;
    for (const [field, key] of [
      ['byRole', context.role],
      ['byWorkspace', context.workspace],
      ['byModel', context.model],
      ['byAgent', context.agent],
    ] as const) {
      used[field][key] = (used[field][key] ?? 0) + count;
      bucket[field][key] = (bucket[field][key] ?? 0) + count;
    }
    if (context.workspace !== UNATTRIBUTED_DIMENSION) {
      const workspace = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, context.workspace);
      workspace.skillUses = (workspace.skillUses ?? 0) + count;
      const wsSkill = this.usageTracker.workspaceSkillBucket(workspace, skill);
      wsSkill.uses = (wsSkill.uses ?? 0) + count;
    }
  }

  noteSkillInjected(metricName: string, attributes: any, dataPoint: any, temporality: any, dpAttributes: any = null, resourceAttributes: any = {}): void {
    const wsResolution = this.resolveDatapointWorkspace(dpAttributes ?? attributes, resourceAttributes, datapointDiagnosticIdentity('skill', metricName, dataPoint, resourceAttributes));
    const seriesAttributes = { ...attributes, workspace_id: wsResolution.workspaceId || '' };
    const delta = this.otelSeriesDelta(otelSeriesKey(metricName, seriesAttributes, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
    if (delta === 0) return;
    const context = this.resolveTelemetryContext({ ...attributes, ...dpAttributes }, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
    this.noteContextDimension('skills', context, delta);
    const skill = readNamedAttribute(attributes, 'unknown', 'skillName', 'skill', 'skill_name');
    const status = safeMetricLabel(attributes.status);
    const invokeType = typeof attributes.invoke_type === 'string' && attributes.invoke_type ? safeMetricLabel(attributes.invoke_type) : null;
    const agentKind = context.agentKind;
    const model = context.model;
    const plugin = safeMetricLabel(attributes.plugin_id, 'none');
    const injected = this.telemetry.skills.injected;
    injected.total += delta;
    injected.byStatus[status] = (injected.byStatus[status] ?? 0) + delta;
    if (invokeType) injected.byInvokeType[invokeType] = (injected.byInvokeType[invokeType] ?? 0) + delta;
    injected.byAgentKind[agentKind] = (injected.byAgentKind[agentKind] ?? 0) + delta;
    injected.byModel[model] = (injected.byModel[model] ?? 0) + delta;
    injected.byPlugin[plugin] = (injected.byPlugin[plugin] ?? 0) + delta;
    const bucket = this.skillBucket(skill);
    bucket.total += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
    if (invokeType) bucket.byInvokeType[invokeType] = (bucket.byInvokeType[invokeType] ?? 0) + delta;
    bucket.byAgentKind[agentKind] = (bucket.byAgentKind[agentKind] ?? 0) + delta;
    bucket.byModel[model] = (bucket.byModel[model] ?? 0) + delta;
    bucket.byPlugin[plugin] = (bucket.byPlugin[plugin] ?? 0) + delta;

    if (wsResolution.status === 'attributed' && wsResolution.workspaceKey) {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsResolution.workspaceKey);
      wsBucket.skillsCapable = true;
      wsBucket.skillContextsInjected = (wsBucket.skillContextsInjected ?? 0) + delta;
      const explicitUse = invokeType === 'explicit' && skillActivationStatus(status);
      if (explicitUse) {
        this.recordSkillUse(skill, context, delta, context.timestamp);
      }
      const wsSkill = this.usageTracker.workspaceSkillBucket(wsBucket, skill);
      wsSkill.total += delta;
      wsSkill.byStatus[status] = (wsSkill.byStatus[status] ?? 0) + delta;
      if (invokeType) wsSkill.byInvokeType[invokeType] = (wsSkill.byInvokeType[invokeType] ?? 0) + delta;
      wsSkill.byAgentKind[agentKind] = (wsSkill.byAgentKind[agentKind] ?? 0) + delta;
      wsSkill.byModel[model] = (wsSkill.byModel[model] ?? 0) + delta;
      wsSkill.byPlugin[plugin] = (wsSkill.byPlugin[plugin] ?? 0) + delta;
    }
    if (wsResolution.status !== 'attributed' && invokeType === 'explicit' && skillActivationStatus(status)) {
      this.recordSkillUse(skill, context, delta, context.timestamp);
    }
    if (wsResolution.status === 'attributed' && wsResolution.workspaceKey && (!skill || skill === 'unknown')) {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsResolution.workspaceKey);
      wsBucket.skillsUnattributed = (wsBucket.skillsUnattributed ?? 0) + delta;
    }
  }

  noteThreadSkillsHistogram(bucket: HistogramBucket, metricName: string, attributes: any, dataPoint: any, temporality: any): void {
    const countDelta = this.otelSeriesDelta(otelSeriesKey(`${metricName}#count`, attributes, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, 'count'), temporality);
    const sumDelta = this.otelSeriesDelta(otelSeriesKey(`${metricName}#sum`, attributes, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, 'sum'), temporality);
    bucket.count += countDelta;
    bucket.sum += sumDelta;
    const context = this.resolveTelemetryContext(attributes, {}, { timeUnixNano: dataPoint.timeUnixNano });
    this.noteContextDimension('skills', context, countDelta);
  }

  noteMetricInventory(metric: any): void {
    if (typeof metric.name !== 'string' || !metric.name) return;
    const entry = this.telemetry.metricInventory.get(metric.name) ?? { name: metric.name, exports: 0, dataPoints: 0 };
    entry.exports += 1;
    entry.dataPoints += metricDataPointCount(metric);
    this.telemetry.metricInventory.set(metric.name, entry);
  }

  sqliteBucket(collection: Map<string, SqliteEntry>, attributes: any): SqliteEntry {
    const key = sqliteKey(attributes);
    if (!collection.has(key)) collection.set(key, { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status), count: 0 });
    return collection.get(key)!;
  }

  sqliteDurationBucket(attributes: any): SqliteDurationEntry {
    const key = sqliteKey(attributes);
    if (!this.telemetry.sqlite.initDurationMs.has(key)) {
      this.telemetry.sqlite.initDurationMs.set(key, { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status), count: 0, sum: 0 });
    }
    return this.telemetry.sqlite.initDurationMs.get(key)!;
  }

  noteSqliteCounter(collection: Map<string, SqliteEntry>, metricName: string, attributes: any, dataPoint: any, temporality: any): void {
    const value = otelSumDataPointValue(dataPoint);
    const delta = this.otelSeriesDelta(otelSeriesKey(metricName, { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status) }, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, value, temporality);
    this.sqliteBucket(collection, attributes).count += delta;
  }

  toolBucket(attributes: any): ToolEntry {
    const tool = toolNameAttribute(attributes);
    const source = safeMetricLabel(attributes.source);
    const server = toolServerAttribute(attributes);
    const key = toolKey(attributes);
    if (!this.telemetry.tools.has(key)) this.telemetry.tools.set(key, { tool, source, server, count: 0, byStatus: {}, durationCount: 0, durationMs: 0 });
    return this.telemetry.tools.get(key)!;
  }

  noteToolCounter(metricName: string, attributes: any, dataPoint: any, temporality: any, resourceAttributes: any = {}): void {
    const wsResolution = this.resolveDatapointWorkspace(attributes, resourceAttributes, datapointDiagnosticIdentity('tool-counter', metricName, dataPoint, resourceAttributes));
    const identity = toolSeriesIdentity(attributes, wsResolution.workspaceId || '');
    const delta = this.otelSeriesDelta(otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
    if (delta === 0) return;
    const bucket = this.toolBucket(attributes);
    const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
    this.noteContextDimension('tools', context, delta);
    const status = toolStatusAttribute(attributes);
    bucket.count += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;

    if (wsResolution.status === 'attributed' && wsResolution.workspaceKey) {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsResolution.workspaceKey);
      wsBucket.toolsCapable = true;
      const wsTool = this.usageTracker.workspaceToolBucket(wsBucket, attributes);
      wsTool.count += delta;
      wsTool.byStatus[status] = (wsTool.byStatus[status] ?? 0) + delta;
    }
  }

  noteToolDuration(metricName: string, attributes: any, dataPoint: any, temporality: any, resourceAttributes: any = {}): void {
    const wsResolution = this.resolveDatapointWorkspace(attributes, resourceAttributes, datapointDiagnosticIdentity('tool-duration', metricName, dataPoint, resourceAttributes));
    const identity = toolSeriesIdentity(attributes, wsResolution.workspaceId || '');
    const count = this.otelSeriesDelta(otelSeriesKey(`${metricName}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, 'count'), temporality);
    const sum = this.otelSeriesDelta(otelSeriesKey(`${metricName}#sum`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, 'sum'), temporality);
    const bucket = this.toolBucket(attributes);
    const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
    this.noteContextDimension('tools', context, count);
    bucket.durationCount += count;
    bucket.durationMs += sum;

    if (wsResolution.status === 'attributed' && wsResolution.workspaceKey) {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsResolution.workspaceKey);
      wsBucket.toolsCapable = true;
      const wsTool = this.usageTracker.workspaceToolBucket(wsBucket, attributes);
      wsTool.durationCount += count;
      wsTool.durationMs += sum;
    }
  }

  noteToolResultCounter(metricName: string, resourceAttributes: any, dataPoints: any[], temporality: any): void {
    for (const dataPoint of dataPoints ?? []) {
      const attributes = otelAttributes(dataPoint.attributes);
      const wsResolution = this.resolveDatapointWorkspace(attributes, resourceAttributes, datapointDiagnosticIdentity('tool-result-counter', metricName, dataPoint, resourceAttributes));
      if (wsResolution.status === 'attributed' && wsResolution.workspaceKey) {
        this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsResolution.workspaceKey).toolsCapable = true;
      }
      const identity = toolSeriesIdentity(attributes, wsResolution.workspaceId || '');
      const tool = toolNameAttribute(attributes);
      const source = safeMetricLabel(attributes.source);
      const server = toolServerAttribute(attributes);
      const status = toolStatusAttribute(attributes);
      const callId = typeof attributes.call_id === 'string' && attributes.call_id.trim()
        ? attributes.call_id.trim()
        : typeof attributes.tool_call_id === 'string' && attributes.tool_call_id.trim()
          ? attributes.tool_call_id.trim()
          : null;
      const resultIdentity = { ...identity, call_id: callId ?? '' };
      const delta = this.otelSeriesDelta(otelSeriesKey(`${metricName}#count`, resultIdentity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
      if (delta === 0) continue;
      const resultKey = toolResultKey(attributes);
      const logSeen = this.telemetry.toolResults.seenKeys.has(`log:${resultKey}`);
      const metricSeen = this.telemetry.toolResults.seenKeys.has(`metric:${resultKey}`);
      if (logSeen) continue;
      this.telemetry.toolResults.total += delta;
      const duplicateMetric = metricSeen;
      if (duplicateMetric) {
        this.telemetry.toolResults.unattributed += delta;
      } else {
        this.telemetry.toolResults.seenKeys.add(`metric:${resultKey}`);
      }
      if (callId && !duplicateMetric) {
        this.telemetry.toolResults.executed += delta;
        this.telemetry.toolResults.causeResolved += delta;
        while (this.telemetry.toolResults.seenKeys.size > 5000) {
          const first = this.telemetry.toolResults.seenKeys.values().next().value;
          if (first === undefined) break;
          this.telemetry.toolResults.seenKeys.delete(first);
        }
      } else if (!callId && !duplicateMetric) {
        this.telemetry.toolResults.unattributed += delta;
        this.telemetry.toolResults.causeUnresolved += delta;
        if (wsResolution.status === 'attributed' && wsResolution.workspaceKey) {
          const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsResolution.workspaceKey);
          wsBucket.toolsUnattributed = (wsBucket.toolsUnattributed ?? 0) + delta;
        }
      } else if (!duplicateMetric) {
        this.telemetry.toolResults.unattributed += delta;
        if (wsResolution.status === 'attributed' && wsResolution.workspaceKey) {
          const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, wsResolution.workspaceKey);
          wsBucket.toolsUnattributed = (wsBucket.toolsUnattributed ?? 0) + delta;
        }
      }
      this.telemetry.toolResults.byStatus[status] = (this.telemetry.toolResults.byStatus[status] ?? 0) + delta;
      if (tool && tool !== 'unknown-tool') {
        const resultBucketKey = [tool, source, server].join('::');
        const resultBucket = this.telemetry.toolResults.byTool.get(resultBucketKey) ?? { tool, source, server, count: 0, byStatus: {} };
        resultBucket.count += delta;
        resultBucket.byStatus[status] = (resultBucket.byStatus[status] ?? 0) + delta;
        this.telemetry.toolResults.byTool.set(resultBucketKey, resultBucket);
      }
      if (server && delta > 0 && !duplicateMetric) {
        const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
        const mcp = this.mcpServer(server);
        this.noteMcpDimension(mcp, 'byRole', context.role, context, 'observed');
        this.noteMcpDimension(mcp, 'byWorkspace', context.workspace, context, 'observed');
        this.noteMcpDimension(mcp, 'byModel', context.model, context, 'observed');
        this.noteMcpDimension(mcp, 'byAgent', context.agent, context, 'observed');
        this.noteContextDimension('tools', context, delta);
        if (context.workspace !== UNATTRIBUTED_DIMENSION) {
          const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, context.workspace);
          wsBucket.mcpCapable = true;
          wsBucket.byMcp[server] = (wsBucket.byMcp[server] ?? 0) + delta;
        }
      }
    }
  }

  noteToolResultDuration(metricName: string, resourceAttributes: any, dataPoints: any[], temporality: any): void {
    for (const dataPoint of dataPoints ?? []) {
      const attributes = otelAttributes(dataPoint.attributes);
      const wsResolution = this.resolveDatapointWorkspace(attributes, resourceAttributes, datapointDiagnosticIdentity('tool-result-duration', metricName, dataPoint, resourceAttributes));
      const identity = toolSeriesIdentity(attributes, wsResolution.workspaceId || '');
      const count = this.otelSeriesDelta(otelSeriesKey(`${metricName}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, 'count'), temporality);
      const sum = this.otelSeriesDelta(otelSeriesKey(`${metricName}#sum`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, 'sum'), temporality);
      if (count === 0 && sum === 0) continue;
      this.telemetry.toolResults.executionDurationMs.count += count;
      this.telemetry.toolResults.executionDurationMs.sum += sum;
      const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
      this.noteContextDimension('tools', context, count);
    }
  }

  hookBucket(attributes: any): HookEntry {
    const hook = safeMetricLabel(attributes.hook_name, 'unknown-hook');
    const source = safeMetricLabel(attributes.source);
    const handlerType = safeMetricLabel(attributes.handler_type, '');
    const key = hookKey(attributes);
    if (!this.telemetry.hooks.has(key)) this.telemetry.hooks.set(key, { hook, source, handlerType, count: 0, byStatus: {}, durationCount: 0, durationMs: 0 });
    return this.telemetry.hooks.get(key)!;
  }

  noteHookCounter(metricName: string, attributes: any, dataPoint: any, temporality: any, resourceAttributes: any = {}): void {
    const identity = { hook_name: safeMetricLabel(attributes.hook_name, 'unknown-hook'), source: safeMetricLabel(attributes.source), handler_type: safeMetricLabel(attributes.handler_type, '') };
    const delta = this.otelSeriesDelta(otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
    if (delta === 0) return;
    const bucket = this.hookBucket(attributes);
    const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
    this.noteContextDimension('hooks', context, delta);
    const status = safeMetricLabel(attributes.status);
    bucket.count += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
    const server = toolServerAttribute(attributes);
    if (server) {
      const mcp = this.mcpServer(server);
      this.noteMcpDimension(mcp, 'byRole', context.role, context, 'observed');
      this.noteMcpDimension(mcp, 'byWorkspace', context.workspace, context, 'observed');
      this.noteMcpDimension(mcp, 'byModel', context.model, context, 'observed');
      this.noteMcpDimension(mcp, 'byAgent', context.agent, context, 'observed');
      if (context.workspace !== UNATTRIBUTED_DIMENSION) {
        this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, context.workspace).mcpCapable = true;
      }
    }
  }

  noteHookDuration(metricName: string, attributes: any, dataPoint: any, temporality: any, resourceAttributes: any = {}): void {
    const identity = { hook_name: safeMetricLabel(attributes.hook_name, 'unknown-hook'), source: safeMetricLabel(attributes.source), handler_type: safeMetricLabel(attributes.handler_type, '') };
    const count = this.otelSeriesDelta(otelSeriesKey(`${metricName}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, 'count'), temporality);
    const sum = this.otelSeriesDelta(otelSeriesKey(`${metricName}#sum`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, 'sum'), temporality);
    const bucket = this.hookBucket(attributes);
    const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
    this.noteContextDimension('hooks', context, count);
    bucket.durationCount += count;
    bucket.durationMs += sum;
  }

  noteHookHistogramCount(metricName: string, attributes: any, dataPoint: any, temporality: any, resourceAttributes: any = {}): void {
    const identity = { hook_name: safeMetricLabel(attributes.hook_name, 'unknown-hook'), source: safeMetricLabel(attributes.source), handler_type: safeMetricLabel(attributes.handler_type, '') };
    const delta = this.otelSeriesDelta(otelSeriesKey(`${metricName}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, 'count'), temporality);
    if (delta === 0) return;
    const bucket = this.hookBucket(attributes);
    const context = this.resolveTelemetryContext(attributes, resourceAttributes, { timeUnixNano: dataPoint.timeUnixNano });
    this.noteContextDimension('hooks', context, delta);
    const status = safeMetricLabel(attributes.status);
    bucket.count += delta;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + delta;
  }

  noteThreadStarted(metricName: string, attributes: any, dataPoint: any, temporality: any): void {
    const source = safeMetricLabel(attributes.source ?? attributes.thread_source ?? attributes.origin);
    const delta = this.otelSeriesDelta(otelSeriesKey(metricName, { source }, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
    this.telemetry.threads.started.total += delta;
    this.telemetry.threads.started.bySource[source] = (this.telemetry.threads.started.bySource[source] ?? 0) + delta;
  }

  noteHistogramCount(target: { total: number; bySource: Record<string, number> }, metricName: string, attributes: any, dataPoint: any, temporality: any): void {
    const source = safeMetricLabel(attributes.source ?? attributes.thread_source ?? attributes.origin);
    const delta = this.otelSeriesDelta(otelSeriesKey(`${metricName}#count`, { source }, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, 'count'), temporality);
    target.total += delta;
    target.bySource[source] = (target.bySource[source] ?? 0) + delta;
  }

  noteThreadSpawn(metricName: string, attributes: any, dataPoint: any, temporality: any): void {
    const role = safeMetricLabel(attributes.agent_role ?? attributes.role);
    const model = safeMetricLabel(attributes.requested_model ?? attributes.model);
    const identity = { agent_role: role, requested_model: model };
    const delta = this.otelSeriesDelta(otelSeriesKey(metricName, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, otelSumDataPointValue(dataPoint), temporality);
    if (delta === 0) return;
    const status = safeMetricLabel(attributes.status ?? attributes.spawned);
    const spawns = this.telemetry.threads.spawns;
    spawns.total += delta;
    spawns.byStatus[status] = (spawns.byStatus[status] ?? 0) + delta;
    spawns.byRole[role] = (spawns.byRole[role] ?? 0) + delta;
    spawns.byModel[model] = (spawns.byModel[model] ?? 0) + delta;
  }

  ingestOtelMetrics(payload: any): void {
    for (const resourceMetric of payload?.resourceMetrics ?? []) {
      for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
        for (const metric of scopeMetric.metrics ?? []) {
          if (REMOVED_SHADOW_SELECTION_METRICS.has(metric.name)) continue;
          this.noteMetricInventory(metric);
          if (metric.name === 'codex.skill.injected') {
            const temporality = metric.sum?.aggregationTemporality;
            const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
            for (const dataPoint of metric.sum?.dataPoints ?? []) {
              const dpAttributes = otelAttributes(dataPoint.attributes);
              this.noteSkillInjected(metric.name, { ...resourceAttributes, ...dpAttributes }, dataPoint, temporality, dpAttributes, resourceAttributes);
            }
          } else if (metric.name && SKILL_TURN_HISTOGRAMS[metric.name]) {
            const histKey = SKILL_TURN_HISTOGRAMS[metric.name]!;
            const bucket = (this.telemetry.skills.turnDuration as any)[histKey];
            const temporality = metric.histogram?.aggregationTemporality;
            for (const dataPoint of metric.histogram?.dataPoints ?? []) this.noteThreadSkillsHistogram(bucket, metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
          } else if (metric.name && THREAD_SKILLS_HISTOGRAMS[metric.name]) {
            const histKey = THREAD_SKILLS_HISTOGRAMS[metric.name]!;
            const bucket = (this.telemetry.skills.threads as any)[histKey];
            const temporality = metric.histogram?.aggregationTemporality;
            for (const dataPoint of metric.histogram?.dataPoints ?? []) {
              this.noteThreadSkillsHistogram(bucket, metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
            }
          } else if (metric.name === 'codex.sqlite.init.count' || metric.name === 'codex.sqlite.fallback.count') {
            const collection = metric.name.endsWith('fallback.count') ? this.telemetry.sqlite.fallbacks : this.telemetry.sqlite.init;
            const temporality = metric.sum?.aggregationTemporality;
            for (const dataPoint of metric.sum?.dataPoints ?? []) this.noteSqliteCounter(collection, metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
          } else if (metric.name === 'codex.sqlite.init.duration_ms') {
            const temporality = metric.histogram?.aggregationTemporality;
            for (const dataPoint of metric.histogram?.dataPoints ?? []) {
              const attributes = otelAttributes(dataPoint.attributes);
              const identity = { db: safeMetricLabel(attributes.db), status: safeMetricLabel(attributes.status) };
              const count = this.otelSeriesDelta(otelSeriesKey(`${metric.name}#count`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ count: dataPoint.count }, 'count'), temporality);
              const sum = this.otelSeriesDelta(otelSeriesKey(`${metric.name}#sum`, identity, dataPoint.startTimeUnixNano), dataPoint.timeUnixNano, numberAttribute({ sum: dataPoint.sum }, 'sum'), temporality);
              const bucket = this.sqliteDurationBucket(attributes);
              bucket.count += count;
              bucket.sum += sum;
            }
          } else if (metric.name === 'codex.tool.call') {
            const temporality = metric.sum?.aggregationTemporality;
            const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
            for (const dataPoint of metric.sum?.dataPoints ?? []) this.noteToolCounter(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality, resourceAttributes);
          } else if (metric.name === 'codex.tool_result') {
            const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
            this.noteToolResultCounter(metric.name, resourceAttributes, metric.sum?.dataPoints ?? [], metric.sum?.aggregationTemporality);
            const histogramTemporality = metric.histogram?.aggregationTemporality;
            if (metric.histogram?.dataPoints?.length) this.noteToolResultDuration(metric.name, resourceAttributes, metric.histogram.dataPoints, histogramTemporality);
          } else if (metric.name === 'codex.tool.call.duration_ms') {
            const temporality = metric.histogram?.aggregationTemporality;
            const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
            for (const dataPoint of metric.histogram?.dataPoints ?? []) this.noteToolDuration(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality, resourceAttributes);
          } else if (metric.name === 'codex.hooks.run') {
            const temporality = metric.sum?.aggregationTemporality;
            const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
            for (const dataPoint of metric.sum?.dataPoints ?? []) this.noteHookCounter(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality, resourceAttributes);
            const histogramTemporality = metric.histogram?.aggregationTemporality;
            for (const dataPoint of metric.histogram?.dataPoints ?? []) this.noteHookHistogramCount(metric.name, otelAttributes(dataPoint.attributes), dataPoint, histogramTemporality, resourceAttributes);
          } else if (metric.name === 'codex.hooks.run.duration_ms') {
            const temporality = metric.histogram?.aggregationTemporality;
            const resourceAttributes = otelAttributes(resourceMetric.resource?.attributes);
            for (const dataPoint of metric.histogram?.dataPoints ?? []) this.noteHookDuration(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality, resourceAttributes);
          } else if (metric.name === 'codex.thread.started') {
            const temporality = metric.sum?.aggregationTemporality;
            for (const dataPoint of metric.sum?.dataPoints ?? []) this.noteThreadStarted(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
            const histogramTemporality = metric.histogram?.aggregationTemporality;
            for (const dataPoint of metric.histogram?.dataPoints ?? []) this.noteHistogramCount(this.telemetry.threads.started, metric.name, otelAttributes(dataPoint.attributes), dataPoint, histogramTemporality);
          } else if (metric.name === 'codex.multi_agent.spawn') {
            const temporality = metric.sum?.aggregationTemporality;
            for (const dataPoint of metric.sum?.dataPoints ?? []) this.noteThreadSpawn(metric.name, otelAttributes(dataPoint.attributes), dataPoint, temporality);
            const histogramTemporality = metric.histogram?.aggregationTemporality;
            for (const dataPoint of metric.histogram?.dataPoints ?? []) this.noteThreadSpawn(metric.name, otelAttributes(dataPoint.attributes), { ...dataPoint, asInt: dataPoint.count }, histogramTemporality);
          }
        }
      }
    }
  }

  ingestOtelSignal(signal: OtelSignal, payload: any): void {
    if (this.telemetry.receiver[signal] !== undefined) {
      this.telemetry.receiver[signal] += 1;
    }
    this.telemetry.receiver.lastReceivedAt = new Date().toISOString();
    let ingestPayload = payload;
    if (isAutodevAttributesEnabled()) {
      const enriched = autodevEnrichOtlpPayload(signal, payload);
      if (enriched) ingestPayload = enriched;
    }
    if (signal === 'logs') this.ingestOtelLogs(ingestPayload);
    if (signal === 'traces') this.ingestOtelTraces(ingestPayload);
    if (signal === 'metrics') this.ingestOtelMetrics(ingestPayload);
    this.onSchedulePersist?.();
  }

  recordBridgeToolObservation({ event, context }: { event: any; context: any }): void {
    const tool = typeof event.tool === 'string' && event.tool.trim() ? safeMetricLabel(event.tool) : null;
    if (!tool) return;
    const server = typeof event.server === 'string' && event.server.trim() ? safeMetricLabel(event.server) : null;
    const workspaceKey = typeof context.workspace === 'string' ? context.workspace : null;
    const callId = typeof event.callId === 'string' && event.callId.trim() ? event.callId.trim() : null;
    const status = event.type === 'tool_unavailable'
      ? 'unavailable'
      : event.status === 'error' || event.status === 'failure'
        ? 'error'
        : event.status === 'ok' || event.status === 'success'
          ? 'ok'
          : 'unknown';
    let bucket: BridgeToolBucket;
    if (event.type === 'tool_executed') bucket = this.telemetry.bridgeEvents.toolExecuted;
    else if (event.type === 'tool_requested') bucket = this.telemetry.bridgeEvents.toolRequested;
    else bucket = this.telemetry.bridgeEvents.toolUnavailable;
    bucket.total += 1;
    const ctx = this.resolveTelemetryContext(event, {}, { context });
    this.noteContextDimension('bridge', ctx);
    if (server) {
      const mcp = this.mcpServer(server);
      this.noteMcpDimension(mcp, 'byRole', ctx.role, ctx, 'observed');
      this.noteMcpDimension(mcp, 'byWorkspace', ctx.workspace, ctx, 'observed');
      this.noteMcpDimension(mcp, 'byModel', ctx.model, ctx, 'observed');
      this.noteMcpDimension(mcp, 'byAgent', ctx.agent, ctx, 'observed');
      if (ctx.workspace !== UNATTRIBUTED_DIMENSION && event.type === 'tool_executed') {
        const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, ctx.workspace);
        wsBucket.mcpCapable = true;
        wsBucket.byMcp[server] = (wsBucket.byMcp[server] ?? 0) + 1;
      }
    }
    const toolBucketKey = callId ? `${tool}::${callId}` : tool;
    const toolRow = bucket.byTool.get(toolBucketKey) ?? { tool, server: server ?? '', callId: callId ?? null, count: 0, byStatus: {} };
    toolRow.count += 1;
    if (server && !toolRow.server) toolRow.server = server;
    const statusKey = status as string;
    (toolRow.byStatus as Record<string, number>)[statusKey] = ((toolRow.byStatus as Record<string, number>)[statusKey] ?? 0) + 1;
    bucket.byTool.set(toolBucketKey, toolRow);
    if (workspaceKey) {
      const wsRow = bucket.byWorkspace.get(workspaceKey) ?? { workspaceKey, count: 0, byTool: new Map(), byStatus: {} };
      wsRow.count += 1;
      (wsRow.byStatus as Record<string, number>)[statusKey] = ((wsRow.byStatus as Record<string, number>)[statusKey] ?? 0) + 1;
      const wsToolRow = wsRow.byTool.get(tool) ?? { tool, server: server ?? '', count: 0, byStatus: {} };
      wsToolRow.count += 1;
      if (server && !wsToolRow.server) wsToolRow.server = server;
      (wsToolRow.byStatus as Record<string, number>)[statusKey] = ((wsToolRow.byStatus as Record<string, number>)[statusKey] ?? 0) + 1;
      wsRow.byTool.set(tool, wsToolRow);
      bucket.byWorkspace.set(workspaceKey, wsRow);
    }
    if (event.type === 'tool_unavailable') {
      const reason = typeof event.reason === 'string' && event.reason.trim() ? event.reason.trim().slice(0, 64) : 'denied';
      bucket.byReason = bucket.byReason ?? {};
      bucket.byReason[reason] = (bucket.byReason[reason] ?? 0) + 1;
    }
    if (workspaceKey && event.type === 'tool_executed') {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, workspaceKey);
      wsBucket.toolsCapable = true;
      wsBucket.toolsExecuted = (wsBucket.toolsExecuted ?? 0) + 1;
      const toolBucket = wsBucket.bridgeObservations.tools.get(tool) ?? { tool, server: server ?? '', count: 0, byStatus: {} };
      toolBucket.count += 1;
      if (server && !toolBucket.server) toolBucket.server = server;
      toolBucket.byStatus[status] = (toolBucket.byStatus[status] ?? 0) + 1;
      wsBucket.bridgeObservations.tools.set(tool, toolBucket);
    }
    if (workspaceKey && event.type === 'tool_requested') {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, workspaceKey);
      wsBucket.toolsRequested = (wsBucket.toolsRequested ?? 0) + 1;
    }
    if (workspaceKey && event.type === 'tool_unavailable') {
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, workspaceKey);
      wsBucket.toolsUnavailable = (wsBucket.toolsUnavailable ?? 0) + 1;
    }
  }

  recordMcpExposure({ server, source = null, context, requestId = null }: { server: string; source?: string | null; context: any; requestId?: string | null }): boolean {
    if (typeof server !== 'string' || !server.trim()) return false;
    const cleanServer = safeMetricLabel(server);
    const mcpContext = this.resolveTelemetryContext({}, {}, { context });
    const workspaceKey = typeof mcpContext.workspace === 'string' ? mcpContext.workspace : null;
    const store = this.telemetry.bridgeEvents.mcpExposed;
    const dedupeKey = requestId ? `${requestId}\0${workspaceKey ?? UNATTRIBUTED_DIMENSION}\0${cleanServer}` : null;
    if (dedupeKey && store.seenKeys?.has(dedupeKey)) return false;
    if (dedupeKey) store.seenKeys?.add(dedupeKey);
    const cleanSource = typeof source === 'string' && source.trim() ? safeMetricLabel(source) : null;
    this.noteContextDimension('bridge', mcpContext);
    store.total += 1;
    const serverRow = store.byServer.get(cleanServer) ?? { server: cleanServer, source: cleanSource ?? '', count: 0 };
    serverRow.count += 1;
    if (cleanSource && !serverRow.source) serverRow.source = cleanSource;
    store.byServer.set(cleanServer, serverRow);
    if (workspaceKey) {
      const wsRow = store.byWorkspace.get(workspaceKey) ?? { workspaceKey, count: 0, byServer: new Map() };
      wsRow.count += 1;
      wsRow.byServer.set(cleanServer, (wsRow.byServer.get(cleanServer) ?? 0) + 1);
      store.byWorkspace.set(workspaceKey, wsRow);
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, workspaceKey);
      wsBucket.mcpCapable = true;
      const mcpRow = this.usageTracker.workspaceMcpBucket(wsBucket, cleanServer);
      mcpRow.count += 1;
    }
    const mcp = this.mcpServer(cleanServer);
    if (mcp.lastStatus === 'unknown') mcp.lastStatus = 'configured';
    this.noteMcpDimension(mcp, 'byRole', mcpContext.role, mcpContext, 'configured');
    this.noteMcpDimension(mcp, 'byWorkspace', mcpContext.workspace, mcpContext, 'configured');
    this.noteMcpDimension(mcp, 'byModel', mcpContext.model, mcpContext, 'configured');
    this.noteMcpDimension(mcp, 'byAgent', mcpContext.agent, mcpContext, 'configured');
    return true;
  }

  recordBridgeMcpExposure({ event, context, requestId = null }: { event: any; context: any; requestId?: string | null }): boolean {
    return this.recordMcpExposure({ server: event?.server, source: event?.source, context, requestId });
  }

  recordBridgeSkillExposure({ event, context }: { event: any; context: any }): void {
    const skill = typeof event.skill === 'string' && event.skill.trim() ? safeMetricLabel(event.skill) : null;
    if (!skill) return;
    const source = typeof event.source === 'string' && event.source.trim() ? safeMetricLabel(event.source) : null;
    const pluginId = typeof event.pluginId === 'string' && event.pluginId.trim() ? safeMetricLabel(event.pluginId) : null;
    const workspaceKey = typeof context.workspace === 'string' ? context.workspace : null;
    const bucket = this.telemetry.bridgeEvents.skillExposed;
    const skillContext = this.resolveTelemetryContext(event, {}, { context });
    this.noteContextDimension('bridge', skillContext);
    bucket.total += 1;
    const skillKey = `${skill}::${source ?? ''}::${pluginId ?? ''}`;
    const skillRow = bucket.bySkill.get(skillKey) ?? { skill, source: source ?? '', pluginId: pluginId ?? '', count: 0, byWorkspace: new Map() };
    skillRow.count += 1;
    bucket.bySkill.set(skillKey, skillRow);
    if (workspaceKey) {
      const wsRow = bucket.byWorkspace.get(workspaceKey) ?? { workspaceKey, count: 0, bySkill: new Map() };
      wsRow.count += 1;
      wsRow.bySkill.set(skill, (wsRow.bySkill.get(skill) ?? 0) + 1);
      bucket.byWorkspace.set(workspaceKey, wsRow);
      const wsBucket = this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, workspaceKey);
      wsBucket.skillsCapable = true;
      wsBucket.skillsExposed = (wsBucket.skillsExposed ?? 0) + 1;
      wsBucket.bridgeObservations.skills.set(skill, (wsBucket.bridgeObservations.skills.get(skill) ?? 0) + 1);
    }
  }

  recordBridgeSkillUsed({ event, context }: { event: any; context: any }): boolean {
    const skill = typeof event.skill === 'string' && event.skill.trim() ? safeMetricLabel(event.skill) : null;
    if (!skill) return false;
    const source = typeof event.source === 'string' && event.source.trim() ? safeMetricLabel(event.source) : '';
    const pluginId = typeof event.pluginId === 'string' && event.pluginId.trim() ? safeMetricLabel(event.pluginId) : '';
    const workspace = typeof context.workspace === 'string' && context.workspace.trim() ? context.workspace : UNATTRIBUTED_DIMENSION;
    const eventId = event.eventId ?? event.event_id ?? event.turnId ?? event.turn_id ?? event.callId ?? event.call_id ?? '';
    const key = [eventId || 'no-id', skill, source, pluginId, workspace].join('\0');
    const store = this.telemetry.bridgeEvents.skillUsed;
    if (store.seenKeys.has(key)) return false;
    store.seenKeys.add(key);
    while (store.seenKeys.size > 5000) {
      const first = store.seenKeys.values().next().value;
      if (first !== undefined) store.seenKeys.delete(first);
    }
    const ctx = this.resolveTelemetryContext(event, {}, { context });
    const timestamp = ctx.timestamp;
    if (ctx.workspace !== UNATTRIBUTED_DIMENSION) {
      this.usageTracker.workspaceBucket(this.usageTracker.usageTelemetry.byWorkspace, ctx.workspace).skillsCapable = true;
    }
    store.total += 1;
    const skillRow = store.bySkill.get(skill) ?? { skill, source, pluginId, count: 0 };
    skillRow.count += 1;
    store.bySkill.set(skill, skillRow);
    const wsRow = store.byWorkspace.get(ctx.workspace) ?? { workspaceKey: ctx.workspace, count: 0, bySkill: new Map() };
    wsRow.count += 1;
    wsRow.bySkill.set(skill, (wsRow.bySkill.get(skill) ?? 0) + 1);
    store.byWorkspace.set(ctx.workspace, wsRow);
    this.recordSkillUse(skill, ctx, 1, timestamp);
    return true;
  }

  resetOtelTelemetry(): void {
    this.telemetry.receiver = { logs: 0, traces: 0, metrics: 0, invalid: 0, lastReceivedAt: null };
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
      bridge: emptyContextDimensions(),
    };
    this.telemetry.turns = { prompts: 0, completed: 0, promptLength: 0, ttftMs: 0, ttftCount: 0 };
    this.telemetry.tokens = { input: 0, output: 0, cached: 0, reasoning: 0, tool: 0 };
    this.telemetry.metricInventory.clear();
    this.telemetry.tools.clear();
    this.telemetry.hooks.clear();
    this.telemetry.threads = { started: { total: 0, bySource: {} }, spawns: { total: 0, byStatus: {}, byRole: {}, byModel: {} } };
    this.telemetry.sqlite = { init: new Map(), initDurationMs: new Map(), fallbacks: new Map() };
    this.telemetry.skills.injected = { total: 0, byStatus: {}, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {}, bySkill: new Map() };
    this.telemetry.skills.used = { total: 0, bySkill: new Map(), byRole: {}, byWorkspace: {}, byModel: {}, byAgent: {}, lastSeenAt: null };
    this.telemetry.skills.turnDuration = { durationSeconds: { count: 0, sum: 0 } };
    this.telemetry.skills.threads = {
      enabled: { count: 0, sum: 0 },
      kept: { count: 0, sum: 0 },
      truncated: { count: 0, sum: 0 },
      descriptionTruncatedChars: { count: 0, sum: 0 },
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
      seenKeys: new Set(),
    };
    this.telemetry.bridgeEvents = {
      toolExecuted: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolRequested: { total: 0, byTool: new Map(), byWorkspace: new Map() },
      toolUnavailable: { total: 0, byTool: new Map(), byWorkspace: new Map(), byReason: {} },
      skillExposed: { total: 0, bySkill: new Map(), byWorkspace: new Map() },
      skillUsed: { total: 0, bySkill: new Map(), byWorkspace: new Map(), seenKeys: new Set() },
      mcpExposed: { total: 0, byServer: new Map(), byWorkspace: new Map(), seenKeys: new Set() },
    };
    this.metricSeries.clear();
    this.usageTracker.resetAttributionDiagnostics();
    this.usageTracker.clearWorkspaceCapabilities();
  }

  codexTelemetryStatus(now: number = Date.now()): any {
    const mcpModelView = this.mcpModelDimensionsView();
    const mcpServers = [...this.telemetry.mcpServers.values()].map((server) => {
      const lastSeenMs = server.lastSeenAt ? Date.parse(server.lastSeenAt) : NaN;
      const fresh = Number.isFinite(lastSeenMs) && now - lastSeenMs <= this.healthTtlMs;
      return {
        ...server,
        health: fresh ? server.lastStatus : 'stale',
        averageDurationMs: server.durationCount ? Math.round(server.durationMs / server.durationCount) : 0,
        byRole: formatMcpDimensionBuckets(server.byRole, now, this.healthTtlMs),
        byWorkspace: formatMcpDimensionBuckets(server.byWorkspace, now, this.healthTtlMs),
        byModel: formatMcpDimensionBuckets(mcpModelView.serverByModel.get(server.name) ?? server.byModel, now, this.healthTtlMs),
        byAgent: formatMcpDimensionBuckets(server.byAgent, now, this.healthTtlMs),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const sessions = [...this.telemetry.sessions.values()];
    const summarizeDimension = (dimension: 'byRole' | 'byWorkspace' | 'byModel' | 'byAgent') => {
      const summary: Record<string, any> = {};
      for (const server of mcpServers) {
        for (const [key, bucket] of Object.entries(server[dimension] ?? {})) {
          const lastSeenMs = bucket.lastSeenAt ? Date.parse(bucket.lastSeenAt) : NaN;
          const fresh = Number.isFinite(lastSeenMs) && now - lastSeenMs <= this.healthTtlMs;
          const health = fresh ? bucket.lastStatus : 'stale';
          const target = summary[key] ?? { observed: 0, ready: 0, error: 0, stale: 0, lastSeenAt: null };
          target.observed += 1;
          if (health === 'ready') target.ready += 1;
          if (health === 'error') target.error += 1;
          if (health === 'stale') target.stale += 1;
          if (!target.lastSeenAt || (bucket.lastSeenAt && Date.parse(bucket.lastSeenAt) > Date.parse(target.lastSeenAt))) target.lastSeenAt = bucket.lastSeenAt;
          summary[key] = target;
        }
      }
      return summary;
    };
    const mcpSummary: any = mcpServers.reduce(
      (summary, server) => {
        summary.observed += 1;
        if (server.health === 'ready') summary.ready += 1;
        if (server.health === 'error') summary.error += 1;
        if (server.health === 'stale') summary.stale += 1;
        return summary;
      },
      { observed: 0, ready: 0, error: 0, stale: 0 },
    );
    mcpSummary.byRole = summarizeDimension('byRole');
    mcpSummary.byWorkspace = summarizeDimension('byWorkspace');
    mcpSummary.byModel = summarizeDimension('byModel');
    mcpSummary.byAgent = summarizeDimension('byAgent');
    const skillsInjected = this.telemetry.skills.injected;
    const globalSkillInvokeTypes = Object.entries(skillsInjected.byInvokeType);
    const skillRows = [...skillsInjected.bySkill.values()].map((bucket) => {
      const byInvokeType = { ...bucket.byInvokeType };
      if (!Object.keys(byInvokeType).length && globalSkillInvokeTypes.length === 1) {
        const first = globalSkillInvokeTypes[0];
        if (first && first[1] === skillsInjected.total) {
          byInvokeType[first[0]] = bucket.total;
        }
      }
      return { ...bucket, byStatus: { ...bucket.byStatus }, byInvokeType, byAgentKind: { ...bucket.byAgentKind }, byModel: { ...bucket.byModel }, byPlugin: { ...bucket.byPlugin } };
    });
    const threadHistogram = (bucket: HistogramBucket) => ({ ...bucket, average: bucket.count ? bucket.sum / bucket.count : 0 });
    const sqliteBuckets = (collection: Map<string, any>) =>
      [...collection.values()]
        .map((bucket) => ({ ...bucket, ...(Object.hasOwn(bucket, 'sum') ? { average: bucket.count ? bucket.sum / bucket.count : 0 } : {}) }))
        .sort((a, b) => `${a.db}/${a.status}`.localeCompare(`${b.db}/${b.status}`));

    const dimensions = formatContextDimensions(this.telemetry.dimensions);
    if (dimensions.mcp) {
      dimensions.mcp.byModel = mcpModelView.dimensionByModel;
    }

    return {
      receiver: { ...this.telemetry.receiver },
      sessionsObserved: sessions.length,
      sessionsRecent: sessions.filter((session) => session.lastSeenAt && now - Date.parse(session.lastSeenAt) <= this.healthTtlMs).length,
      turns: { ...this.telemetry.turns, averageTtftMs: this.telemetry.turns.ttftCount ? Math.round(this.telemetry.turns.ttftMs / this.telemetry.turns.ttftCount) : 0 },
      tokens: { ...this.telemetry.tokens, total: Object.values(this.telemetry.tokens).reduce((sum, value) => sum + value, 0) },
      mcpSummary,
      mcpServers,
      dimensions,
      metrics: {
        observed: [...this.telemetry.metricInventory.values()].sort((a, b) => a.name.localeCompare(b.name)),
      },
      tools: {
        byTool: [...this.telemetry.tools.values()].map((tool) => ({ ...tool, averageDurationMs: tool.durationCount ? tool.durationMs / tool.durationCount : 0, byStatus: { ...tool.byStatus } })).sort((a, b) => `${a.tool}/${a.source}/${a.server}`.localeCompare(`${b.tool}/${b.source}/${b.server}`)),
      },
      hooks: {
        byHook: [...this.telemetry.hooks.values()].map((hook) => ({ ...hook, averageDurationMs: hook.durationCount ? hook.durationMs / hook.durationCount : 0, byStatus: { ...hook.byStatus } })).sort((a, b) => `${a.hook}/${a.source}/${a.handlerType}`.localeCompare(`${b.hook}/${b.source}/${b.handlerType}`)),
      },
      threads: {
        started: { total: this.telemetry.threads.started.total, bySource: { ...this.telemetry.threads.started.bySource } },
        spawns: { ...this.telemetry.threads.spawns, byStatus: { ...this.telemetry.threads.spawns.byStatus }, byRole: { ...this.telemetry.threads.spawns.byRole }, byModel: { ...this.telemetry.threads.spawns.byModel } },
      },
      sqlite: {
        init: { byDbStatus: sqliteBuckets(this.telemetry.sqlite.init), total: [...this.telemetry.sqlite.init.values()].reduce((sum, bucket) => sum + bucket.count, 0) },
        initDurationMs: { byDbStatus: sqliteBuckets(this.telemetry.sqlite.initDurationMs), totalCount: [...this.telemetry.sqlite.initDurationMs.values()].reduce((sum, bucket) => sum + bucket.count, 0), totalSum: [...this.telemetry.sqlite.initDurationMs.values()].reduce((sum, bucket) => sum + bucket.sum, 0) },
        fallbacks: { byDbStatus: sqliteBuckets(this.telemetry.sqlite.fallbacks), total: [...this.telemetry.sqlite.fallbacks.values()].reduce((sum, bucket) => sum + bucket.count, 0) },
      },
      skills: {
        used: {
          total: this.telemetry.skills.used.total,
          lastSeenAt: this.telemetry.skills.used.lastSeenAt,
          byRole: { ...this.telemetry.skills.used.byRole },
          byWorkspace: { ...this.telemetry.skills.used.byWorkspace },
          byModel: { ...this.telemetry.skills.used.byModel },
          byAgent: { ...this.telemetry.skills.used.byAgent },
          bySkill: [...this.telemetry.skills.used.bySkill.values()].map((entry) => ({
            ...entry,
            byRole: { ...entry.byRole },
            byWorkspace: { ...entry.byWorkspace },
            byModel: { ...entry.byModel },
            byAgent: { ...entry.byAgent },
          })).sort((a, b) => a.skill.localeCompare(b.skill)),
        },
        injected: {
          total: skillsInjected.total,
          byStatus: { ...skillsInjected.byStatus },
          byInvokeType: { ...skillsInjected.byInvokeType },
          byAgentKind: { ...skillsInjected.byAgentKind },
          byModel: { ...skillsInjected.byModel },
          byPlugin: { ...skillsInjected.byPlugin },
          bySkill: skillRows.sort((a, b) => a.skill.localeCompare(b.skill)),
        },
        turnDuration: {
          durationSeconds: threadHistogram(this.telemetry.skills.turnDuration.durationSeconds),
        },
        threads: {
          enabledTotal: threadHistogram(this.telemetry.skills.threads.enabled),
          keptTotal: threadHistogram(this.telemetry.skills.threads.kept),
          truncated: threadHistogram(this.telemetry.skills.threads.truncated),
          descriptionTruncatedChars: threadHistogram(this.telemetry.skills.threads.descriptionTruncatedChars),
        },
      },
      toolResults: formatToolResults(this.telemetry.toolResults),
      bridgeEvents: formatBridgeEvents(this.telemetry.bridgeEvents),
    };
  }

  otelPersistenceSnapshot(): any {
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
      mcpServers: [...this.telemetry.mcpServers.values()].map((server) => ({
        ...server,
        byRole: { ...server.byRole },
        byWorkspace: { ...server.byWorkspace },
        byModel: { ...(mcpModelView.serverByModel.get(server.name) ?? server.byModel) },
        byAgent: { ...server.byAgent },
      })),
      skills: telemetry.skills,
      metrics: telemetry.metrics,
      tools: telemetry.tools,
      hooks: telemetry.hooks,
      threads: telemetry.threads,
      sqlite: telemetry.sqlite,
      toolResults: telemetry.toolResults,
      bridgeEvents: telemetry.bridgeEvents,
      series: [...this.metricSeries.entries()].map(([key, value]) => ({ key, timestamp: value.timestamp.toString(), value: value.value })),
    };
  }

  restoreOtelCounters(snapshot: any): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.toolResults && typeof snapshot.toolResults === 'object') {
      const target = this.telemetry.toolResults;
      for (const field of ['total', 'executed', 'unattributed', 'causeResolved', 'causeUnresolved'] as const) {
        if (Number.isFinite(snapshot.toolResults[field]) && snapshot.toolResults[field] >= 0) {
          target[field] = snapshot.toolResults[field];
        }
      }
      if (snapshot.toolResults.byStatus && typeof snapshot.toolResults.byStatus === 'object') {
        for (const [k, v] of Object.entries(snapshot.toolResults.byStatus)) {
          if (Number.isFinite(v) && (v as number) >= 0) target.byStatus[safeMetricLabel(k)] = v as number;
        }
      }
      if (snapshot.toolResults.executionDurationMs && typeof snapshot.toolResults.executionDurationMs === 'object') {
        if (Number.isFinite(snapshot.toolResults.executionDurationMs.count) && snapshot.toolResults.executionDurationMs.count >= 0) {
          target.executionDurationMs.count = snapshot.toolResults.executionDurationMs.count;
        }
        if (Number.isFinite(snapshot.toolResults.executionDurationMs.sum) && snapshot.toolResults.executionDurationMs.sum >= 0) {
          target.executionDurationMs.sum = snapshot.toolResults.executionDurationMs.sum;
        }
      }
    }
    if (snapshot.bridgeEvents && typeof snapshot.bridgeEvents === 'object') {
      const target = this.telemetry.bridgeEvents as any;
      for (const family of ['toolExecuted', 'toolRequested', 'toolUnavailable', 'skillExposed', 'skillUsed', 'mcpExposed']) {
        const source = snapshot.bridgeEvents[family];
        const destination = target[family];
        if (!source || typeof source !== 'object') continue;
        if (Number.isFinite(source.total) && source.total >= 0) destination.total = source.total;
        if (family === 'skillUsed') {
          for (const entry of source.bySkill ?? []) {
            if (!entry || typeof entry.skill !== 'string' || !Number.isFinite(entry.count)) continue;
            destination.bySkill.set(safeMetricLabel(entry.skill), { skill: safeMetricLabel(entry.skill), source: safeMetricLabel(entry.source, ''), pluginId: safeMetricLabel(entry.pluginId, ''), count: entry.count });
          }
          for (const row of source.byWorkspace ?? []) {
            if (!row || typeof row.workspaceKey !== 'string' || !Number.isFinite(row.count)) continue;
            destination.byWorkspace.set(safeMetricLabel(row.workspaceKey), {
              workspaceKey: safeMetricLabel(row.workspaceKey),
              count: row.count,
              bySkill: new Map(Object.entries(Object.fromEntries((row.bySkill ?? []).filter((entry: any) => entry && typeof entry.skill === 'string' && Number.isFinite(entry.count)).map((entry: any) => [safeMetricLabel(entry.skill), entry.count])))),
            });
          }
        }
        if (family === 'mcpExposed') {
          for (const entry of source.byServer ?? []) {
            if (!entry || typeof entry.server !== 'string' || !Number.isFinite(entry.count)) continue;
            destination.byServer.set(safeMetricLabel(entry.server), { server: safeMetricLabel(entry.server), source: safeMetricLabel(entry.source, ''), count: entry.count });
          }
          for (const row of source.byWorkspace ?? []) {
            if (!row || typeof row.workspaceKey !== 'string' || !Number.isFinite(row.count)) continue;
            destination.byWorkspace.set(safeMetricLabel(row.workspaceKey), {
              workspaceKey: safeMetricLabel(row.workspaceKey),
              count: row.count,
              byServer: new Map(Object.entries(Object.fromEntries((row.byServer ?? []).filter((entry: any) => entry && typeof entry.server === 'string' && Number.isFinite(entry.count)).map((entry: any) => [safeMetricLabel(entry.server), entry.count])))),
            });
          }
        }
        if (source.byReason && typeof source.byReason === 'object') {
          for (const [k, v] of Object.entries(source.byReason)) {
            if (Number.isFinite(v) && (v as number) >= 0) destination.byReason[safeMetricLabel(k)] = v;
          }
        }
      }
    }
  }

  restoreOtelTelemetry(snapshot: any): void {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== OTEL_PERSISTENCE_SCHEMA_VERSION) return;
    const isFiniteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const restoreNumberFields = (target: any, source: any, fields: string[]) => {
      for (const field of fields) if (isFiniteNonnegative(source?.[field])) target[field] = source[field];
    };
    this.restoreOtelCounters(snapshot);
    restoreNumberFields(this.telemetry.receiver, snapshot.receiver, ['logs', 'traces', 'metrics', 'invalid']);
    if (snapshot.receiver?.lastReceivedAt === null || typeof snapshot.receiver?.lastReceivedAt === 'string') {
      this.telemetry.receiver.lastReceivedAt = snapshot.receiver.lastReceivedAt;
    }
    restoreNumberFields(this.telemetry.turns, snapshot.turns, ['prompts', 'completed', 'promptLength', 'ttftMs', 'ttftCount']);
    restoreNumberFields(this.telemetry.tokens, snapshot.tokens, ['input', 'output', 'cached', 'reasoning', 'tool']);
    if (snapshot.dimensions && typeof snapshot.dimensions === 'object') {
      for (const [family, value] of Object.entries(snapshot.dimensions as Record<string, any>)) {
        if (!this.telemetry.dimensions[family as keyof OtelTelemetryState['dimensions']] || !value || typeof value !== 'object') continue;
        for (const dimension of ['byRole', 'byWorkspace', 'byModel', 'byAgent'] as const) {
          for (const [key, bucket] of Object.entries(value[dimension] ?? {})) {
            if (!bucket || typeof bucket !== 'object' || !isFiniteNonnegative((bucket as any).count)) continue;
            this.telemetry.dimensions[family as keyof OtelTelemetryState['dimensions']][dimension][safeMetricLabel(key)] = {
              count: (bucket as any).count,
              lastSeenAt: typeof (bucket as any).lastSeenAt === 'string' ? (bucket as any).lastSeenAt : null,
              ...(dimension === 'byAgent' ? { agentKind: safeMetricLabel((bucket as any).agentKind, UNATTRIBUTED_DIMENSION) } : {}),
            };
          }
        }
      }
    }
    for (const server of Array.isArray(snapshot.mcpServers) ? snapshot.mcpServers : []) {
      if (!server || typeof server !== 'object' || typeof server.name !== 'string' || !server.name) continue;
      const restored: McpServerEntry = {
        name: safeMetricLabel(server.name),
        lastSeenAt: typeof server.lastSeenAt === 'string' ? server.lastSeenAt : null,
        initAttempts: 0,
        toolDiscoveryAttempts: 0,
        failures: 0,
        durationMs: 0,
        durationCount: 0,
        lastStatus: safeMetricLabel(server.lastStatus),
        byRole: {},
        byWorkspace: {},
        byModel: {},
        byAgent: {},
      };
      restoreNumberFields(restored, server, ['initAttempts', 'toolDiscoveryAttempts', 'failures', 'durationMs', 'durationCount']);
      for (const dim of ['byRole', 'byWorkspace', 'byModel', 'byAgent'] as const) {
        if (server[dim] && typeof server[dim] === 'object') {
          for (const [k, v] of Object.entries(server[dim])) {
            if (isFiniteNonnegative(v)) {
              restored[dim][safeMetricLabel(k)] = { observed: 1, lastSeenAt: null, lastStatus: 'observed' };
            } else if (v && typeof v === 'object' && isFiniteNonnegative((v as any).observed)) {
              restored[dim][safeMetricLabel(k)] = {
                observed: 1,
                lastSeenAt: typeof (v as any).lastSeenAt === 'string' ? (v as any).lastSeenAt : null,
                lastStatus: safeMetricLabel((v as any).lastStatus, 'observed'),
                ...(dim === 'byAgent' ? { agentKind: safeMetricLabel((v as any).agentKind, UNATTRIBUTED_DIMENSION) } : {}),
              };
            }
          }
        }
      }
      this.telemetry.mcpServers.set(restored.name, restored);
    }
    const skills = snapshot.skills;
    if (skills?.injected && typeof skills.injected === 'object') {
      restoreNumberFields(this.telemetry.skills.injected, skills.injected, ['total']);
      for (const [status, count] of Object.entries(skills.injected.byStatus ?? {})) if (isFiniteNonnegative(count)) this.telemetry.skills.injected.byStatus[safeMetricLabel(status)] = count;
      for (const [invokeType, count] of Object.entries(skills.injected.byInvokeType ?? {})) if (isFiniteNonnegative(count)) this.telemetry.skills.injected.byInvokeType[safeMetricLabel(invokeType)] = count;
      for (const [agentKind, count] of Object.entries(skills.injected.byAgentKind ?? {})) if (isFiniteNonnegative(count)) this.telemetry.skills.injected.byAgentKind[safeMetricLabel(agentKind)] = count;
      for (const [model, count] of Object.entries(skills.injected.byModel ?? {})) if (isFiniteNonnegative(count)) this.telemetry.skills.injected.byModel[safeMetricLabel(model)] = count;
      for (const [plugin, count] of Object.entries(skills.injected.byPlugin ?? {})) if (isFiniteNonnegative(count)) this.telemetry.skills.injected.byPlugin[safeMetricLabel(plugin)] = count;
      for (const entry of Array.isArray(skills.injected.bySkill) ? skills.injected.bySkill : []) {
        if (!entry || typeof entry.skill !== 'string') continue;
        const bucket = this.skillBucket(safeMetricLabel(entry.skill));
        restoreNumberFields(bucket, entry, ['total']);
        for (const [status, count] of Object.entries(entry.byStatus ?? {})) if (isFiniteNonnegative(count)) bucket.byStatus[safeMetricLabel(status)] = count;
        for (const [invokeType, count] of Object.entries(entry.byInvokeType ?? {})) if (isFiniteNonnegative(count)) bucket.byInvokeType[safeMetricLabel(invokeType)] = count;
        for (const [agentKind, count] of Object.entries(entry.byAgentKind ?? {})) if (isFiniteNonnegative(count)) bucket.byAgentKind[safeMetricLabel(agentKind)] = count;
        for (const [model, count] of Object.entries(entry.byModel ?? {})) if (isFiniteNonnegative(count)) bucket.byModel[safeMetricLabel(model)] = count;
        for (const [plugin, count] of Object.entries(entry.byPlugin ?? {})) if (isFiniteNonnegative(count)) bucket.byPlugin[safeMetricLabel(plugin)] = count;
      }
    }
    const used = snapshot.skills?.used;
    if (used && typeof used === 'object') {
      restoreNumberFields(this.telemetry.skills.used, used, ['total']);
      if (typeof used.lastSeenAt === 'string') this.telemetry.skills.used.lastSeenAt = used.lastSeenAt;
      for (const dimension of ['byRole', 'byWorkspace', 'byModel', 'byAgent'] as const) {
        for (const [key, count] of Object.entries(used[dimension] ?? {})) if (isFiniteNonnegative(count)) this.telemetry.skills.used[dimension][safeMetricLabel(key)] = count;
      }
      for (const entry of Array.isArray(used.bySkill) ? used.bySkill : []) {
        if (!entry || typeof entry.skill !== 'string') continue;
        const bucket = this.skillUsedBucket(safeMetricLabel(entry.skill));
        restoreNumberFields(bucket, entry, ['total']);
        if (typeof entry.lastSeenAt === 'string') bucket.lastSeenAt = entry.lastSeenAt;
        for (const dimension of ['byRole', 'byWorkspace', 'byModel', 'byAgent'] as const) {
          for (const [key, count] of Object.entries(entry[dimension] ?? {})) if (isFiniteNonnegative(count)) bucket[dimension][safeMetricLabel(key)] = count;
        }
      }
    }
    for (const [targetKey, sourceKey] of [
      ['enabled', 'enabledTotal'],
      ['kept', 'keptTotal'],
      ['truncated', 'truncated'],
      ['descriptionTruncatedChars', 'descriptionTruncatedChars'],
    ] as const) {
      restoreNumberFields((this.telemetry.skills.threads as any)[targetKey], skills?.threads?.[sourceKey], ['count', 'sum']);
    }
    for (const entry of Array.isArray(snapshot.metrics?.observed) ? snapshot.metrics.observed : []) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || REMOVED_SHADOW_SELECTION_METRICS.has(entry.name)) continue;
      const restored = { name: safeMetricLabel(entry.name), exports: 0, dataPoints: 0 };
      restoreNumberFields(restored, entry, ['exports', 'dataPoints']);
      this.telemetry.metricInventory.set(restored.name, restored);
    }
    for (const entry of Array.isArray(snapshot.tools?.byTool) ? snapshot.tools.byTool : []) {
      if (!entry || typeof entry.tool !== 'string') continue;
      if (entry.tool === 'unknown-tool') continue;
      const restored: ToolEntry = {
        tool: safeMetricLabel(entry.tool, 'unknown-tool'),
        source: safeMetricLabel(entry.source),
        server: toolServerAttribute({ server: entry.server, mcp_server: entry.mcp_server }),
        count: 0,
        byStatus: {},
        durationCount: 0,
        durationMs: 0,
      };
      restoreNumberFields(restored, entry, ['count', 'durationCount', 'durationMs']);
      for (const [status, count] of Object.entries(entry.byStatus ?? {})) if (isFiniteNonnegative(count)) restored.byStatus[safeMetricLabel(status)] = count;
      this.telemetry.tools.set(toolKey(restored), restored);
    }
    for (const entry of Array.isArray(snapshot.hooks?.byHook) ? snapshot.hooks.byHook : []) {
      if (!entry || typeof entry.hook !== 'string') continue;
      const restored: HookEntry = {
        hook: safeMetricLabel(entry.hook, 'unknown-hook'),
        source: safeMetricLabel(entry.source),
        handlerType: safeMetricLabel(entry.handlerType, ''),
        count: 0,
        byStatus: {},
        durationCount: 0,
        durationMs: 0,
      };
      restoreNumberFields(restored, entry, ['count', 'durationCount', 'durationMs']);
      for (const [status, count] of Object.entries(entry.byStatus ?? {})) if (isFiniteNonnegative(count)) restored.byStatus[safeMetricLabel(status)] = count;
      this.telemetry.hooks.set(hookKey({ hook_name: restored.hook, source: restored.source, handler_type: restored.handlerType }), restored);
    }
    restoreNumberFields(this.telemetry.threads.started, snapshot.threads?.started, ['total']);
    for (const [source, count] of Object.entries(snapshot.threads?.started?.bySource ?? {})) if (isFiniteNonnegative(count)) this.telemetry.threads.started.bySource[safeMetricLabel(source)] = count;
    restoreNumberFields(this.telemetry.threads.spawns, snapshot.threads?.spawns, ['total']);
    for (const target of ['byStatus', 'byRole', 'byModel'] as const) {
      for (const [key, count] of Object.entries(snapshot.threads?.spawns?.[target] ?? {})) {
        if (isFiniteNonnegative(count)) this.telemetry.threads.spawns[target][safeMetricLabel(key)] = count;
      }
    }
    const sqlite = snapshot.sqlite;
    for (const [target, source] of [
      [this.telemetry.sqlite.init, sqlite?.init?.byDbStatus],
      [this.telemetry.sqlite.fallbacks, sqlite?.fallbacks?.byDbStatus],
      [this.telemetry.sqlite.initDurationMs, sqlite?.initDurationMs?.byDbStatus],
    ] as const) {
      for (const entry of Array.isArray(source) ? source : []) {
        if (!entry || typeof entry.db !== 'string' || typeof entry.status !== 'string') continue;
        const restored: any = { db: safeMetricLabel(entry.db), status: safeMetricLabel(entry.status), count: 0 };
        restoreNumberFields(restored, entry, ['count']);
        if (Object.hasOwn(entry, 'sum')) {
          restored.sum = 0;
          restoreNumberFields(restored, entry, ['sum']);
        }
        target.set(sqliteKey(restored), restored);
      }
    }
    for (const entry of Array.isArray(snapshot.series) ? snapshot.series : []) {
      if (!entry || typeof entry.key !== 'string' || typeof entry.timestamp !== 'string' || !isFiniteNonnegative(entry.value)) continue;
      const metricName = entry.key.split('::', 1)[0].replace(/#(?:count|sum)$/, '');
      if (REMOVED_SHADOW_SELECTION_METRICS.has(metricName)) continue;
      try {
        this.metricSeries.set(entry.key, { timestamp: BigInt(entry.timestamp), value: entry.value });
      } catch {
        /* Ignore malformed cursors. */
      }
    }
  }
}

let defaultOtelTracker = new OtelTracker();

export function getDefaultOtelTracker(): OtelTracker {
  return defaultOtelTracker;
}

export function setDefaultOtelTracker(tracker: OtelTracker): void {
  defaultOtelTracker = tracker;
}

export const otelTelemetry: OtelTelemetryState = new Proxy({} as OtelTelemetryState, {
  get(_target, prop) {
    return (defaultOtelTracker.telemetry as any)[prop];
  },
  set(_target, prop, value) {
    (defaultOtelTracker.telemetry as any)[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in defaultOtelTracker.telemetry;
  },
  ownKeys(_target) {
    return Reflect.ownKeys(defaultOtelTracker.telemetry);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(defaultOtelTracker.telemetry, prop) ?? {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (defaultOtelTracker.telemetry as any)[prop],
    };
  },
});

export const otelMetricSeries: Map<string, { timestamp: bigint; value: number }> = new Proxy(new Map(), {
  get(_target, prop) {
    const val = (defaultOtelTracker.metricSeries as any)[prop];
    return typeof val === 'function' ? val.bind(defaultOtelTracker.metricSeries) : val;
  },
  set(_target, prop, value) {
    (defaultOtelTracker.metricSeries as any)[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in defaultOtelTracker.metricSeries;
  },
});

export const pendingMcpModelAttribution: Map<string, Array<{ serverName: string; context: TelemetryContext; status: string }>> = new Proxy(new Map(), {
  get(_target, prop) {
    const val = (defaultOtelTracker.pendingMcpModelAttribution as any)[prop];
    return typeof val === 'function' ? val.bind(defaultOtelTracker.pendingMcpModelAttribution) : val;
  },
  set(_target, prop, value) {
    (defaultOtelTracker.pendingMcpModelAttribution as any)[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in defaultOtelTracker.pendingMcpModelAttribution;
  },
});

export function mcpServer(name: string): McpServerEntry {
  return defaultOtelTracker.mcpServer(name);
}

export function telemetryConversationId(attributes: any = {}, resourceAttributes: any = {}, options: any = {}): string | null {
  return defaultOtelTracker.telemetryConversationId(attributes, resourceAttributes, options);
}

export function resolveTelemetryContext(attributes: any = {}, resourceAttributes: any = {}, options: any = {}): TelemetryContext {
  return defaultOtelTracker.resolveTelemetryContext(attributes, resourceAttributes, options);
}

export function ingestOtelLogs(payload: any): void {
  defaultOtelTracker.ingestOtelLogs(payload);
}

export function ingestOtelTraces(payload: any): void {
  defaultOtelTracker.ingestOtelTraces(payload);
}

export function ingestOtelMetrics(payload: any): void {
  defaultOtelTracker.ingestOtelMetrics(payload);
}

export function ingestOtelSignal(signal: OtelSignal, payload: any): void {
  defaultOtelTracker.ingestOtelSignal(signal, payload);
}

export function recordBridgeToolObservation({ event, context }: { event: any; context: any }): void {
  defaultOtelTracker.recordBridgeToolObservation({ event, context });
}

export function recordMcpExposure({ server, source = null, context, requestId = null }: { server: string; source?: string | null; context: any; requestId?: string | null }): boolean {
  return defaultOtelTracker.recordMcpExposure({ server, source, context, requestId });
}

export function recordBridgeMcpExposure({ event, context, requestId = null }: { event: any; context: any; requestId?: string | null }): boolean {
  return defaultOtelTracker.recordBridgeMcpExposure({ event, context, requestId });
}

export function recordBridgeSkillExposure({ event, context }: { event: any; context: any }): void {
  defaultOtelTracker.recordBridgeSkillExposure({ event, context });
}

export function recordBridgeSkillUsed({ event, context }: { event: any; context: any }): boolean {
  return defaultOtelTracker.recordBridgeSkillUsed({ event, context });
}

export function resetOtelTelemetry(): void {
  defaultOtelTracker.resetOtelTelemetry();
}

export function codexTelemetryStatus(now: number = Date.now()): any {
  return defaultOtelTracker.codexTelemetryStatus(now);
}

export function otelPersistenceSnapshot(): any {
  return defaultOtelTracker.otelPersistenceSnapshot();
}

export function restoreOtelTelemetry(snapshot: any): void {
  defaultOtelTracker.restoreOtelTelemetry(snapshot);
}
