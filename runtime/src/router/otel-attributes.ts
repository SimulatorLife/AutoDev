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

/**
 * The three fields each signal's ingestion walks, outermost first.
 *
 * `ingestOtelLogs` iterates `resourceLogs` -> `scopeLogs` -> `logRecords`, and
 * the traces and metrics readers walk the same three levels under their own
 * names. Those nine `for...of` loops are the whole reason a payload needs
 * checking: each reads its field as `field ?? []`, which tolerates a missing
 * field and nothing else. `resourceLogs: {}` throws `is not iterable`,
 * `resourceLogs: "oops"` iterates per character, and `scopeLogs: [null]`
 * throws one level in.
 */
const OTEL_SIGNAL_FIELDS = {
  logs: { batch: "resourceLogs", scopes: "scopeLogs", records: "logRecords" },
  traces: {
    batch: "resourceSpans",
    scopes: "scopeSpans",
    records: "spans"
  },
  metrics: {
    batch: "resourceMetrics",
    scopes: "scopeMetrics",
    records: "metrics"
  }
} as const;

function isOtelRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `holder[field]` as an array of records, or the reason it is not one.
 *
 * An absent or null field is an empty array, which OTLP/HTTP permits and which
 * is exactly what the `?? []` at every one of those call sites assumed.
 */
function otelRecordArray(
  holder: Record<string, unknown>,
  field: string,
  path: string
): readonly Record<string, unknown>[] | string {
  const nested = holder[field];
  if (nested === undefined || nested === null) return [];
  if (!Array.isArray(nested))
    return `OTLP body field "${path}" must be an array.`;
  for (const element of nested)
    if (!isOtelRecord(element))
      return `OTLP body field "${path}" must contain objects.`;
  // Every element was just checked, so the cast states a proven fact rather
  // than replacing a check.
  return nested as readonly Record<string, unknown>[];
}

/**
 * Why `value` is not an OTLP payload for `signal`, or `null` when it is one.
 *
 * `OtelPayload` is an optional-everything shape and every field it names is
 * read as `field ?? []` downstream, so the compiler's guarantee was worthless:
 * the HTTP route hands this function `JSON.parse` output, and a signature
 * asserting `OtelPayload` checked nothing. A body that was perfectly valid JSON
 * could therefore be reported as "must be valid JSON" -- sending an operator to
 * debug bytes that were always well-formed -- while the same body was counted
 * as both received and invalid, because the receiver counter moved before
 * anything looked at it. A string where a batch array belongs was worse still:
 * it ingested nothing, answered 200, and incremented the received count, so the
 * receiver reported telemetry arriving that carried no telemetry at all.
 *
 * The check is deliberately bounded to the three iterated levels rather than the
 * OTLP schema. Records are read with optional chaining and never indexed, so
 * below that point a partial record is harmless; a full schema check would
 * reject payloads the receiver reads perfectly well.
 */
function otelPayloadShapeError(
  signal: OtelSignal,
  value: unknown
): string | null {
  if (!isOtelRecord(value))
    return `OTLP ${signal} body must be a JSON object.`;
  const { batch: batchField, scopes: scopeField, records: recordField } =
    OTEL_SIGNAL_FIELDS[signal];

  const batches = otelRecordArray(value, batchField, batchField);
  if (typeof batches === "string") return `OTLP ${signal} ${batches}`;
  for (const batch of batches) {
    const scopePath = `${batchField}[].${scopeField}`;
    const scopes = otelRecordArray(batch, scopeField, scopePath);
    if (typeof scopes === "string") return `OTLP ${signal} ${scopes}`;
    for (const scope of scopes) {
      const recordPath = `${scopePath}[]`;
      const records = otelRecordArray(scope, recordField, recordPath);
      if (typeof records === "string") return `OTLP ${signal} ${records}`;
    }
  }
  return null;
}

export type OtelPayloadCheck =
  | {
      readonly ok: true;
      /** Narrowed to both shapes, because it provably is both. */
      readonly payload: OtelPayload & Record<string, unknown>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Validates an untrusted OTLP body once, for a caller that must both reject a
 * bad shape and keep a good one typed.
 *
 * One call rather than a predicate plus a message accessor, so a caller cannot
 * check the shape and then report a different rule's wording, and so the
 * success path narrows without a cast.
 */
export function checkOtelPayload(
  signal: OtelSignal,
  value: unknown
): OtelPayloadCheck {
  const message = otelPayloadShapeError(signal, value);
  if (message !== null) return { ok: false, message };
  return { ok: true, payload: value as OtelPayload & Record<string, unknown> };
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
