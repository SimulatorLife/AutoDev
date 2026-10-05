export type UsageVariableId =
  "workspace" | "provider" | "model" | "agent" | "skill";

export interface UsageVariable {
  readonly id: UsageVariableId;
  readonly label: string;
  readonly signal: "traces" | "metrics";
  readonly scope: "resource" | "span";
  readonly key: string;
  readonly multi: boolean;
  readonly supportsAll: boolean;
  readonly defaultValues?: readonly string[];
}

export type UsageWidgetId =
  | "logical-requests"
  | "requests-by-agent"
  | "input-tokens"
  | "output-tokens"
  | "cache-rate"
  | "p95-latency"
  | "attempts-by-provider"
  | "mcp-calls"
  | "mcp-duration"
  | "mcp-errors"
  | "mcp-by-tool";

export interface UsageWidgetConfig {
  readonly id: UsageWidgetId;
  readonly title: string;
  readonly description?: string;
  readonly optInVariables: readonly UsageVariableId[];
  readonly variableScopeOverrides?: Partial<
    Record<UsageVariableId, "resource" | "span">
  >;
}

export type UsageTimeRange = "24H" | "7D" | "1M" | "3M" | "CUSTOM";

export interface UsageCustomRange {
  /** ISO calendar dates (YYYY-MM-DD), interpreted as full UTC days. */
  readonly startDate: string;
  readonly endDate: string;
}

export type UsageFilterValues = Partial<
  Record<UsageVariableId, readonly string[]>
>;

export type UsageFilterSelection =
  | {
      readonly range: "CUSTOM";
      readonly values: UsageFilterValues;
      readonly customRange: UsageCustomRange;
    }
  | {
      readonly range: Exclude<UsageTimeRange, "CUSTOM">;
      readonly values: UsageFilterValues;
      readonly customRange?: UsageCustomRange;
    };

export type UsageFilterOptions = Readonly<
  Record<UsageVariableId, readonly string[] | null>
>;

/** Logical-request, physical-attempt, and MCP observations from the Usage board. */
export interface UsageMetricsData {
  readonly logicalRequests: number | null;
  readonly totalInputTokens: number | null;
  readonly totalOutputTokens: number | null;
  readonly cacheReadRate: number | null;
  readonly p95LatencyMs: number | null;
  readonly physicalAttempts: number | null;
  readonly mcpCalls: number | null;
  readonly p95McpDurationMs: number | null;
  readonly mcpErrors: number | null;
  readonly requestsByRole:
    readonly { readonly role: string; readonly count: number }[] | null;
  readonly attemptsByProvider:
    readonly { readonly provider: string; readonly count: number }[] | null;
  readonly callsByTool:
    readonly { readonly tool: string; readonly count: number }[] | null;
}

export interface UsageSnapshot {
  readonly metrics: UsageMetricsData;
  readonly filterOptions: UsageFilterOptions;
}
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/iu;
const ZERO_ID_PATTERN = /^0+$/u;

/** Validate a W3C/OpenTelemetry trace id before it becomes a trace lookup. */
export function isOpenTelemetryTraceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TRACE_ID_PATTERN.test(value) &&
    !ZERO_ID_PATTERN.test(value)
  );
}

/** Validate a W3C/OpenTelemetry span id before it becomes a trace lookup. */
export function isOpenTelemetrySpanId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SPAN_ID_PATTERN.test(value) &&
    !ZERO_ID_PATTERN.test(value)
  );
}

export type UsageTraceStatus = "OK" | "ERROR" | "UNSET" | "UNKNOWN";

/** Privacy-filtered span metadata returned by the fixed Usage trace reader. */
export interface UsageTraceSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly spanName: string;
  readonly serviceName: string;
  readonly timestamp: string;
  readonly durationNs: number;
  readonly statusCode: UsageTraceStatus;
}

/** Bounded in-Console trace context for one explicitly selected span. */
export interface UsageTraceDetail {
  readonly schema: "autodev-openlit-trace-detail-v1";
  readonly traceId: string;
  readonly selectedSpanId: string;
  readonly spans: readonly UsageTraceSpan[];
  readonly partial: boolean;
}
