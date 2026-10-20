/** Canonical, bounded filter axes shared by Console and Data adapters. */
export const USAGE_VARIABLE_IDS = [
  "workspace",
  "provider",
  "model",
  "agent",
  "skill"
] as const;

export type UsageVariableId = (typeof USAGE_VARIABLE_IDS)[number];

export interface UsageVariable {
  readonly id: UsageVariableId;
  readonly label: string;
  readonly signal: "traces" | "metrics";
  readonly scope: "resource" | "span" | "metric";
  readonly key: string;
  readonly multi: boolean;
  readonly supportsAll: boolean;
  readonly defaultValues?: readonly string[];
}

export type UsageWidgetId =
  | "logical-requests"
  | "requests-by-agent"
  | "requests-by-workspace"
  | "input-tokens"
  | "output-tokens"
  | "cache-rate"
  | "p95-latency"
  | "attempts-by-provider"
  | "mcp-calls"
  | "mcp-duration"
  | "mcp-errors"
  | "mcp-by-tool"
  | "attempt-errors-by-provider"
  | "context-compactions"
  | "context-compactions-over-time"
  | "context-compactions-by-workspace"
  | "context-compactions-by-model"
  | "context-compactions-by-agent"
  | "git-commits"
  | "git-files-changed"
  | "git-files-added"
  | "git-files-deleted"
  | "git-lines-added"
  | "git-lines-removed"
  | "git-partial-commits"
  | "git-commits-by-workspace"
  | "git-commits-by-provider"
  | "git-commits-by-agent"
  | "skill-events-by-event"
  | "estimated-cost";

/** One bounded time bucket from an observed Usage time-series widget. */
export interface UsageTimeBucketCount {
  readonly bucket: string;
  readonly count: number;
}

/** One bounded category row from an observed Usage breakdown widget. */
export interface UsageBreakdownCount {
  readonly name: string;
  readonly count: number;
}

/**
 * One workspace bucket of the logical-request breakdown.
 *
 * `workspace` is the workspace the requests were attributed to, or `null` when
 * the request carried no workspace attribution at all. The two are different
 * facts: an unattributed request belongs to no workspace, so a consumer must
 * not fold it into the nearest workspace it can see.
 */
export interface UsageWorkspaceRequestCount {
  readonly workspace: string | null;
  readonly count: number;
}

/**
 * The logical routed requests grouped by workspace.
 *
 * `partial` is true when the source's own row limit truncated the breakdown.
 * It decides what an *absent* workspace means: a workspace missing from a
 * complete breakdown made no requests, while a workspace missing from a
 * truncated one is simply not reported, and rendering the second as the first
 * would report a measured zero the source never measured.
 */
export interface UsageWorkspaceRequestBreakdown {
  readonly rows: readonly UsageWorkspaceRequestCount[];
  readonly partial: boolean;
}

/** Axes that do not have source-confirmed semantics for logical compaction spans. */
export type UsageCompactionUnsupportedFilter = "provider" | "skill";

/** Filters the source does not record on a commit itself. */
export type UsageGitChangeUnsupportedFilter = "model" | "skill";

export type UsageGitChangeStatus =
  "observed" | "not-observed" | "unavailable" | "not-applicable";

export type UsageGitChangeNotApplicableReason =
  "active-sessions" | "unsupported-filter";

/** Bounded Git output measurements from commit-owned Runtime metric counters. */
export interface UsageGitChangeMetrics {
  readonly status: UsageGitChangeStatus;
  readonly notApplicableReason: UsageGitChangeNotApplicableReason | null;
  readonly unsupportedFilters: readonly UsageGitChangeUnsupportedFilter[];
  /** Whether the window contains partial diff measurements; null if unknown. */
  readonly partial: boolean | null;
  /** True when one or more bounded category queries may be truncated. */
  readonly breakdownsPartial: boolean;
  readonly commits: number | null;
  readonly filesChanged: number | null;
  readonly filesAdded: number | null;
  readonly filesDeleted: number | null;
  readonly linesAdded: number | null;
  readonly linesRemoved: number | null;
  readonly partialCommits: number | null;
  readonly commitsByWorkspace: readonly UsageBreakdownCount[] | null;
  readonly commitsByProvider: readonly UsageBreakdownCount[] | null;
  readonly commitsByAgent: readonly UsageBreakdownCount[] | null;
}

export interface UsageWidgetConfig {
  readonly id: UsageWidgetId;
  readonly title: string;
  readonly description?: string;
  readonly optInVariables: readonly UsageVariableId[];
  readonly variableScopeOverrides?: Partial<
    Record<UsageVariableId, "resource" | "span" | "metric">
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

/** Historical request, pricing, reliability, skill, and MCP Usage evidence. */
export interface UsageMetricsData {
  readonly logicalRequests: number | null;
  readonly totalInputTokens: number | null;
  readonly totalOutputTokens: number | null;
  readonly cacheReadRate: number | null;
  readonly p95LatencyMs: number | null;
  /** OpenLIT's pricing-catalog estimate; not a provider billing statement. */
  readonly estimatedCostUsd: number | null;
  readonly physicalAttempts: number | null;
  readonly mcpCalls: number | null;
  readonly p95McpDurationMs: number | null;
  readonly mcpErrors: number | null;
  readonly failedAttempts: number | null;
  readonly attemptErrorsByProvider:
    readonly { readonly provider: string; readonly count: number }[] | null;
  readonly contextCompactions: number | null;
  /** Source-confirmed compactions per logical routed request, as a percent. */
  readonly contextCompactionRatePercent: number | null;
  readonly contextCompactionsOverTime: readonly UsageTimeBucketCount[] | null;
  readonly contextCompactionsByWorkspace: readonly UsageBreakdownCount[] | null;
  readonly contextCompactionsByModel: readonly UsageBreakdownCount[] | null;
  readonly contextCompactionsByAgent: readonly UsageBreakdownCount[] | null;
  /** Provider/skill scopes are unsupported for this logical-request signal. */
  readonly contextCompactionsUnsupportedFilters: readonly UsageCompactionUnsupportedFilter[];
  /** True when one or more bounded compaction breakdowns may be truncated. */
  readonly contextCompactionsBreakdownsPartial: boolean;
  readonly gitChanges: UsageGitChangeMetrics;
  readonly skillEventsByEvent:
    readonly { readonly event: string; readonly count: number }[] | null;
  readonly requestsByRole:
    readonly { readonly role: string; readonly count: number }[] | null;
  /** Logical routed requests grouped by workspace; null when not observed. */
  readonly requestsByWorkspace: UsageWorkspaceRequestBreakdown | null;
  readonly attemptsByProvider:
    readonly { readonly provider: string; readonly count: number }[] | null;
  readonly callsByTool:
    readonly { readonly tool: string; readonly count: number }[] | null;
}

export interface UsageSnapshot {
  readonly metrics: UsageMetricsData;
  readonly filterOptions: UsageFilterOptions;
  readonly traceList: UsageTraceList;
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

/** Safe, bounded trace activity for the Usage history table. */
export interface UsageTraceAttempt {
  readonly spanId: string;
  readonly timestamp: string;
  readonly durationNs: number;
  readonly statusCode: UsageTraceStatus;
  readonly provider: string | null;
  readonly model: string | null;
  readonly role: string | null;
}

export type UsageTraceList =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "not-applicable";
      readonly reason: "skill-filter" | "unsupported-filter";
    }
  | {
      readonly kind: "observed";
      readonly attempts: readonly UsageTraceAttempt[];
      readonly partial: boolean;
    };

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
