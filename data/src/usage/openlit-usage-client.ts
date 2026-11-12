import {
  deriveContextCompactionRatePercent,
  deriveProviderHopRatePercent,
  isOpenTelemetrySpanId,
  isOpenTelemetryTraceId,
  safeAutoDevSessionId,
  USAGE_VARIABLE_IDS,
  type UsageBreakdownCount,
  type UsageCompactionUnsupportedFilter,
  type UsageFilterOptions,
  type UsageFilterSelection,
  type UsageGitChangeMetrics,
  type UsageGitChangeUnsupportedFilter,
  type UsageMetricsData,
  type UsageProviderHopUnsupportedFilter,
  type UsageSessionEvidence,
  type UsageSessionQuerySelection,
  type UsageSessionSpanSummary,
  type UsageSnapshot,
  type UsageTimeBucketCount,
  type UsageTraceAttempt,
  type UsageTraceDetail,
  type UsageTraceList,
  type UsageTraceSpan,
  type UsageTraceStatus,
  type UsageVariableId,
  type UsageWidgetId,
  type UsageWorkspaceRequestBreakdown,
  type UsageWorkspaceRequestCount
} from "@simulatorlife/autodev-core";

const TRAILING_SLASHES = /\/+$/u;
const USAGE_API_PATH = "/api/autodev/usage";
const TRACE_DETAIL_API_PATH = "/api/autodev/usage/span";
const SESSION_USAGE_API_PATH = "/api/autodev/usage/session";
const SESSION_USAGE_SCHEMA = "autodev-openlit-session-usage-v1";
const MAX_SESSION_SPANS = 200;
const MAX_SESSION_LABEL_LENGTH = 128;
const NOT_APPLICABLE_KIND = "not-applicable" as const;

/**
 * The ceiling the deployed OpenLIT puts on one ClickHouse query.
 *
 * The Usage API answers with the whole dashboard for the requested window,
 * and it runs its widget, filter, trace and git queries in parallel, so its
 * own answer is bounded by its slowest single query -- and that query gives
 * up at this ceiling. The OpenLIT ClickHouse client states this ceiling
 * explicitly: its own library default was 30 seconds, which was short
 * enough for the widest range to fail under load.
 */
export const OPENLIT_QUERY_TIMEOUT_MS = 120_000;

/**
 * The ceiling on a Usage API request.
 *
 * It has to sit above the ceiling of the service, not level with it. A
 * client that gave up at the same instant as the service would race the
 * service's own answer: the request would be reported as unreachable for a
 * range the service was about to answer, and whether the console showed the
 * range or an error would depend on which side gave up first. Half again the
 * service's ceiling leaves room for the API's own fan-out and for the
 * answer to travel back.
 */
export const REQUEST_TIMEOUT_MS =
  OPENLIT_QUERY_TIMEOUT_MS + OPENLIT_QUERY_TIMEOUT_MS / 2;
const MAX_TRACE_SPANS = 200;
const MAX_USAGE_TRACE_ATTEMPTS = 25;
const TRACE_STATUS_CODES = new Set<UsageTraceStatus>([
  "OK",
  "ERROR",
  "UNSET",
  "UNKNOWN"
]);
const USAGE_WIDGET_IDS: readonly UsageWidgetId[] = [
  "logical-requests",
  "requests-by-agent",
  "requests-by-workspace",
  "input-tokens",
  "output-tokens",
  "cache-rate",
  "p95-latency",
  "p95-provider-queue",
  "p95-provider-site",
  "attempts-by-provider",
  "mcp-calls",
  "mcp-duration",
  "mcp-errors",
  "mcp-by-tool",
  "attempt-errors-by-provider",
  "context-compactions",
  "context-compactions-over-time",
  "context-compactions-by-workspace",
  "context-compactions-by-model",
  "context-compactions-by-agent",
  "context-compactions-by-provider",
  "git-commits",
  "git-files-changed",
  "git-files-added",
  "git-files-deleted",
  "git-lines-added",
  "git-lines-removed",
  "git-partial-commits",
  "git-commits-by-workspace",
  "git-commits-by-provider",
  "git-commits-by-agent",
  "provider-hops",
  "provider-hops-over-time",
  "provider-hops-by-route",
  "provider-hops-by-provider",
  "provider-hops-by-role",
  "provider-hops-by-workspace",
  "provider-hops-by-reason",
  "skill-events-by-event",
  "estimated-cost"
];
const USAGE_WIDGET_ID_SET = new Set<string>(USAGE_WIDGET_IDS);
const OPENLIT_INVALID_RESPONSE_KIND = "invalid-response" as const;
const OPENLIT_UNREACHABLE_KIND = "unreachable" as const;
const OPENLIT_HTTP_ERROR_KIND = "http-error" as const;

interface OpenLITRatio {
  readonly numerator: string;
  readonly denominator: string;
  readonly multiplier?: number;
}

interface OpenLITWidgetResult {
  readonly key: UsageWidgetId;
  readonly querySucceeded: boolean;
  readonly observed: boolean;
  readonly partial: boolean;
  readonly rows: readonly unknown[];
  readonly valuePath?: string;
  readonly ratio?: OpenLITRatio;
  readonly xAxis?: string;
  readonly yAxis?: string;
}

interface OpenLITUsageResponse {
  readonly schema: "autodev-openlit-usage-v5";
  readonly widgets: readonly OpenLITWidgetResult[];
  readonly filterOptions: Readonly<
    Record<
      UsageVariableId,
      { readonly supported: boolean; readonly values: readonly string[] }
    >
  >;
  readonly traceList: UsageTraceList;
}

export interface OpenLITUsageClientConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export type OpenLITUsageResult =
  | { readonly kind: "ok"; readonly data: UsageSnapshot }
  | { readonly kind: typeof OPENLIT_INVALID_RESPONSE_KIND }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: typeof OPENLIT_HTTP_ERROR_KIND; readonly status: number }
  | { readonly kind: typeof OPENLIT_UNREACHABLE_KIND };

export type OpenLITTraceResult =
  | { readonly kind: "ok"; readonly data: UsageTraceDetail }
  | { readonly kind: "invalid-span-id" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: typeof OPENLIT_HTTP_ERROR_KIND; readonly status: number }
  | { readonly kind: typeof OPENLIT_UNREACHABLE_KIND };

export type OpenLITSessionResult =
  | { readonly kind: "ok"; readonly data: UsageSessionEvidence }
  | { readonly kind: "invalid-session-id" }
  | { readonly kind: typeof OPENLIT_INVALID_RESPONSE_KIND }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: typeof OPENLIT_HTTP_ERROR_KIND; readonly status: number };

export class OpenLITUsageClient {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl: typeof fetch;

  constructor(config: OpenLITUsageClientConfig) {
    this.baseUrl = config.baseUrl.replace(TRAILING_SLASHES, "");
    this.serviceToken = config.serviceToken;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async queryTrace(spanId: string): Promise<OpenLITTraceResult> {
    if (!isOpenTelemetrySpanId(spanId)) return { kind: "invalid-span-id" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${TRACE_DETAIL_API_PATH}/${encodeURIComponent(spanId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.serviceToken}`,
            Accept: "application/json"
          },
          signal: controller.signal
        }
      );
      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized", status: response.status };
      }
      if (response.status === 404) {
        try {
          const error = await response.json();
          if (
            isRecord(error) &&
            isRecord(error.error) &&
            error.error.code === "autodev_usage_trace_not_found"
          ) {
            return { kind: "not-found" };
          }
        } catch {
          // A generic 404 (for example a not-yet-deployed trace route) is not
          // evidence that this span is absent from the telemetry source.
        }
        return { kind: OPENLIT_HTTP_ERROR_KIND, status: 404 };
      }
      if (!response.ok)
        return { kind: OPENLIT_HTTP_ERROR_KIND, status: response.status };

      const detail = parseOpenLITTraceDetail(await response.json());
      return detail
        ? { kind: "ok", data: detail }
        : { kind: OPENLIT_UNREACHABLE_KIND };
    } catch {
      return { kind: OPENLIT_UNREACHABLE_KIND };
    } finally {
      clearTimeout(timer);
    }
  }

  async querySession(
    sessionId: unknown,
    selection: UsageSessionQuerySelection
  ): Promise<OpenLITSessionResult> {
    const validatedSessionId = safeAutoDevSessionId(sessionId);
    if (!validatedSessionId) return { kind: "invalid-session-id" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${SESSION_USAGE_API_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.serviceToken}`,
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sessionId: validatedSessionId,
            range: selection.range,
            ...(selection.range === "CUSTOM"
              ? { customRange: selection.customRange }
              : {})
          }),
          cache: "no-store",
          signal: controller.signal
        }
      );
      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized", status: response.status };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return response.ok
          ? { kind: OPENLIT_INVALID_RESPONSE_KIND }
          : { kind: OPENLIT_HTTP_ERROR_KIND, status: response.status };
      }
      const parsed = parseOpenLITSessionUsage(body);
      if (parsed?.status === "unavailable") return { kind: "unavailable" };
      if (!response.ok)
        return { kind: OPENLIT_HTTP_ERROR_KIND, status: response.status };
      if (!parsed) return { kind: OPENLIT_INVALID_RESPONSE_KIND };
      return { kind: "ok", data: parsed.data };
    } catch {
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async query(selection: UsageFilterSelection): Promise<OpenLITUsageResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${USAGE_API_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.serviceToken}`,
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ selection }),
          signal: controller.signal
        }
      );
      if (response.status === 401 || response.status === 403)
        return { kind: "unauthorized", status: response.status };
      if (!response.ok)
        return { kind: OPENLIT_HTTP_ERROR_KIND, status: response.status };

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: OPENLIT_INVALID_RESPONSE_KIND };
      }
      const parsed = parseOpenLITUsageResponse(body);
      if (!parsed) return { kind: OPENLIT_INVALID_RESPONSE_KIND };
      return { kind: "ok", data: toUsageSnapshot(parsed, selection) };
    } catch {
      return { kind: OPENLIT_UNREACHABLE_KIND };
    } finally {
      clearTimeout(timer);
    }
  }
}

type ParsedSessionUsage =
  | { readonly status: "unavailable" }
  | { readonly status: "observed"; readonly data: UsageSessionEvidence };

const SESSION_SPAN_KEYS = new Set([
  "spanId",
  "traceId",
  "parentSpanId",
  "operationName",
  "timestamp",
  "durationNs",
  "statusCode",
  "provider",
  "requestedModel",
  "role",
  "workspace",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "costUsd",
  "requestKind",
  "compactionProvider",
  "hopRoute",
  "hopFrom",
  "hopTo",
  "hopReason"
]);
const SESSION_SPAN_LABEL_KEYS = [
  "operationName",
  "provider",
  "requestedModel",
  "role",
  "workspace",
  "requestKind",
  "compactionProvider",
  "hopRoute",
  "hopFrom",
  "hopTo",
  "hopReason"
] as const;
const SESSION_SPAN_INTEGER_KEYS = [
  "durationNs",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens"
] as const;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeSessionLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  const label = typeof value === "string" ? value.trim() : "";
  return typeof value === "string" &&
    label.length > 0 &&
    label.length <= MAX_SESSION_LABEL_LENGTH &&
    !hasControlCharacter(label)
    ? label
    : undefined;
}

function sessionNumber(
  value: unknown,
  integer: boolean
): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!integer || Number.isSafeInteger(value))
    ? value
    : undefined;
}

function parseOpenLITSessionUsage(value: unknown): ParsedSessionUsage | null {
  if (
    !isRecord(value) ||
    value.schema !== SESSION_USAGE_SCHEMA ||
    (value.status !== "observed" && value.status !== "unavailable") ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.spans) ||
    value.spans.length > MAX_SESSION_SPANS
  )
    return null;
  if (value.status === "unavailable") {
    return value.spans.length === 0 && !value.partial
      ? { status: "unavailable" }
      : null;
  }

  const spans: UsageSessionSpanSummary[] = [];
  const spanIds = new Set<string>();
  for (const candidate of value.spans) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => !SESSION_SPAN_KEYS.has(key)) ||
      Object.keys(candidate).length !== SESSION_SPAN_KEYS.size ||
      typeof candidate.spanId !== "string" ||
      !isOpenTelemetrySpanId(candidate.spanId) ||
      spanIds.has(candidate.spanId) ||
      typeof candidate.traceId !== "string" ||
      !isOpenTelemetryTraceId(candidate.traceId) ||
      (candidate.parentSpanId !== null &&
        (typeof candidate.parentSpanId !== "string" ||
          !isOpenTelemetrySpanId(candidate.parentSpanId))) ||
      typeof candidate.timestamp !== "string" ||
      !Number.isFinite(Date.parse(candidate.timestamp)) ||
      typeof candidate.statusCode !== "string" ||
      !TRACE_STATUS_CODES.has(candidate.statusCode as UsageTraceStatus)
    )
      return null;

    const labels = Object.fromEntries(
      SESSION_SPAN_LABEL_KEYS.map((key) => [
        key,
        safeSessionLabel(candidate[key])
      ])
    ) as Record<
      (typeof SESSION_SPAN_LABEL_KEYS)[number],
      string | null | undefined
    >;
    const counts = Object.fromEntries(
      SESSION_SPAN_INTEGER_KEYS.map((key) => [
        key,
        sessionNumber(candidate[key], true)
      ])
    ) as Record<
      (typeof SESSION_SPAN_INTEGER_KEYS)[number],
      number | null | undefined
    >;
    const costUsd = sessionNumber(candidate.costUsd, false);
    if (
      Object.values(labels).includes(undefined) ||
      typeof labels.operationName !== "string" ||
      Object.values(counts).includes(undefined) ||
      typeof counts.durationNs !== "number" ||
      costUsd === undefined
    )
      return null;

    spanIds.add(candidate.spanId);
    spans.push({
      spanId: candidate.spanId.toLowerCase(),
      traceId: candidate.traceId.toLowerCase(),
      parentSpanId:
        typeof candidate.parentSpanId === "string"
          ? candidate.parentSpanId.toLowerCase()
          : null,
      operationName: labels.operationName,
      timestamp: new Date(candidate.timestamp).toISOString(),
      durationNs: counts.durationNs,
      statusCode: candidate.statusCode as UsageTraceStatus,
      provider: labels.provider ?? null,
      requestedModel: labels.requestedModel ?? null,
      role: labels.role ?? null,
      workspace: labels.workspace ?? null,
      inputTokens: counts.inputTokens ?? null,
      outputTokens: counts.outputTokens ?? null,
      cacheReadInputTokens: counts.cacheReadInputTokens ?? null,
      costUsd,
      requestKind: labels.requestKind ?? null,
      compactionProvider: labels.compactionProvider ?? null,
      hopRoute: labels.hopRoute ?? null,
      hopFrom: labels.hopFrom ?? null,
      hopTo: labels.hopTo ?? null,
      hopReason: labels.hopReason ?? null
    });
  }
  return { status: "observed", data: { partial: value.partial, spans } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOpenLITTraceDetail(value: unknown): UsageTraceDetail | null {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-openlit-trace-detail-v1" ||
    typeof value.traceId !== "string" ||
    !isOpenTelemetryTraceId(value.traceId) ||
    typeof value.selectedSpanId !== "string" ||
    !isOpenTelemetrySpanId(value.selectedSpanId) ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.spans) ||
    value.spans.length === 0 ||
    value.spans.length > MAX_TRACE_SPANS
  ) {
    return null;
  }

  const spans: UsageTraceSpan[] = [];
  const spanIds = new Set<string>();
  for (const candidate of value.spans) {
    if (
      !isRecord(candidate) ||
      typeof candidate.spanId !== "string" ||
      !isOpenTelemetrySpanId(candidate.spanId) ||
      spanIds.has(candidate.spanId) ||
      (candidate.parentSpanId !== null &&
        (typeof candidate.parentSpanId !== "string" ||
          !isOpenTelemetrySpanId(candidate.parentSpanId))) ||
      typeof candidate.spanName !== "string" ||
      candidate.spanName.length > 256 ||
      typeof candidate.serviceName !== "string" ||
      candidate.serviceName.length > 256 ||
      typeof candidate.timestamp !== "string" ||
      !Number.isFinite(Date.parse(candidate.timestamp)) ||
      typeof candidate.durationNs !== "number" ||
      !Number.isSafeInteger(candidate.durationNs) ||
      candidate.durationNs < 0 ||
      typeof candidate.statusCode !== "string" ||
      !TRACE_STATUS_CODES.has(candidate.statusCode as UsageTraceStatus)
    ) {
      return null;
    }

    spanIds.add(candidate.spanId);
    spans.push({
      spanId: candidate.spanId,
      parentSpanId: candidate.parentSpanId as string | null,
      spanName: candidate.spanName,
      serviceName: candidate.serviceName,
      timestamp: candidate.timestamp,
      durationNs: candidate.durationNs,
      statusCode: candidate.statusCode as UsageTraceStatus
    });
  }

  if (!spanIds.has(value.selectedSpanId)) return null;
  return {
    schema: "autodev-openlit-trace-detail-v1",
    traceId: value.traceId,
    selectedSpanId: value.selectedSpanId,
    spans,
    partial: value.partial
  };
}

function parseOpenLITUsageResponse(
  value: unknown
): OpenLITUsageResponse | null {
  if (!isRecord(value) || value.schema !== "autodev-openlit-usage-v5") {
    return null;
  }
  if (!Array.isArray(value.widgets)) return null;

  const widgets: OpenLITWidgetResult[] = [];
  const seenWidgetIds = new Set<UsageWidgetId>();
  for (const candidate of value.widgets) {
    const widget = parseWidgetResult(candidate);
    if (!widget || seenWidgetIds.has(widget.key)) return null;
    seenWidgetIds.add(widget.key);
    widgets.push(widget);
  }

  if (
    widgets.length !== USAGE_WIDGET_IDS.length ||
    USAGE_WIDGET_IDS.some((id) => !seenWidgetIds.has(id))
  ) {
    return null;
  }

  const filterOptions = parseFilterOptions(value.filterOptions);
  if (!filterOptions) return null;
  const traceList = parseOpenLITTraceList(value.traceList);
  if (!traceList) return null;
  return {
    schema: "autodev-openlit-usage-v5",
    widgets,
    filterOptions,
    traceList
  };
}

function parseOpenLITTraceList(value: unknown): UsageTraceList | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "unavailable") return { kind: "unavailable" };
  if (
    value.kind === NOT_APPLICABLE_KIND &&
    (value.reason === "skill-filter" || value.reason === "unsupported-filter")
  ) {
    return { kind: NOT_APPLICABLE_KIND, reason: value.reason };
  }
  if (
    value.kind !== "observed" ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > MAX_USAGE_TRACE_ATTEMPTS
  ) {
    return null;
  }

  const attempts: UsageTraceAttempt[] = [];
  const spanIds = new Set<string>();
  for (const candidate of value.attempts) {
    if (
      !isRecord(candidate) ||
      typeof candidate.spanId !== "string" ||
      !isOpenTelemetrySpanId(candidate.spanId) ||
      spanIds.has(candidate.spanId) ||
      typeof candidate.timestamp !== "string" ||
      !Number.isFinite(Date.parse(candidate.timestamp)) ||
      typeof candidate.durationNs !== "number" ||
      !Number.isSafeInteger(candidate.durationNs) ||
      candidate.durationNs < 0 ||
      typeof candidate.statusCode !== "string" ||
      !TRACE_STATUS_CODES.has(candidate.statusCode as UsageTraceStatus) ||
      !isNullableLabel(candidate.provider) ||
      !isNullableLabel(candidate.model) ||
      !isNullableLabel(candidate.role)
    ) {
      return null;
    }
    spanIds.add(candidate.spanId);
    attempts.push({
      spanId: candidate.spanId,
      timestamp: candidate.timestamp,
      durationNs: candidate.durationNs,
      statusCode: candidate.statusCode as UsageTraceStatus,
      provider: candidate.provider as string | null,
      model: candidate.model as string | null,
      role: candidate.role as string | null
    });
  }
  return { kind: "observed", attempts, partial: value.partial };
}

function isNullableLabel(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      value.trim() === value)
  );
}

function parseWidgetResult(candidate: unknown): OpenLITWidgetResult | null {
  if (
    !isRecord(candidate) ||
    typeof candidate.key !== "string" ||
    !USAGE_WIDGET_ID_SET.has(candidate.key) ||
    typeof candidate.querySucceeded !== "boolean" ||
    typeof candidate.observed !== "boolean" ||
    typeof candidate.partial !== "boolean" ||
    !Array.isArray(candidate.rows)
  ) {
    return null;
  }

  const ratio =
    candidate.ratio === undefined ? undefined : parseRatio(candidate.ratio);
  if (candidate.ratio !== undefined && ratio === null) return null;
  return {
    key: candidate.key as UsageWidgetId,
    querySucceeded: candidate.querySucceeded,
    observed: candidate.observed,
    partial: candidate.partial,
    rows: candidate.rows,
    ...(typeof candidate.valuePath === "string"
      ? { valuePath: candidate.valuePath }
      : {}),
    ...(ratio ? { ratio } : {}),
    ...(typeof candidate.xAxis === "string" ? { xAxis: candidate.xAxis } : {}),
    ...(typeof candidate.yAxis === "string" ? { yAxis: candidate.yAxis } : {})
  };
}

function parseRatio(value: unknown): OpenLITRatio | null {
  if (
    !isRecord(value) ||
    typeof value.numerator !== "string" ||
    typeof value.denominator !== "string"
  ) {
    return null;
  }
  if (
    value.multiplier !== undefined &&
    (typeof value.multiplier !== "number" || !Number.isFinite(value.multiplier))
  ) {
    return null;
  }
  return {
    numerator: value.numerator,
    denominator: value.denominator,
    ...(typeof value.multiplier === "number"
      ? { multiplier: value.multiplier }
      : {})
  };
}

function parseFilterOptions(
  value: unknown
): OpenLITUsageResponse["filterOptions"] | null {
  if (!isRecord(value)) return null;
  const filterOptions = {} as Record<
    UsageVariableId,
    { readonly supported: boolean; readonly values: readonly string[] }
  >;
  for (const id of USAGE_VARIABLE_IDS) {
    const option = value[id];
    if (
      !isRecord(option) ||
      typeof option.supported !== "boolean" ||
      !Array.isArray(option.values) ||
      !option.values.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    filterOptions[id] = {
      supported: option.supported,
      values: option.values as string[]
    };
  }
  return filterOptions;
}

function readValuePath(rows: readonly unknown[], path: string): unknown {
  const separator = path.indexOf(".");
  if (separator <= 0) return null;
  const rowIndex = Number(path.slice(0, separator));
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return null;
  const row = rows[rowIndex];
  if (!isRecord(row)) return null;
  return row[path.slice(separator + 1)];
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function observedMetric(
  widget: OpenLITWidgetResult | undefined
): number | null {
  if (!widget?.observed || !widget.valuePath) return null;
  return numberValue(readValuePath(widget.rows, widget.valuePath));
}

function observedCount(widget: OpenLITWidgetResult | undefined): number | null {
  const count = observedMetric(widget);
  return count !== null && Number.isSafeInteger(count) && count >= 0
    ? count
    : null;
}

function ratioMetric(widget: OpenLITWidgetResult | undefined): number | null {
  if (!widget?.observed || !widget.ratio) return null;
  const numerator = numberValue(
    readValuePath(widget.rows, widget.ratio.numerator)
  );
  const denominator = numberValue(
    readValuePath(widget.rows, widget.ratio.denominator)
  );
  if (numerator === null || denominator === null || denominator === 0)
    return null;
  return (numerator / denominator) * (widget.ratio.multiplier ?? 1);
}

function groupedRows(
  widget: OpenLITWidgetResult | undefined
): readonly { readonly name: string; readonly count: number }[] | null {
  if (!widget?.observed || !widget.xAxis || !widget.yAxis) return null;
  const rows: { readonly name: string; readonly count: number }[] = [];
  for (const candidate of widget.rows) {
    if (!isRecord(candidate)) return null;
    const name = candidate[widget.xAxis];
    const count = numberValue(candidate[widget.yAxis]);
    if (typeof name !== "string" || count === null || count < 0) return null;
    rows.push({ name, count });
  }
  return rows;
}

function contextCompactionRows(
  widget: OpenLITWidgetResult | undefined,
  total: number | null
): readonly { readonly name: string; readonly count: number }[] | null {
  if (!widget?.querySucceeded) return null;
  if (widget.rows.length === 0) return total === 0 ? [] : null;
  const rows = groupedRows(widget);
  return rows?.every((row) => Number.isSafeInteger(row.count) && row.count >= 0)
    ? rows
    : null;
}

function contextCompactionUnsupportedFilters(
  selection: UsageFilterSelection
): readonly UsageCompactionUnsupportedFilter[] {
  const unsupported: UsageCompactionUnsupportedFilter[] = [];
  if ((selection.values.provider?.length ?? 0) > 0) {
    unsupported.push("provider");
  }
  if ((selection.values.skill?.length ?? 0) > 0) {
    unsupported.push("skill");
  }
  return unsupported;
}

/**
 * The filters a provider hop cannot answer.
 *
 * A hop records the provider that now serves the agent, the provider it came
 * from, the agent's role and its workspace. It does not record the requested
 * model or a skill, so a selection on either of them cannot describe hops.
 */
function providerHopUnsupportedFilters(
  selection: UsageFilterSelection
): readonly UsageProviderHopUnsupportedFilter[] {
  const unsupported: UsageProviderHopUnsupportedFilter[] = [];
  if ((selection.values.provider?.length ?? 0) > 0)
    unsupported.push("provider");
  if ((selection.values.model?.length ?? 0) > 0) unsupported.push("model");
  if ((selection.values.skill?.length ?? 0) > 0) unsupported.push("skill");
  return unsupported;
}

function gitChangeUnsupportedFilters(
  selection: UsageFilterSelection
): readonly UsageGitChangeUnsupportedFilter[] {
  const unsupported: UsageGitChangeUnsupportedFilter[] = [];
  if ((selection.values.model?.length ?? 0) > 0) unsupported.push("model");
  if ((selection.values.skill?.length ?? 0) > 0) unsupported.push("skill");
  return unsupported;
}

function unavailableGitChanges(
  status: UsageGitChangeMetrics["status"],
  unsupportedFilters: readonly UsageGitChangeUnsupportedFilter[],
  notApplicableReason: UsageGitChangeMetrics["notApplicableReason"] = null
): UsageGitChangeMetrics {
  return {
    status,
    notApplicableReason,
    unsupportedFilters,
    partial: null,
    breakdownsPartial: false,
    commits: null,
    filesChanged: null,
    filesAdded: null,
    filesDeleted: null,
    linesAdded: null,
    linesRemoved: null,
    partialCommits: null,
    commitsByWorkspace: null,
    commitsByProvider: null,
    commitsByAgent: null
  };
}

/**
 * A counted Git metric.
 *
 * The Git widgets answer from a metric query, and their `observed` flag
 * means "the query matched a data point" rather than "the source answered
 * the question". The two are the same for a widget whose query always
 * returns a row, and they are not the same for a metric query: a query that
 * succeeded and matched nothing is a count of zero, not an absence of
 * evidence. Reading it as absent sends the reader after a capture the
 * source made and reported as empty -- and it is why a scoped view whose
 * filter matched no commit rendered every Git panel as unobserved.
 *
 * A query that did not succeed is the unobserved case, and it is the only
 * one.
 */
function gitCount(widget: OpenLITWidgetResult | undefined): number | null {
  if (!widget?.querySucceeded) return null;
  if (!widget.observed || widget.rows.length === 0) return 0;
  return observedMetric(widget);
}

/**
 * Read the partial-commit count without turning a malformed observed value
 * into zero. Only a successful empty query is evidence that no partial diff
 * was measured in the selected range.
 */
function observedPartialCommitCount(
  widget: OpenLITWidgetResult | undefined
): number | null {
  if (!widget?.querySucceeded) return null;
  if (!widget.observed && widget.rows.length === 0 && !widget.partial) return 0;
  return observedCount(widget);
}

/**
 * One bounded breakdown of counts by category.
 *
 * An empty breakdown is only read as "no rows at all" when the total it
 * breaks down agrees with it; otherwise the source returned rows it cannot
 * explain and the breakdown is not observed. A breakdown the source did not
 * observe is not an empty one either: it is missing.
 */
function breakdownRows(
  widget: OpenLITWidgetResult | undefined,
  total: number | null
): readonly UsageBreakdownCount[] | null {
  if (!widget?.querySucceeded) return null;
  if (!widget.observed || widget.rows.length === 0) {
    return total === 0 ? [] : null;
  }
  const rows = groupedRows(widget);
  return rows?.every((row) => Number.isSafeInteger(row.count) && row.count >= 0)
    ? rows
    : null;
}

/**
 * The logical-request breakdown by workspace.
 *
 * This is the one breakdown whose group key can be absent, so it cannot reuse
 * `groupedRows`: a group key the source renders as an empty or null value is
 * a request that carried no workspace attribution, not a malformed row, and
 * rejecting the whole breakdown because of it would throw away every
 * attributed workspace with it. Such requests belong to no workspace, so they
 * are reported with a `null` workspace rather than folded into one.
 *
 * An empty breakdown is only read as "no requests at all" when the logical
 * request total agrees; otherwise the source returned rows it cannot explain
 * and the breakdown is not observed.
 */
function workspaceRequestBreakdown(
  widget: OpenLITWidgetResult | undefined,
  observedRequests: number | null
): UsageWorkspaceRequestBreakdown | null {
  if (!widget?.querySucceeded || !widget.observed) return null;
  if (!widget.xAxis || !widget.yAxis) return null;
  if (widget.rows.length === 0) {
    return observedRequests === 0
      ? { rows: [], partial: widget.partial }
      : null;
  }

  const counts = new Map<string | null, number>();
  for (const candidate of widget.rows) {
    if (!isRecord(candidate)) return null;
    const rawName = candidate[widget.xAxis];
    if (
      rawName !== null &&
      rawName !== undefined &&
      typeof rawName !== "string"
    ) {
      return null;
    }
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const count = numberValue(candidate[widget.yAxis]);
    if (count === null || !Number.isSafeInteger(count) || count < 0)
      return null;
    const workspace = name === "" ? null : name;
    counts.set(workspace, (counts.get(workspace) ?? 0) + count);
  }

  const rows: UsageWorkspaceRequestCount[] = Array.from(
    counts,
    ([workspace, count]) => ({ workspace, count })
  );
  return { rows, partial: widget.partial };
}

function gitChangeMetrics(
  widgets: ReadonlyMap<UsageWidgetId, OpenLITWidgetResult>,
  selection: UsageFilterSelection
): UsageGitChangeMetrics {
  const unsupportedFilters = gitChangeUnsupportedFilters(selection);
  if (selection.range === "ACTIVE_SESSIONS") {
    return unavailableGitChanges(
      NOT_APPLICABLE_KIND,
      unsupportedFilters,
      "active-sessions"
    );
  }
  if (unsupportedFilters.length > 0) {
    return unavailableGitChanges(
      NOT_APPLICABLE_KIND,
      unsupportedFilters,
      "unsupported-filter"
    );
  }

  const commitsWidget = widgets.get("git-commits");
  const commits = gitCount(commitsWidget);
  const status: UsageGitChangeMetrics["status"] =
    commitsWidget?.querySucceeded === true
      ? commits === null
        ? "not-observed"
        : "observed"
      : "unavailable";
  if (status !== "observed") {
    return unavailableGitChanges(status, unsupportedFilters);
  }
  const partialWidget = widgets.get("git-partial-commits");
  const partialCommits = observedPartialCommitCount(partialWidget);
  const lineTotalsComplete = partialCommits === 0;
  const breakdownIds: readonly UsageWidgetId[] = [
    "git-commits-by-workspace",
    "git-commits-by-provider",
    "git-commits-by-agent"
  ];
  const breakdownsPartial = breakdownIds.some(
    (id) => widgets.get(id)?.partial === true
  );

  return {
    status,
    notApplicableReason: null,
    unsupportedFilters,
    partial: partialCommits === null ? null : partialCommits > 0,
    breakdownsPartial,
    commits,
    filesChanged: gitCount(widgets.get("git-files-changed")),
    filesAdded: gitCount(widgets.get("git-files-added")),
    filesDeleted: gitCount(widgets.get("git-files-deleted")),
    // numstat cannot report line counts for binary or otherwise unsummarized
    // diffs. A sum of the rows it could read is not the complete range total,
    // and an all-binary range must not become a measured zero.
    linesAdded: lineTotalsComplete
      ? gitCount(widgets.get("git-lines-added"))
      : null,
    linesRemoved: lineTotalsComplete
      ? gitCount(widgets.get("git-lines-removed"))
      : null,
    partialCommits,
    commitsByWorkspace: breakdownRows(
      widgets.get("git-commits-by-workspace"),
      commits
    ),
    commitsByProvider: breakdownRows(
      widgets.get("git-commits-by-provider"),
      commits
    ),
    commitsByAgent: breakdownRows(widgets.get("git-commits-by-agent"), commits)
  };
}

/** The provider-hop evidence one Usage snapshot carries. */
interface ProviderHopMetrics {
  readonly providerHops: number | null;
  readonly providerHopRatePercent: number | null;
  readonly providerHopsOverTime: readonly UsageTimeBucketCount[] | null;
  readonly providerHopsByRoute: readonly UsageBreakdownCount[] | null;
  readonly providerHopsByProvider: readonly UsageBreakdownCount[] | null;
  readonly providerHopsByRole: readonly UsageBreakdownCount[] | null;
  readonly providerHopsByWorkspace: readonly UsageBreakdownCount[] | null;
  readonly providerHopsByReason: readonly UsageBreakdownCount[] | null;
  readonly providerHopsUnsupportedFilters: readonly UsageProviderHopUnsupportedFilter[];
  readonly providerHopsBreakdownsPartial: boolean;
}

const PROVIDER_HOP_BREAKDOWN_IDS: readonly UsageWidgetId[] = [
  "provider-hops-by-route",
  "provider-hops-by-provider",
  "provider-hops-by-role",
  "provider-hops-by-workspace",
  "provider-hops-by-reason"
];

/**
 * Read the provider-hop evidence.
 *
 * A hop is recorded on the logical request that observed it, so the hop count
 * and its breakdowns answer the same question about the same requests. A
 * selection on a dimension the hop does not carry leaves the whole evidence
 * unavailable rather than answering it for every provider, model or skill.
 */
function providerHopMetrics(
  widgets: ReadonlyMap<UsageWidgetId, OpenLITWidgetResult>,
  selection: UsageFilterSelection,
  logicalRequests: number | null
): ProviderHopMetrics {
  const unsupportedFilters = providerHopUnsupportedFilters(selection);
  if (unsupportedFilters.length > 0) {
    return {
      providerHops: null,
      providerHopRatePercent: null,
      providerHopsOverTime: null,
      providerHopsByRoute: null,
      providerHopsByProvider: null,
      providerHopsByRole: null,
      providerHopsByWorkspace: null,
      providerHopsByReason: null,
      providerHopsUnsupportedFilters: unsupportedFilters,
      providerHopsBreakdownsPartial: false
    };
  }
  const providerHops = observedCount(widgets.get("provider-hops"));
  const timeSeries = breakdownRows(
    widgets.get("provider-hops-over-time"),
    providerHops
  );
  return {
    providerHops,
    providerHopRatePercent: deriveProviderHopRatePercent(
      providerHops,
      logicalRequests
    ),
    providerHopsOverTime:
      timeSeries?.map(({ name, count }) => ({ bucket: name, count })) ?? null,
    providerHopsByRoute: breakdownRows(
      widgets.get("provider-hops-by-route"),
      providerHops
    ),
    providerHopsByProvider: breakdownRows(
      widgets.get("provider-hops-by-provider"),
      providerHops
    ),
    providerHopsByRole: breakdownRows(
      widgets.get("provider-hops-by-role"),
      providerHops
    ),
    providerHopsByWorkspace: breakdownRows(
      widgets.get("provider-hops-by-workspace"),
      providerHops
    ),
    providerHopsByReason: breakdownRows(
      widgets.get("provider-hops-by-reason"),
      providerHops
    ),
    providerHopsUnsupportedFilters: unsupportedFilters,
    providerHopsBreakdownsPartial: PROVIDER_HOP_BREAKDOWN_IDS.some(
      (id) => widgets.get(id)?.partial === true
    )
  };
}

function toUsageSnapshot(
  response: OpenLITUsageResponse,
  selection: UsageFilterSelection
): UsageSnapshot {
  const widgets = new Map(
    response.widgets.map((widget) => [widget.key, widget])
  );
  const attempts = groupedRows(widgets.get("attempts-by-provider"));
  const attemptErrors = groupedRows(widgets.get("attempt-errors-by-provider"));
  const requests = groupedRows(widgets.get("requests-by-agent"));
  const calls = groupedRows(widgets.get("mcp-by-tool"));
  const skillEvents = groupedRows(widgets.get("skill-events-by-event"));
  const unsupportedCompactionFilters =
    contextCompactionUnsupportedFilters(selection);
  const logicalRequests = observedCount(widgets.get("logical-requests"));
  const compactions = observedCount(widgets.get("context-compactions"));
  const compactionTimeSeries = contextCompactionRows(
    widgets.get("context-compactions-over-time"),
    compactions
  );
  const compactionsByWorkspace = contextCompactionRows(
    widgets.get("context-compactions-by-workspace"),
    compactions
  );
  const compactionsByModel = contextCompactionRows(
    widgets.get("context-compactions-by-model"),
    compactions
  );
  const compactionsByAgent = contextCompactionRows(
    widgets.get("context-compactions-by-agent"),
    compactions
  );
  const compactionsByProvider = contextCompactionRows(
    widgets.get("context-compactions-by-provider"),
    compactions
  );
  const compactionsAvailable = unsupportedCompactionFilters.length === 0;
  const hops = providerHopMetrics(widgets, selection, logicalRequests);
  const breakdownsPartial = [
    "context-compactions-by-workspace",
    "context-compactions-by-model",
    "context-compactions-by-agent",
    "context-compactions-by-provider"
  ].some((id) => {
    const widget = widgets.get(id as UsageWidgetId);
    return widget?.querySucceeded === true && widget.partial;
  });
  const metrics: UsageMetricsData = {
    logicalRequests,
    totalInputTokens: observedMetric(widgets.get("input-tokens")),
    totalOutputTokens: observedMetric(widgets.get("output-tokens")),
    cacheReadRate: ratioMetric(widgets.get("cache-rate")),
    p95LatencyMs: milliseconds(observedMetric(widgets.get("p95-latency"))),
    p95ProviderQueueMs: milliseconds(
      observedMetric(widgets.get("p95-provider-queue"))
    ),
    p95ProviderSiteMs: milliseconds(
      observedMetric(widgets.get("p95-provider-site"))
    ),
    estimatedCostUsd: observedMetric(widgets.get("estimated-cost")),
    physicalAttempts:
      attempts === null
        ? null
        : attempts.reduce((total, row) => total + row.count, 0),
    mcpCalls: observedMetric(widgets.get("mcp-calls")),
    p95McpDurationMs: milliseconds(observedMetric(widgets.get("mcp-duration"))),
    mcpErrors: observedMetric(widgets.get("mcp-errors")),
    failedAttempts:
      attemptErrors === null
        ? null
        : attemptErrors.reduce((total, row) => total + row.count, 0),
    attemptErrorsByProvider:
      attemptErrors === null
        ? null
        : attemptErrors.map(({ name, count }) => ({ provider: name, count })),
    contextCompactions: compactionsAvailable ? compactions : null,
    contextCompactionRatePercent: compactionsAvailable
      ? deriveContextCompactionRatePercent(compactions, logicalRequests)
      : null,
    contextCompactionsOverTime: compactionsAvailable
      ? (compactionTimeSeries?.map(({ name, count }) => ({
          bucket: name,
          count
        })) ?? null)
      : null,
    contextCompactionsByWorkspace: compactionsAvailable
      ? compactionsByWorkspace
      : null,
    contextCompactionsByModel: compactionsAvailable ? compactionsByModel : null,
    contextCompactionsByAgent: compactionsAvailable ? compactionsByAgent : null,
    contextCompactionsByProvider: compactionsAvailable
      ? compactionsByProvider
      : null,
    contextCompactionsUnsupportedFilters: unsupportedCompactionFilters,
    contextCompactionsBreakdownsPartial:
      compactionsAvailable && breakdownsPartial,
    providerHops: hops.providerHops,
    providerHopRatePercent: hops.providerHopRatePercent,
    providerHopsOverTime: hops.providerHopsOverTime,
    providerHopsByRoute: hops.providerHopsByRoute,
    providerHopsByProvider: hops.providerHopsByProvider,
    providerHopsByRole: hops.providerHopsByRole,
    providerHopsByWorkspace: hops.providerHopsByWorkspace,
    providerHopsByReason: hops.providerHopsByReason,
    providerHopsUnsupportedFilters: hops.providerHopsUnsupportedFilters,
    providerHopsBreakdownsPartial: hops.providerHopsBreakdownsPartial,
    gitChanges: gitChangeMetrics(widgets, selection),
    skillEventsByEvent:
      skillEvents === null
        ? null
        : skillEvents.map(({ name, count }) => ({ event: name, count })),
    requestsByRole:
      requests === null
        ? null
        : requests.map(({ name, count }) => ({ role: name, count })),
    requestsByWorkspace: workspaceRequestBreakdown(
      widgets.get("requests-by-workspace"),
      logicalRequests
    ),
    attemptsByProvider:
      attempts === null
        ? null
        : attempts.map(({ name, count }) => ({ provider: name, count })),
    callsByTool:
      calls === null
        ? null
        : calls.map(({ name, count }) => ({ tool: name, count }))
  };
  const filterOptions: UsageFilterOptions = {
    workspace: observedFilterOptions(response, "workspace"),
    provider: observedFilterOptions(response, "provider"),
    model: observedFilterOptions(response, "model"),
    agent: observedFilterOptions(response, "agent"),
    skill: observedFilterOptions(response, "skill")
  };
  return { metrics, filterOptions, traceList: response.traceList };
}

function observedFilterOptions(
  response: OpenLITUsageResponse,
  id: UsageVariableId
): readonly string[] | null {
  const option = response.filterOptions[id];
  return option.supported ? option.values : null;
}

function milliseconds(value: number | null): number | null {
  if (value === null) return null;
  const durationMs = value * 1000;
  return Number.isFinite(durationMs) ? durationMs : null;
}
