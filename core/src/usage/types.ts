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

/**
 * The Usage scope selector's value.
 *
 * `ACTIVE_SESSIONS` is deliberately a member of this union even though it is not
 * a time range: the selector presents historical ranges and the live-session
 * scope in one control, and modelling the live scope outside the union would
 * force every consumer to carry a second "or is this live?" flag beside a
 * `range` it cannot honour. What the member means is not "another range" — see
 * `UsageActiveSessions` below for the evidence it actually carries, and note
 * that it must never be turned into a derived window.
 */
export type UsageTimeRange =
  "24H" | "7D" | "1M" | "3M" | "CUSTOM" | "ACTIVE_SESSIONS";

/** Ranges that map to a bounded historical Usage telemetry query. */
export type UsageHistoricalTimeRange = Exclude<
  UsageTimeRange,
  "ACTIVE_SESSIONS"
>;

/**
 * Live runtime state for the `ACTIVE_SESSIONS` scope.
 *
 * Every counter is `number | null` where `null` means the Runtime did not
 * report it — not zero. Collapsing that distinction here would make an
 * unreachable counter indistinguishable from an idle Runtime, which is the one
 * reading the Console must never synthesize.
 */
export interface UsageActiveSessions {
  readonly schema: "autodev-usage-active-sessions-v1";
  readonly lifecycle: "ready" | "draining" | null;
  readonly lifecycleChangedAt: string | null;
  /** Runtime-reported live session count; `null` when not observed. */
  readonly activeSessions: number | null;
  /** Runtime-reported live subagent thread count; `null` when not observed. */
  readonly activeSubagentThreads: number | null;
  /** Runtime-reported in-flight provider requests; `null` when not observed. */
  readonly inFlightRequests: number | null;
  /**
   * Whether the Runtime currently reports per-session identity for this scope.
   *
   * False today: `/control/runtime` publishes a scalar `activeSessions` count
   * and no per-session identity at all. The Console uses this to say why no
   * session list is rendered rather than rendering an empty one.
   */
  readonly perSessionIdentityAvailable: boolean;
}

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
      /**
       * The live-session scope carries no custom bounds: there is no interval
       * for them to bound, so they are absent rather than defaulted to a
       * window that would silently mean nothing.
       */
      readonly range:
        Exclude<UsageHistoricalTimeRange, "CUSTOM"> | "ACTIVE_SESSIONS";
      readonly values: UsageFilterValues;
      readonly customRange?: UsageCustomRange;
    };

export type UsageFilterOptions = Readonly<
  Record<UsageVariableId, readonly string[] | null>
>;

/**
 * Whether a selection queries the historical Usage telemetry store.
 *
 * The Usage page needs this as a *function of the selection* rather than as a
 * second field carried beside it: `ACTIVE_SESSIONS` has no interval, so passing
 * it to the OpenLIT client would ask for a window that does not exist, and the
 * endpoint would either error or apply a default window and render the result
 * as though it were the live scope. Callers route on this before they query.
 */
export function isHistoricalUsageSelection(
  selection: Pick<UsageFilterSelection, "range">
): selection is Extract<
  UsageFilterSelection,
  { readonly range: UsageHistoricalTimeRange }
> {
  return selection.range !== "ACTIVE_SESSIONS";
}

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
