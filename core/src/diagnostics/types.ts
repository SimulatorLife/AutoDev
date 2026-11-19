/**
 * The unified session diagnostics contract.
 *
 * One session's evidence is read from several authoritative places -- the
 * Codex rollouts, the router's rotated logs, the bridge logs, the hook log,
 * and the live router -- and three consumers read it: the Console's `/usage`
 * page, the `autodev-session-diagnostics` skill, and `pnpm autodev --
 * diagnostics`. Those three used to have three different shapes, so a fact
 * could be true in one surface and missing from another.
 *
 * This module is the single shape they all speak. It is pure: no filesystem,
 * no network, no clock. The engine that fills it lives in
 * `@simulatorlife/autodev-data/diagnostics`, and the text rendering lives
 * beside these types so a CLI and an HTTP response cannot drift apart.
 */

/** The schema of one session's full diagnostics report. */
export const SESSION_DIAGNOSTICS_SCHEMA = "autodev-session-diagnostics-v1";

/** The schema of the recent-sessions listing. */
export const SESSION_RECENT_LIST_SCHEMA = "autodev-session-recent-v1";

/** The schema of the cross-session fleet scan. */
export const SESSION_FLEET_SCAN_SCHEMA = "autodev-session-fleet-scan-v1";

/** The schema of the hook-denial summary. */
export const SESSION_HOOK_DENIALS_SCHEMA = "autodev-session-hook-denials-v1";

/** The categories a tool failure can fall into. */
export const TOOL_FAILURE_CATEGORIES = [
  "pretooluse-hook",
  "json-wrap-syntax",
  "syntax-error",
  "apply-patch",
  "spawn-limit",
  "delegation-unavailable",
  "missing-tool",
  "transport-closed",
  "aborted",
  "other"
] as const;

export type ToolFailureCategory = (typeof TOOL_FAILURE_CATEGORIES)[number];

/** The closed set of categories, for allowlisting a filter value. */
export function isToolFailureCategory(
  value: unknown
): value is ToolFailureCategory {
  return (
    typeof value === "string" &&
    (TOOL_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** The bounded page sizes the diagnostics API accepts. */
export const SESSION_EVENTS_PAGE_LIMIT = 200;
export const SESSION_EVENTS_PAGE_DEFAULT = 50;
export const SESSION_ITEMS_PAGE_LIMIT = 200;
export const SESSION_ITEMS_PAGE_DEFAULT = 50;
export const SESSION_FLEET_SCAN_LIMIT = 50;
export const SESSION_RECENT_LIMIT = 50;
export const SESSION_HOOK_DENIAL_WINDOW_DAYS = 30;

/** One tool call that did not do its job. */
export interface SessionToolFailure {
  readonly at: string;
  readonly tool: string;
  readonly callId: string;
  readonly detail: string;
  readonly category?: ToolFailureCategory;
  readonly input?: string;
}

/** Assistant messages that carried only a tag pair and no content. */
export interface SessionThreadAnomalies {
  readonly tagOnlyMessages: number;
  readonly samples: readonly string[];
}

/** One thread's token usage, accumulated across compaction resets. */
export interface SessionThreadTokenUsage {
  readonly observed: boolean;
  readonly samples: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly cacheHitPct: number | null;
  readonly reasoningPct: number | null;
  readonly peakInputTokens: number;
  readonly cacheDrops: number;
}

/** One thread's context compaction evidence. */
export interface SessionThreadCompactionSummary {
  readonly count: number;
  readonly contextCompactedEvents: number;
  readonly maxReplacementItems: number;
  readonly maxReplacementBytes: number;
  readonly maxReplacementImages: number;
  readonly responseImageItems: number;
}

/** One thread's prompt and skill-catalog overhead. */
export interface SessionThreadPromptOverhead {
  readonly initialDeveloperBytes: number;
  readonly skillsCatalogBytes: number;
  readonly skillsLoaded: number;
  readonly skillsByRoot: Readonly<Record<string, number>>;
  readonly skillsRead: readonly string[];
  readonly skillTelemetryReads: number | null;
}

/** One thread's efficiency evidence. */
export interface SessionThreadEfficiency {
  readonly tokens: SessionThreadTokenUsage;
  readonly compaction: SessionThreadCompactionSummary;
  readonly prompt: SessionThreadPromptOverhead;
}

/** One turn of one thread. */
export interface SessionThreadTurn {
  readonly turnId: string;
  readonly started: string | null;
  readonly ended: string | null;
  readonly outcome: string;
  readonly detail: string | null;
}

/** A silence of a minute or more inside one thread. */
export interface SessionThreadGap {
  readonly seconds: number;
  readonly after: string;
  readonly before: string;
  readonly at: string;
}

/** One truncated rollout item, with the thread it came from. */
export interface SessionThreadItem {
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
  readonly threadId: string;
}

/**
 * How much a thread investigated before it first changed a file.
 *
 * `observed` is false when the rollout carries no `item_completed` records: the
 * counts are then unknown, not zero.
 */
export interface SessionInvestigation {
  readonly observed: boolean;
  readonly firstEditAt: string | null;
  readonly toolCalls: number;
  readonly tokens: number | null;
  readonly filesRead: number;
  readonly repeatedReads: number;
  readonly searches: number;
  readonly repeatedSearches: number;
  readonly context: { readonly ccc: number; readonly cgc: number; readonly lsp: number };
}

/** One thread of a session: the root turn and every subagent under it. */
export interface SessionThreadTrace {
  readonly id: string;
  readonly sessionId: string | null;
  readonly parentId: string | null;
  readonly nickname: string | null;
  readonly role: string | null;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly cliVersion: string | null;
  readonly cwd: string | null;
  readonly file: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly turns: readonly SessionThreadTurn[];
  readonly gaps: readonly SessionThreadGap[];
  /** Calls by tool; MCP tools are keyed `mcp__<server>__<tool>`. */
  readonly tools: Readonly<Record<string, number>>;
  readonly toolFailures: readonly SessionToolFailure[];
  readonly anomalies?: SessionThreadAnomalies;
  readonly efficiency?: SessionThreadEfficiency;
  readonly investigation: SessionInvestigation;
  readonly items?: readonly SessionThreadItem[];
}

/** One router event row, as the router recorded it. */
export interface SessionRouterEventRow {
  readonly at: string;
  readonly requestId: string;
  readonly thread: string | null;
  readonly phase: string;
  readonly role: string | null;
  readonly requestedModel: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly outcome: string | null;
  readonly status: number | null;
  readonly failureClass: string | null;
  readonly reason?: string | null;
  readonly spawnFailureReason: string | null;
  readonly denialReason: string | null;
  readonly elapsedMs: number | null;
  readonly toolCalls: number | null;
  readonly selection: string | null;
  readonly errorName?: string | null;
  readonly errorCode?: string | null;
}

/** One request the router skipped, with the reason it gave. */
export interface SessionRouterSkippedEvent {
  readonly at: string;
  readonly requestId: string;
  readonly provider: string | null;
  readonly reason: string;
  readonly elapsedMs: number | null;
}

/** One router request that failed. */
export interface SessionRouterFailure {
  readonly at: string;
  readonly requestId: string;
  readonly provider: string | null;
  readonly status: number | null;
  readonly failureClass: string | null;
  readonly spawnFailureReason?: string | null;
  readonly elapsedMs: number | null;
}

/** One provider's share of a thread's requests. */
export interface SessionRouterProviderStats {
  readonly requests: number;
  readonly failures: number;
  readonly elapsedMs: number;
  readonly toolCalls: number;
}

/** One thread's router requests, summarised. */
export interface SessionRouterSummary {
  readonly thread: string;
  readonly model: string | null;
  /**
   * `thread`: every matched event names the thread. `model-window`: some are
   * older events matched by model and time, so same-model threads interleave.
   */
  readonly matchedBy: "thread" | "model-window";
  readonly requests: number;
  readonly byProvider: Readonly<Record<string, SessionRouterProviderStats>>;
  readonly failures: readonly SessionRouterFailure[];
  /** Providers in request order, collapsed: a turn that hops shows more. */
  readonly providerSequence: readonly string[];
  readonly skipped?: readonly SessionRouterSkippedEvent[];
  readonly retries?: number;
  readonly exhaustionWaits?: { readonly count: number; readonly totalMs: number };
  readonly transportErrors?: number;
  readonly events?: readonly SessionRouterEventRow[];
}

/** Matching lines from one bridge log. */
export interface SessionBridgeLogAlert {
  readonly file: string;
  readonly count: number;
  readonly samples: readonly string[];
}

/** One log file the diagnostics read, with how fresh it is. */
export interface SessionLogFileSummary {
  readonly file: string;
  readonly modified: string;
  readonly bytes: number;
}

/** What the live runtime looked like while the session ran. */
export interface SessionLiveReport {
  readonly router: {
    readonly reachable: boolean;
    readonly canonicalLiveCount: number | null;
    readonly byState: Readonly<Record<string, number>> | null;
    readonly liveByRole: Readonly<Record<string, number>> | null;
    readonly startedAt: string | null;
  };
  /** Recently written threads whose latest turn has not ended. */
  readonly openThreads: readonly { readonly id: string; readonly modified: string }[];
  readonly processes: readonly string[];
  readonly services: readonly {
    readonly pid: string;
    readonly started: string;
    readonly script: string;
  }[];
  readonly drift: {
    readonly checked: number;
    readonly differing: readonly string[];
    readonly missing: readonly string[];
  } | null;
}

/** One workspace's MCP exposure against what it actually used. */
export interface SessionEfficiencyWorkspaceMcpSummary {
  readonly workspace: string;
  readonly exposed: Readonly<Record<string, number>>;
  readonly used: Readonly<Record<string, number>>;
  readonly topTools: readonly {
    readonly tool: string;
    readonly ok: number;
    readonly error: number;
  }[];
}

/** The persisted router state, read beside the live one. */
export interface SessionEfficiencySummary {
  readonly disabledProviders: readonly string[];
  readonly nullRoleModels: readonly string[];
  readonly providerLastFailures?: readonly {
    readonly provider: string;
    readonly status: string | null;
    readonly cooldownKind: string | null;
    readonly lastFailureClass: string | null;
    readonly lastFailureStatus: number | null;
  }[];
  readonly workspaces?: readonly SessionEfficiencyWorkspaceMcpSummary[];
}

/** One bounded page of a longer list. */
export interface SessionPagedSlice<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

/** The session-wide rollups every surface shows first. */
export interface SessionDiagnosticsAggregates {
  readonly threadCount: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly cacheHitPct: number | null;
  readonly reasoningPct: number | null;
  readonly peakInputTokens: number;
  readonly cacheDrops: number;
  readonly compactions: number;
  readonly contextCompactedEvents: number;
  readonly maxReplacementItems: number;
  readonly maxReplacementBytes: number;
  readonly maxReplacementImages: number;
  readonly responseImageItems: number;
  readonly maxInitialDeveloperBytes: number;
  readonly maxSkillsCatalogBytes: number;
  readonly maxSkillsLoaded: number;
  readonly skillsByRoot: Readonly<Record<string, number>>;
  readonly uniqueSkillsRead: number;
  readonly skillTelemetryReads: number | null;
  readonly turnsTotal: number;
  readonly turnsByOutcome: Readonly<Record<string, number>>;
  readonly gapsCount: number;
  readonly toolCallsTotal: number;
  readonly toolCallsByName: Readonly<Record<string, number>>;
  readonly toolFailuresTotal: number;
  readonly toolFailuresByCategory: Readonly<Record<string, number>>;
  readonly preToolUseBlocks: number;
  readonly routerRequests: number;
  readonly routerFailures: number;
  readonly routerSkippedTotal: number;
  readonly routerSkippedByReason: Readonly<Record<string, number>>;
  readonly routerRetries: number;
  readonly exhaustionWaits: number;
  readonly transportErrors: number;
  readonly providerHops: number;
  readonly byProvider: Readonly<Record<string, SessionRouterProviderStats>>;
}

/** One session's full diagnostics report. */
export interface SessionDiagnosticsReport {
  readonly schema: typeof SESSION_DIAGNOSTICS_SCHEMA;
  /** False when no rollout matched the requested id. */
  readonly found: boolean;
  readonly requestedId: string;
  /** The session the id resolved to, when it resolved to one. */
  readonly rootSessionId: string | null;
  /** True when the id named a child thread rather than the session root. */
  readonly matchedByThreadId: boolean;
  readonly threads: readonly SessionThreadTrace[];
  readonly router: readonly SessionRouterSummary[];
  readonly logs: readonly SessionLogFileSummary[];
  readonly bridgeAlerts: readonly SessionBridgeLogAlert[];
  readonly live: SessionLiveReport | null;
  readonly efficiency: SessionEfficiencySummary | null;
  readonly aggregates: SessionDiagnosticsAggregates;
  readonly eventsPage: SessionPagedSlice<SessionRouterEventRow>;
  readonly itemsPage: SessionPagedSlice<SessionThreadItem>;
}

/** One session in the recent-sessions listing. */
export interface RecentSessionSummary {
  readonly id: string;
  readonly started: string;
  readonly lastWrite: string;
  readonly threads: number;
  readonly cwd: string | null;
}

/** The recent-sessions listing. */
export interface SessionRecentListResponse {
  readonly schema: typeof SESSION_RECENT_LIST_SCHEMA;
  readonly limit: number;
  readonly sessions: readonly RecentSessionSummary[];
}

/** One session's row in the fleet scan. */
export interface FleetSessionRow {
  readonly id: string;
  readonly started: string;
  readonly lastWrite: string;
  readonly cwd: string | null;
  readonly threads: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheHitPct: number | null;
  readonly cacheDrops: number;
  readonly compactions: number;
  readonly maxSkillsLoaded: number;
  readonly toolFailures: number;
  readonly preToolUseBlocks: number;
  readonly topFailureCategory: ToolFailureCategory | null;
  readonly routerRequests: number;
  readonly routerFailures: number;
  readonly routerSkipped: Readonly<Record<string, number>>;
  readonly providers: Readonly<Record<string, number>>;
}

/** The fleet-wide totals of the fleet scan. */
export interface FleetScanTotals {
  readonly sessions: number;
  readonly threads: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheHitPct: number | null;
  readonly cacheDrops: number;
  readonly compactions: number;
  readonly toolFailuresByCategory: Readonly<Record<string, number>>;
  readonly preToolUseReasons: readonly {
    readonly reason: string;
    readonly count: number;
  }[];
  readonly routerSkippedByReason: readonly {
    readonly key: string;
    readonly count: number;
  }[];
}

/** The fleet scan across the newest sessions. */
export interface SessionFleetScanResponse {
  readonly schema: typeof SESSION_FLEET_SCAN_SCHEMA;
  readonly limit: number;
  readonly sessions: readonly FleetSessionRow[];
  readonly totals: FleetScanTotals;
}

/** The `PreToolUse` denials recorded in the hook log. */
export interface HookDenialSummary {
  readonly logFile: string;
  readonly sinceDays: number;
  readonly cutoff: string;
  readonly totalLines: number;
  readonly userPromptSubmits: number;
  readonly preToolUseDenials: number;
  readonly byPolicy: Readonly<Record<string, number>>;
  readonly byRole: Readonly<Record<string, number>>;
  readonly byReason: readonly { readonly reason: string; readonly count: number }[];
  readonly topCommands: readonly {
    readonly commandHead: string;
    readonly policy: string;
    readonly count: number;
  }[];
}

/** The hook-denial summary response. */
export interface SessionHookDenialsResponse {
  readonly schema: typeof SESSION_HOOK_DENIALS_SCHEMA;
  readonly summary: HookDenialSummary;
}

/**
 * The failure categories, in the order they are tried.
 *
 * A failure is categorized by the first rule that matches, so the order is the
 * contract: a `SyntaxError` inside a JSON-wrapped argument is a
 * `json-wrap-syntax` failure, not a plain `syntax-error`.
 */
const FAILURE_CATEGORY_RULES: ReadonlyArray<
  readonly [ToolFailureCategory, RegExp]
> = [
  ["pretooluse-hook", /Command blocked by PreToolUse hook:/i],
  ["delegation-unavailable", /Delegation is unavailable/i],
  ["spawn-limit", /agent thread limit reached|collab spawn failed/i],
  ["apply-patch", /apply_patch verification failed/i],
  ["syntax-error", /SyntaxError:/i],
  ["missing-tool", /is not a function|No such tool|not found in ALL_TOOLS/i],
  ["transport-closed", /Transport closed/i],
  ["aborted", /^aborted/i]
];

const SYNTAX_COLON_REGEX = /SyntaxError: Unexpected token ':'/i;

/**
 * The category a tool failure falls into.
 *
 * A caller that already knows the category passes it through; a caller that
 * only has the excerpt derives it here, so the Console, the CLI and the fleet
 * scan agree on what "a hook block" is.
 */
export function classifyToolFailure(
  detail: string,
  input?: string | undefined
): ToolFailureCategory {
  if (SYNTAX_COLON_REGEX.test(detail)) {
    return input?.trimStart().startsWith("{")
      ? "json-wrap-syntax"
      : "syntax-error";
  }
  for (const [category, pattern] of FAILURE_CATEGORY_RULES) {
    if (pattern.test(detail)) return category;
  }
  return "other";
}

/* ------------------------------------------------------------------ */
/* Runtime validators.                                                 */
/*                                                                     */
/* The Console reads these payloads over HTTP from a service it does   */
/* not control, so a malformed body must fail closed rather than be    */
/* rendered as though it were evidence.                                */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isCountMap(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isNumber(entry));
}

function isNullableCountMap(
  value: unknown
): value is Record<string, number> | null {
  return value === null || isCountMap(value);
}

function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isSessionToolFailure(value: unknown): value is SessionToolFailure {
  if (!isRecord(value)) return false;
  if (
    typeof value.at !== "string" ||
    typeof value.tool !== "string" ||
    typeof value.callId !== "string" ||
    typeof value.detail !== "string"
  )
    return false;
  if (value.category !== undefined && !isToolFailureCategory(value.category))
    return false;
  return value.input === undefined || typeof value.input === "string";
}

function isSessionThreadTurn(value: unknown): value is SessionThreadTurn {
  if (!isRecord(value)) return false;
  return (
    typeof value.turnId === "string" &&
    isNullableString(value.started) &&
    isNullableString(value.ended) &&
    typeof value.outcome === "string" &&
    isNullableString(value.detail)
  );
}

function isSessionThreadGap(value: unknown): value is SessionThreadGap {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.seconds) &&
    typeof value.after === "string" &&
    typeof value.before === "string" &&
    typeof value.at === "string"
  );
}

function isSessionInvestigation(value: unknown): value is SessionInvestigation {
  if (!isRecord(value)) return false;
  if (typeof value.observed !== "boolean") return false;
  if (!isNullableString(value.firstEditAt)) return false;
  if (!isNumber(value.toolCalls) || !isNullableNumber(value.tokens))
    return false;
  if (
    !isNumber(value.filesRead) ||
    !isNumber(value.repeatedReads) ||
    !isNumber(value.searches) ||
    !isNumber(value.repeatedSearches)
  )
    return false;
  if (!isRecord(value.context)) return false;
  return (
    isNumber(value.context.ccc) &&
    isNumber(value.context.cgc) &&
    isNumber(value.context.lsp)
  );
}

function isSessionThreadEfficiency(
  value: unknown
): value is SessionThreadEfficiency {
  if (!isRecord(value)) return false;
  if (!isRecord(value.tokens) || !isRecord(value.compaction))
    return false;
  if (!isRecord(value.prompt)) return false;
  const { tokens, compaction, prompt } = value;
  return (
    typeof tokens.observed === "boolean" &&
    isNumber(tokens.samples) &&
    isNumber(tokens.inputTokens) &&
    isNumber(tokens.cachedInputTokens) &&
    isNumber(tokens.outputTokens) &&
    isNumber(tokens.reasoningOutputTokens) &&
    isNumber(tokens.totalTokens) &&
    isNullableNumber(tokens.cacheHitPct) &&
    isNullableNumber(tokens.reasoningPct) &&
    isNumber(tokens.peakInputTokens) &&
    isNumber(tokens.cacheDrops) &&
    isNumber(compaction.count) &&
    isNumber(compaction.contextCompactedEvents) &&
    isNumber(compaction.maxReplacementItems) &&
    isNumber(compaction.maxReplacementBytes) &&
    isNumber(compaction.maxReplacementImages) &&
    isNumber(compaction.responseImageItems) &&
    isNumber(prompt.initialDeveloperBytes) &&
    isNumber(prompt.skillsCatalogBytes) &&
    isNumber(prompt.skillsLoaded) &&
    isCountMap(prompt.skillsByRoot) &&
    isStringList(prompt.skillsRead) &&
    isNullableNumber(prompt.skillTelemetryReads)
  );
}

function isSessionThreadTrace(value: unknown): value is SessionThreadTrace {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    !isNullableString(value.sessionId) ||
    !isNullableString(value.parentId) ||
    !isNullableString(value.nickname) ||
    !isNullableString(value.role) ||
    !isNullableString(value.model) ||
    !isNullableString(value.modelProvider) ||
    !isNullableString(value.cliVersion) ||
    !isNullableString(value.cwd) ||
    typeof value.file !== "string" ||
    !isNullableString(value.start) ||
    !isNullableString(value.end)
  )
    return false;
  if (!isCountMap(value.counts) || !isCountMap(value.tools))
    return false;
  if (!Array.isArray(value.turns) || !value.turns.every(isSessionThreadTurn))
    return false;
  if (!Array.isArray(value.gaps) || !value.gaps.every(isSessionThreadGap))
    return false;
  if (
    !Array.isArray(value.toolFailures) ||
    !value.toolFailures.every(isSessionToolFailure)
  )
    return false;
  if (!isSessionInvestigation(value.investigation)) return false;
  if (value.efficiency !== undefined && !isSessionThreadEfficiency(value.efficiency))
    return false;
  if (value.anomalies !== undefined) {
    if (!isRecord(value.anomalies)) return false;
    if (!isNumber(value.anomalies.tagOnlyMessages)) return false;
    if (!isStringList(value.anomalies.samples)) return false;
  }
  if (value.items !== undefined) {
    if (!Array.isArray(value.items)) return false;
    for (const item of value.items) {
      if (!isRecord(item)) return false;
      if (
        typeof item.at !== "string" ||
        typeof item.kind !== "string" ||
        typeof item.detail !== "string" ||
        typeof item.threadId !== "string"
      )
        return false;
    }
  }
  return true;
}

function isSessionRouterEventRow(value: unknown): value is SessionRouterEventRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.at === "string" &&
    typeof value.requestId === "string" &&
    isNullableString(value.thread) &&
    typeof value.phase === "string" &&
    isNullableString(value.role) &&
    isNullableString(value.requestedModel) &&
    isNullableString(value.provider) &&
    isNullableString(value.model) &&
    isNullableString(value.outcome) &&
    isNullableNumber(value.status) &&
    isNullableString(value.failureClass) &&
    isNullableString(value.spawnFailureReason) &&
    isNullableString(value.denialReason) &&
    isNullableNumber(value.elapsedMs) &&
    isNullableNumber(value.toolCalls) &&
    isNullableString(value.selection)
  );
}

function isSessionRouterProviderStats(
  value: unknown
): value is SessionRouterProviderStats {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.requests) &&
    isNumber(value.failures) &&
    isNumber(value.elapsedMs) &&
    isNumber(value.toolCalls)
  );
}

function isSessionRouterSummary(value: unknown): value is SessionRouterSummary {
  if (!isRecord(value)) return false;
  if (
    typeof value.thread !== "string" ||
    !isNullableString(value.model) ||
    (value.matchedBy !== "thread" && value.matchedBy !== "model-window")
  )
    return false;
  if (!isNumber(value.requests)) return false;
  if (!isRecord(value.byProvider)) return false;
  if (!Object.values(value.byProvider).every(isSessionRouterProviderStats))
    return false;
  if (!Array.isArray(value.failures)) return false;
  for (const failure of value.failures) {
    if (!isRecord(failure)) return false;
    if (
      typeof failure.at !== "string" ||
      typeof failure.requestId !== "string" ||
      !isNullableString(failure.provider) ||
      !isNullableNumber(failure.status) ||
      !isNullableString(failure.failureClass) ||
      !isNullableNumber(failure.elapsedMs)
    )
      return false;
  }
  if (!isStringList(value.providerSequence)) return false;
  if (value.skipped !== undefined) {
    if (!Array.isArray(value.skipped)) return false;
    for (const skipped of value.skipped) {
      if (!isRecord(skipped)) return false;
      if (
        typeof skipped.at !== "string" ||
        typeof skipped.requestId !== "string" ||
        !isNullableString(skipped.provider) ||
        typeof skipped.reason !== "string" ||
        !isNullableNumber(skipped.elapsedMs)
      )
        return false;
    }
  }
  if (value.retries !== undefined && !isNumber(value.retries)) return false;
  if (value.exhaustionWaits !== undefined) {
    if (!isRecord(value.exhaustionWaits)) return false;
    if (
      !isNumber(value.exhaustionWaits.count) ||
      !isNumber(value.exhaustionWaits.totalMs)
    )
      return false;
  }
  if (value.transportErrors !== undefined && !isNumber(value.transportErrors))
    return false;
  if (value.events !== undefined) {
    if (!Array.isArray(value.events)) return false;
    if (!value.events.every(isSessionRouterEventRow)) return false;
  }
  return true;
}

function isSessionLiveReport(value: unknown): value is SessionLiveReport {
  if (!isRecord(value)) return false;
  if (!isRecord(value.router)) return false;
  const { router } = value;
  if (
    typeof router.reachable !== "boolean" ||
    !isNullableNumber(router.canonicalLiveCount) ||
    !isNullableCountMap(router.byState) ||
    !isNullableCountMap(router.liveByRole) ||
    !isNullableString(router.startedAt)
  )
    return false;
  if (!Array.isArray(value.openThreads)) return false;
  for (const thread of value.openThreads) {
    if (!isRecord(thread)) return false;
    if (typeof thread.id !== "string" || typeof thread.modified !== "string")
      return false;
  }
  if (!isStringList(value.processes)) return false;
  if (!Array.isArray(value.services)) return false;
  for (const service of value.services) {
    if (!isRecord(service)) return false;
    if (
      typeof service.pid !== "string" ||
      typeof service.started !== "string" ||
      typeof service.script !== "string"
    )
      return false;
  }
  if (value.drift !== null) {
    if (!isRecord(value.drift)) return false;
    if (!isNumber(value.drift.checked)) return false;
    if (!isStringList(value.drift.differing)) return false;
    if (!isStringList(value.drift.missing)) return false;
  }
  return true;
}

function isSessionEfficiencySummary(
  value: unknown
): value is SessionEfficiencySummary {
  if (!isRecord(value)) return false;
  if (!isStringList(value.disabledProviders)) return false;
  if (!isStringList(value.nullRoleModels)) return false;
  if (value.providerLastFailures !== undefined) {
    if (!Array.isArray(value.providerLastFailures)) return false;
    for (const failure of value.providerLastFailures) {
      if (!isRecord(failure)) return false;
      if (
        typeof failure.provider !== "string" ||
        !isNullableString(failure.status) ||
        !isNullableString(failure.cooldownKind) ||
        !isNullableString(failure.lastFailureClass) ||
        !isNullableNumber(failure.lastFailureStatus)
      )
        return false;
    }
  }
  if (value.workspaces !== undefined) {
    if (!Array.isArray(value.workspaces)) return false;
    for (const workspace of value.workspaces) {
      if (!isRecord(workspace)) return false;
      if (typeof workspace.workspace !== "string") return false;
      if (!isCountMap(workspace.exposed) || !isCountMap(workspace.used))
        return false;
      if (!Array.isArray(workspace.topTools)) return false;
      for (const tool of workspace.topTools) {
        if (!isRecord(tool)) return false;
        if (
          typeof tool.tool !== "string" ||
          !isNumber(tool.ok) ||
          !isNumber(tool.error)
        )
          return false;
      }
    }
  }
  return true;
}

function isSessionPagedSlice(value: unknown): value is SessionPagedSlice<unknown> {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.items) &&
    isNumber(value.total) &&
    isNumber(value.limit) &&
    isNumber(value.offset) &&
    typeof value.hasMore === "boolean"
  );
}

function isSessionDiagnosticsAggregates(
  value: unknown
): value is SessionDiagnosticsAggregates {
  if (!isRecord(value)) return false;
  const numeric: readonly string[] = [
    "threadCount",
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "peakInputTokens",
    "cacheDrops",
    "compactions",
    "contextCompactedEvents",
    "maxReplacementItems",
    "maxReplacementBytes",
    "maxReplacementImages",
    "responseImageItems",
    "maxInitialDeveloperBytes",
    "maxSkillsCatalogBytes",
    "maxSkillsLoaded",
    "uniqueSkillsRead",
    "turnsTotal",
    "gapsCount",
    "toolCallsTotal",
    "toolFailuresTotal",
    "preToolUseBlocks",
    "routerRequests",
    "routerFailures",
    "routerSkippedTotal",
    "routerRetries",
    "exhaustionWaits",
    "transportErrors",
    "providerHops"
  ];
  for (const key of numeric) {
    if (!isNumber(value[key])) return false;
  }
  if (!isNullableNumber(value.cacheHitPct)) return false;
  if (!isNullableNumber(value.reasoningPct)) return false;
  if (!isNullableNumber(value.skillTelemetryReads)) return false;
  if (!isCountMap(value.skillsByRoot)) return false;
  if (!isCountMap(value.turnsByOutcome)) return false;
  if (!isCountMap(value.toolCallsByName)) return false;
  if (!isCountMap(value.toolFailuresByCategory)) return false;
  if (!isCountMap(value.routerSkippedByReason)) return false;
  if (!isRecord(value.byProvider)) return false;
  return Object.values(value.byProvider).every(isSessionRouterProviderStats);
}

/** Whether a payload is a usable session diagnostics report. */
export function isSessionDiagnosticsReport(
  value: unknown
): value is SessionDiagnosticsReport {
  if (!isRecord(value)) return false;
  if (value.schema !== SESSION_DIAGNOSTICS_SCHEMA) return false;
  if (typeof value.found !== "boolean") return false;
  if (typeof value.requestedId !== "string") return false;
  if (!isNullableString(value.rootSessionId)) return false;
  if (typeof value.matchedByThreadId !== "boolean") return false;
  if (!Array.isArray(value.threads) || !value.threads.every(isSessionThreadTrace))
    return false;
  if (!Array.isArray(value.router) || !value.router.every(isSessionRouterSummary))
    return false;
  if (!Array.isArray(value.logs)) return false;
  for (const log of value.logs) {
    if (!isRecord(log)) return false;
    if (
      typeof log.file !== "string" ||
      typeof log.modified !== "string" ||
      !isNumber(log.bytes)
    )
      return false;
  }
  if (!Array.isArray(value.bridgeAlerts)) return false;
  for (const alert of value.bridgeAlerts) {
    if (!isRecord(alert)) return false;
    if (
      typeof alert.file !== "string" ||
      !isNumber(alert.count) ||
      !isStringList(alert.samples)
    )
      return false;
  }
  if (value.live !== null && !isSessionLiveReport(value.live)) return false;
  if (value.efficiency !== null && !isSessionEfficiencySummary(value.efficiency))
    return false;
  if (!isSessionDiagnosticsAggregates(value.aggregates)) return false;
  if (!isSessionPagedSlice(value.eventsPage)) return false;
  if (!isSessionPagedSlice(value.itemsPage)) return false;
  return true;
}

/** Whether a payload is a usable recent-sessions listing. */
export function isSessionRecentListResponse(
  value: unknown
): value is SessionRecentListResponse {
  if (!isRecord(value)) return false;
  if (value.schema !== SESSION_RECENT_LIST_SCHEMA) return false;
  if (!isNumber(value.limit)) return false;
  if (!Array.isArray(value.sessions)) return false;
  for (const session of value.sessions) {
    if (!isRecord(session)) return false;
    if (
      typeof session.id !== "string" ||
      typeof session.started !== "string" ||
      typeof session.lastWrite !== "string" ||
      !isNumber(session.threads) ||
      !isNullableString(session.cwd)
    )
      return false;
  }
  return true;
}

/** Whether a payload is a usable fleet scan. */
export function isSessionFleetScanResponse(
  value: unknown
): value is SessionFleetScanResponse {
  if (!isRecord(value)) return false;
  if (value.schema !== SESSION_FLEET_SCAN_SCHEMA) return false;
  if (!isNumber(value.limit)) return false;
  if (!Array.isArray(value.sessions)) return false;
  for (const row of value.sessions) {
    if (!isRecord(row)) return false;
    if (
      typeof row.id !== "string" ||
      typeof row.started !== "string" ||
      typeof row.lastWrite !== "string" ||
      !isNullableString(row.cwd) ||
      !isNumber(row.threads) ||
      !isNumber(row.totalTokens) ||
      !isNumber(row.inputTokens) ||
      !isNumber(row.cachedInputTokens) ||
      !isNullableNumber(row.cacheHitPct) ||
      !isNumber(row.cacheDrops) ||
      !isNumber(row.compactions) ||
      !isNumber(row.maxSkillsLoaded) ||
      !isNumber(row.toolFailures) ||
      !isNumber(row.preToolUseBlocks) ||
      (row.topFailureCategory !== null &&
        !isToolFailureCategory(row.topFailureCategory)) ||
      !isNumber(row.routerRequests) ||
      !isNumber(row.routerFailures) ||
      !isCountMap(row.routerSkipped) ||
      !isCountMap(row.providers)
    )
      return false;
  }
  if (!isRecord(value.totals)) return false;
  const { totals } = value;
  if (
    !isNumber(totals.sessions) ||
    !isNumber(totals.threads) ||
    !isNumber(totals.totalTokens) ||
    !isNumber(totals.inputTokens) ||
    !isNumber(totals.cachedInputTokens) ||
    !isNullableNumber(totals.cacheHitPct) ||
    !isNumber(totals.cacheDrops) ||
    !isNumber(totals.compactions) ||
    !isCountMap(totals.toolFailuresByCategory)
  )
    return false;
  if (!Array.isArray(totals.preToolUseReasons)) return false;
  for (const entry of totals.preToolUseReasons) {
    if (!isRecord(entry)) return false;
    if (typeof entry.reason !== "string" || !isNumber(entry.count))
      return false;
  }
  if (!Array.isArray(totals.routerSkippedByReason)) return false;
  for (const entry of totals.routerSkippedByReason) {
    if (!isRecord(entry)) return false;
    if (typeof entry.key !== "string" || !isNumber(entry.count)) return false;
  }
  return true;
}

/** Whether a payload is a usable hook-denial summary. */
export function isSessionHookDenialsResponse(
  value: unknown
): value is SessionHookDenialsResponse {
  if (!isRecord(value)) return false;
  if (value.schema !== SESSION_HOOK_DENIALS_SCHEMA) return false;
  if (!isRecord(value.summary)) return false;
  const { summary } = value;
  if (
    typeof summary.logFile !== "string" ||
    !isNumber(summary.sinceDays) ||
    typeof summary.cutoff !== "string" ||
    !isNumber(summary.totalLines) ||
    !isNumber(summary.userPromptSubmits) ||
    !isNumber(summary.preToolUseDenials)
  )
    return false;
  if (!isCountMap(summary.byPolicy) || !isCountMap(summary.byRole)) return false;
  if (!Array.isArray(summary.byReason)) return false;
  for (const entry of summary.byReason) {
    if (!isRecord(entry)) return false;
    if (typeof entry.reason !== "string" || !isNumber(entry.count)) return false;
  }
  if (!Array.isArray(summary.topCommands)) return false;
  for (const entry of summary.topCommands) {
    if (!isRecord(entry)) return false;
    if (
      typeof entry.commandHead !== "string" ||
      typeof entry.policy !== "string" ||
      !isNumber(entry.count)
    )
      return false;
  }
  return true;
}

/** Whether a payload is a plain map of strings, used by the Console's checks. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return isStringMap(value);
}
