/**
 * The OTLP wire shapes, how a raw OTLP value becomes an attribute, and the
 * AutoDev attribute vocabulary layered on top of both.
 *
 * This is the attribute layer of `otel.ts`: it knows nothing about the tracker,
 * its state, or how telemetry is aggregated -- only the shapes a payload arrives
 * in and the names AutoDev publishes on it. Keeping it apart means the two
 * halves of that concern change independently: a new OTLP value type, or a new
 * AutoDev alias, is an edit here and never a reach into telemetry aggregation.
 *
 * `otel.ts` re-exports everything below, so this is an ownership split rather
 * than a second entry point for callers to choose between.
 */
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

export type OtelSignal = "logs" | "traces" | "metrics";

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
  isMonotonic?: boolean;
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

export function otelAttributeValue(
  value: OtelAttributeValueRaw | string | number | boolean | null | undefined
): unknown {
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

export function otelAttributes(
  attributes: OtelAttributeMap | OtelAttributesInput = []
): OtelAttributeMap {
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

export function numberAttribute(
  attributes: OtelAttributeMap,
  ...keys: string[]
): number {
  for (const key of keys) {
    const value = Number(attributes?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
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

export function isAutodevSpawnLogAttributes(
  attributes: OtelAttributesInput
): boolean {
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
