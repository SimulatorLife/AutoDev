/**
The unified session diagnostics contract.

One session's evidence is read from several authoritative places -- the
Codex rollouts, the router's rotated logs, the bridge logs, the hook log,
and the live router -- and three consumers read it: the Console's `/usage`
page, the `autodev-session-diagnostics` skill, and `pnpm autodev --
diagnostics`. Those three used to have three different shapes, so a fact
could be true in one surface and missing from another.

This module is the single shape they all speak. It is pure: no filesystem,
no network, no clock. The engine that fills it lives in
`@simulatorlife/autodev-data/diagnostics`, and the text rendering lives
beside these types so a CLI and an HTTP response cannot drift apart.
*/

import { type ClientSurface, isClientSurface } from "./client-surface.ts";

/**
The schema of one session's full diagnostics report.
*/
export const SESSION_DIAGNOSTICS_SCHEMA = "autodev-session-diagnostics-v1";

/**
The schema of the recent-sessions listing.
*/
export const SESSION_RECENT_LIST_SCHEMA = "autodev-session-recent-v1";

/**
The schema of the cross-session fleet scan.
*/
export const SESSION_FLEET_SCAN_SCHEMA = "autodev-session-fleet-scan-v1";

/**
The schema of the hook-denial summary.
*/
export const SESSION_HOOK_DENIALS_SCHEMA = "autodev-session-hook-denials-v1";

/**
The categories a tool failure can fall into.
*/
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

/**
The closed set of categories, for allowlisting a filter value.
*/
export function isToolFailureCategory(
  value: unknown
): value is ToolFailureCategory {
  return (
    typeof value === "string" &&
    (TOOL_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
The bounded page sizes the diagnostics API accepts.
*/
export const SESSION_EVENTS_PAGE_LIMIT = 200;
export const SESSION_EVENTS_PAGE_DEFAULT = 50;
export const SESSION_ITEMS_PAGE_LIMIT = 200;
export const SESSION_ITEMS_PAGE_DEFAULT = 50;
export const SESSION_FLEET_SCAN_LIMIT = 50;
export const SESSION_RECENT_LIMIT = 50;
export const SESSION_HOOK_DENIAL_WINDOW_DAYS = 30;

/**
One tool call that did not do its job.
*/
export interface SessionToolFailure {
  readonly at: string;
  readonly tool: string;
  readonly callId: string;
  readonly detail: string;
  readonly category?: ToolFailureCategory;
  readonly input?: string;
}

/**
Assistant messages that carried only a tag pair and no content.
*/
export interface SessionThreadAnomalies {
  readonly tagOnlyMessages: number;
  readonly samples: readonly string[];
}

/**
One thread's token usage, accumulated across compaction resets.
*/
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

/**
One thread's context compaction evidence.
*/
export interface SessionThreadCompactionSummary {
  readonly count: number;
  readonly contextCompactedEvents: number;
  readonly maxReplacementItems: number;
  readonly maxReplacementBytes: number;
  readonly maxReplacementImages: number;
  readonly responseImageItems: number;
}

/**
One thread's prompt and skill-catalog overhead.
*/
export interface SessionThreadPromptOverhead {
  /**
  The initial developer prompt's size in UTF-8 bytes. The initial developer
  prompt is the text of every developer message the thread received before
  its first agent output, each message's text parts joined with a newline.
  */
  readonly initialDeveloperBytes: number;
  /**
  The same text's length in Unicode code points: a character outside the
  Basic Multilingual Plane (a surrogate pair) counts once, an unpaired
  surrogate counts once, and combining marks count separately (this is not a
  grapheme count).
  */
  readonly initialDeveloperChars: number;
  /**
  The same text's length in tokens, or null when no tokenizer for the
  thread's provider model is available to count it. A rollout records token
  usage only per request, never per message, so the engine reports null
  rather than an estimate.
  */
  readonly initialDeveloperTokens: number | null;
  readonly skillsCatalogBytes: number;
  readonly skillsLoaded: number;
  readonly skillsByRoot: Readonly<Record<string, number>>;
  /**
  The distinct skills whose SKILL.md this thread read, sorted by name.
  */
  readonly skillsRead: readonly string[];
  /**
  How many tool calls of this thread read each skill's SKILL.md, keyed by
  exactly the names in skillsRead. A call that names the same SKILL.md more
  than once is one read; each further call is another.
  */
  readonly skillReadCounts: Readonly<Record<string, number>>;
  readonly skillTelemetryReads: number | null;
}

/**
One thread's efficiency evidence.
*/
export interface SessionThreadEfficiency {
  readonly tokens: SessionThreadTokenUsage;
  readonly compaction: SessionThreadCompactionSummary;
  readonly prompt: SessionThreadPromptOverhead;
}

/**
One turn of one thread.
*/
export interface SessionThreadTurn {
  readonly turnId: string;
  readonly started: string | null;
  readonly ended: string | null;
  readonly outcome: string;
  readonly detail: string | null;
}

/**
A silence of a minute or more inside one thread.
*/
export interface SessionThreadGap {
  readonly seconds: number;
  readonly after: string;
  readonly before: string;
  readonly at: string;
}

/**
One truncated rollout item, with the thread it came from.
*/
export interface SessionThreadItem {
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
  readonly threadId: string;
}

/**
How much a thread investigated before it first changed a file.

`observed` is false when the rollout carries no `item_completed` records: the
counts are then unknown, not zero.
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
  readonly context: {
    readonly ccc: number;
    readonly cgc: number;
    readonly lsp: number;
  };
}

/**
One thread of a session: the root turn and every subagent under it.
*/
export interface SessionThreadTrace {
  readonly id: string;
  readonly sessionId: string | null;
  readonly parentId: string | null;
  readonly nickname: string | null;
  readonly role: string | null;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly cliVersion: string | null;
  readonly clientSurface: ClientSurface | null;
  readonly cwd: string | null;
  readonly file: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly turns: readonly SessionThreadTurn[];
  readonly gaps: readonly SessionThreadGap[];
  /**
  Calls by tool; MCP tools are keyed `mcp__<server>__<tool>`.
  */
  readonly tools: Readonly<Record<string, number>>;
  readonly toolFailures: readonly SessionToolFailure[];
  readonly anomalies?: SessionThreadAnomalies;
  readonly efficiency?: SessionThreadEfficiency;
  readonly investigation: SessionInvestigation;
  readonly items?: readonly SessionThreadItem[];
}

/**
One router event row, as the router recorded it.
*/
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

/**
One request the router skipped, with the reason it gave.
*/
export interface SessionRouterSkippedEvent {
  readonly at: string;
  readonly requestId: string;
  readonly provider: string | null;
  readonly reason: string;
  readonly elapsedMs: number | null;
}

/**
One router request that failed.
*/
export interface SessionRouterFailure {
  readonly at: string;
  readonly requestId: string;
  readonly provider: string | null;
  readonly status: number | null;
  readonly failureClass: string | null;
  readonly spawnFailureReason?: string | null;
  readonly elapsedMs: number | null;
}

/**
One provider's share of a thread's requests.
*/
export interface SessionRouterProviderStats {
  readonly requests: number;
  readonly failures: number;
  readonly elapsedMs: number;
  readonly toolCalls: number;
}

/**
One thread's router requests, summarised.
*/
export interface SessionRouterSummary {
  readonly thread: string;
  readonly model: string | null;
  /**
  `thread`: every matched event names the thread. `model-window`: some are
  older events matched by model and time, so same-model threads interleave.
  */
  readonly matchedBy: "thread" | "model-window";
  readonly requests: number;
  readonly byProvider: Readonly<Record<string, SessionRouterProviderStats>>;
  readonly failures: readonly SessionRouterFailure[];
  /**
  Providers in request order, collapsed: a turn that hops shows more.
  */
  readonly providerSequence: readonly string[];
  /**
  Upstream models the router sent the thread's requests to, in request
  order and collapsed. These are provider model ids (`claude-opus-5-5`),
  not the AutoDev role alias Codex asked for (`autodev/orchestrator`).
  */
  readonly modelSequence: readonly string[];
  readonly skipped?: readonly SessionRouterSkippedEvent[];
  readonly retries?: number;
  readonly exhaustionWaits?: {
    readonly count: number;
    readonly totalMs: number;
  };
  readonly transportErrors?: number;
  readonly events?: readonly SessionRouterEventRow[];
}

/**
Matching lines from one bridge log.
*/
export interface SessionBridgeLogAlert {
  readonly file: string;
  readonly count: number;
  readonly samples: readonly string[];
}

/**
One log file the diagnostics read, with how fresh it is.
*/
export interface SessionLogFileSummary {
  readonly file: string;
  readonly modified: string;
  readonly bytes: number;
}

/**
What the live runtime looked like while the session ran.
*/
export interface SessionLiveReport {
  readonly router: {
    readonly reachable: boolean;
    readonly canonicalLiveCount: number | null;
    readonly byState: Readonly<Record<string, number>> | null;
    readonly liveByRole: Readonly<Record<string, number>> | null;
    readonly startedAt: string | null;
  };
  /**
  Recently written threads whose latest turn has not ended.
  */
  readonly openThreads: readonly {
    readonly id: string;
    readonly modified: string;
  }[];
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

/**
The persisted router state, read beside the live one.
*/
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
}

/**
One bounded page of a longer list.
*/
export interface SessionPagedSlice<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

/**
The session-wide rollups every surface shows first.
*/
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
  /**
  The largest thread initial developer prompt, in code points.
  */
  readonly maxInitialDeveloperChars: number;
  /**
  The largest counted thread prompt in tokens; null when none was counted.
  */
  readonly maxInitialDeveloperTokens: number | null;
  readonly maxSkillsCatalogBytes: number;
  readonly maxSkillsLoaded: number;
  readonly skillsByRoot: Readonly<Record<string, number>>;
  /**
  The number of keys of skillReadCounts.
  */
  readonly uniqueSkillsRead: number;
  /**
  SKILL.md reads per skill, summed over every thread of the session.
  */
  readonly skillReadCounts: Readonly<Record<string, number>>;
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

/**
Bounded lifecycle evidence; no claim of native transcript or token coverage.
*/
export interface NativeSessionEvidence {
  readonly startedAt: string | null;
  readonly lastObservedAt: string;
  readonly endedAt: string | null;
  readonly model: string | null;
  readonly workspace: string | null;
}

/**
One session's full diagnostics report.
*/
export interface SessionDiagnosticsReport {
  readonly schema: typeof SESSION_DIAGNOSTICS_SCHEMA;
  /**
  False when neither a rollout nor a native lifecycle observation matched.
  */
  readonly found: boolean;
  readonly requestedId: string;
  /**
  The session the id resolved to, when it resolved to one.
  */
  readonly rootSessionId: string | null;
  /**
  True when the id named a child thread rather than the session root.
  */
  readonly matchedByThreadId: boolean;
  /**
  The client surface observed on the session's root thread, if any.
  */
  readonly clientSurface: ClientSurface | null;
  readonly nativeSession?: NativeSessionEvidence;
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

/**
One session in the recent-sessions listing.
*/
export interface RecentSessionSummary {
  readonly id: string;
  readonly started: string;
  readonly lastWrite: string;
  readonly threads: number;
  readonly cwd: string | null;
  readonly clientSurface: ClientSurface | null;
}

/**
The recent-sessions listing.
*/
export interface SessionRecentListResponse {
  readonly schema: typeof SESSION_RECENT_LIST_SCHEMA;
  readonly limit: number;
  readonly sessions: readonly RecentSessionSummary[];
}

/**
One session's row in the fleet scan.
*/
export interface FleetSessionRow {
  readonly id: string;
  readonly started: string;
  readonly lastWrite: string;
  readonly cwd: string | null;
  readonly clientSurface: ClientSurface | null;
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

/**
The fleet-wide totals of the fleet scan.
*/
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

/**
The fleet scan across the newest sessions.
*/
export interface SessionFleetScanResponse {
  readonly schema: typeof SESSION_FLEET_SCAN_SCHEMA;
  readonly limit: number;
  /**
  Rollout-backed efficiency/failure rows only.
  */
  readonly sessions: readonly FleetSessionRow[];
  /**
  Unified bounded recent list when lifecycle-only native sessions are present.
  */
  readonly recentSessions?: readonly RecentSessionSummary[];
  /**
  Rollout-only totals; native metrics must not be fabricated as zero.
  */
  readonly totals: FleetScanTotals;
}

/**
The `PreToolUse` denials recorded in the hook log.
*/
export interface HookDenialSummary {
  readonly logFile: string;
  readonly sinceDays: number;
  readonly cutoff: string;
  readonly totalLines: number;
  readonly preToolUseDenials: number;
  readonly byPolicy: Readonly<Record<string, number>>;
  readonly byRole: Readonly<Record<string, number>>;
  readonly byReason: readonly {
    readonly reason: string;
    readonly count: number;
  }[];
  readonly topCommands: readonly {
    readonly commandHead: string;
    readonly policy: string;
    readonly count: number;
  }[];
}

/**
The hook-denial summary response.
*/
export interface SessionHookDenialsResponse {
  readonly schema: typeof SESSION_HOOK_DENIALS_SCHEMA;
  readonly summary: HookDenialSummary;
}

/**
The failure categories, in the order they are tried.

A failure is categorized by the first rule that matches, so the order is the
contract: a `SyntaxError` inside a JSON-wrapped argument is a
`json-wrap-syntax` failure, not a plain `syntax-error`.
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
The category a tool failure falls into.

A caller that already knows the category passes it through; a caller that
only has the excerpt derives it here, so the Console, the CLI and the fleet
scan agree on what "a hook block" is.
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

/*
------------------------------------------------------------------
*/
/*
Runtime validators.
*/
/*                                                                     */
/*
The Console reads these payloads over HTTP from a service it does
*/
/*
not control, so a malformed body must fail closed rather than be
*/
/*
rendered as though it were evidence.
*/
/*
------------------------------------------------------------------
*/

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

/**
A whole, non-negative measurement such as a character or token count.
*/
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isCount(value);
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

function isNullableClientSurface(
  value: unknown
): value is ClientSurface | null {
  return value === null || isClientSurface(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isSessionToolFailure(value: unknown): value is SessionToolFailure {
  if (!isRecord(value) || typeof value.at !== "string" ||
    typeof value.tool !== "string" ||
    typeof value.callId !== "string" ||
    typeof value.detail !== "string")
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
  if (!isRecord(value) || (typeof value.observed !== "boolean") || !isNullableString(value.firstEditAt) || !isNumber(value.toolCalls) || !isNullableNumber(value.tokens) || !isNumber(value.filesRead) ||
    !isNumber(value.repeatedReads) ||
    !isNumber(value.searches) ||
    !isNumber(value.repeatedSearches) || !isRecord(value.context)) return false;
  return (
    isNumber(value.context.ccc) &&
    isNumber(value.context.cgc) &&
    isNumber(value.context.lsp)
  );
}

function isListOf<T>(
  value: unknown,
  guard: (entry: unknown) => entry is T
): value is readonly T[] {
  return Array.isArray(value) && value.every((entry) => guard(entry));
}

/**
Whether an optional field is absent or passes its guard.
*/
function isAbsentOr(
  value: unknown,
  guard: (entry: unknown) => boolean
): boolean {
  return value === undefined || guard(value);
}

function isSessionThreadTokenUsage(
  value: unknown
): value is SessionThreadTokenUsage {
  if (!isRecord(value)) return false;
  return (
    typeof value.observed === "boolean" &&
    isNumber(value.samples) &&
    isNumber(value.inputTokens) &&
    isNumber(value.cachedInputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.reasoningOutputTokens) &&
    isNumber(value.totalTokens) &&
    isNullableNumber(value.cacheHitPct) &&
    isNullableNumber(value.reasoningPct) &&
    isNumber(value.peakInputTokens) &&
    isNumber(value.cacheDrops)
  );
}

function isSessionThreadCompactionSummary(
  value: unknown
): value is SessionThreadCompactionSummary {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.count) &&
    isNumber(value.contextCompactedEvents) &&
    isNumber(value.maxReplacementItems) &&
    isNumber(value.maxReplacementBytes) &&
    isNumber(value.maxReplacementImages) &&
    isNumber(value.responseImageItems)
  );
}

/**
Whether per-skill read counts are keyed by exactly the skills read.

Every key of the map names a skill in the list and every skill in the list
has a whole, positive count: a skill counted but not listed, or listed but
never counted, means the two fields came from different reads.
*/
function isSkillReadCounts(
  value: unknown,
  skillsRead: readonly string[]
): value is Record<string, number> {
  if (!isCountMap(value)) return false;
  const listed = new Set(skillsRead);
  if ((listed.size !== skillsRead.length) || (Object.keys(value).length !== listed.size)) return false;
  return skillsRead.every((skill) => {
    const count = value[skill];
    return count !== undefined && Number.isInteger(count) && count >= 1;
  });
}

function isSessionThreadPromptOverhead(
  value: unknown
): value is SessionThreadPromptOverhead {
  if (!isRecord(value) || !isStringList(value.skillsRead)) return false;
  return (
    isNumber(value.initialDeveloperBytes) &&
    isCount(value.initialDeveloperChars) &&
    isNullableCount(value.initialDeveloperTokens) &&
    isNumber(value.skillsCatalogBytes) &&
    isNumber(value.skillsLoaded) &&
    isCountMap(value.skillsByRoot) &&
    isSkillReadCounts(value.skillReadCounts, value.skillsRead) &&
    isNullableNumber(value.skillTelemetryReads)
  );
}

function isSessionThreadEfficiency(
  value: unknown
): value is SessionThreadEfficiency {
  if (!isRecord(value)) return false;
  return (
    isSessionThreadTokenUsage(value.tokens) &&
    isSessionThreadCompactionSummary(value.compaction) &&
    isSessionThreadPromptOverhead(value.prompt)
  );
}

function hasSessionThreadIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    isNullableString(value.sessionId) &&
    isNullableString(value.parentId) &&
    isNullableString(value.nickname) &&
    isNullableString(value.role) &&
    isNullableString(value.model) &&
    isNullableString(value.modelProvider) &&
    isNullableString(value.cliVersion) &&
    isNullableClientSurface(value.clientSurface) &&
    isNullableString(value.cwd) &&
    typeof value.file === "string" &&
    isNullableString(value.start) &&
    isNullableString(value.end)
  );
}

function isSessionThreadAnomalies(
  value: unknown
): value is SessionThreadAnomalies {
  if (!isRecord(value)) return false;
  return isNumber(value.tagOnlyMessages) && isStringList(value.samples);
}

function isSessionThreadItem(value: unknown): value is SessionThreadItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.at === "string" &&
    typeof value.kind === "string" &&
    typeof value.detail === "string" &&
    typeof value.threadId === "string"
  );
}

function isSessionThreadTrace(value: unknown): value is SessionThreadTrace {
  if (!isRecord(value) || !hasSessionThreadIdentity(value)) return false;
  return (
    isCountMap(value.counts) &&
    isCountMap(value.tools) &&
    isListOf(value.turns, isSessionThreadTurn) &&
    isListOf(value.gaps, isSessionThreadGap) &&
    isListOf(value.toolFailures, isSessionToolFailure) &&
    isSessionInvestigation(value.investigation) &&
    isAbsentOr(value.efficiency, isSessionThreadEfficiency) &&
    isAbsentOr(value.anomalies, isSessionThreadAnomalies) &&
    isAbsentOr(value.items, (items) => isListOf(items, isSessionThreadItem))
  );
}

function isSessionRouterEventRow(
  value: unknown
): value is SessionRouterEventRow {
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

function isProviderStatsMap(
  value: unknown
): value is Record<string, SessionRouterProviderStats> {
  return (
    isRecord(value) &&
    Object.values(value).every((stats) => isSessionRouterProviderStats(stats))
  );
}

function isSessionRouterFailure(value: unknown): value is SessionRouterFailure {
  if (!isRecord(value)) return false;
  return (
    typeof value.at === "string" &&
    typeof value.requestId === "string" &&
    isNullableString(value.provider) &&
    isNullableNumber(value.status) &&
    isNullableString(value.failureClass) &&
    isNullableNumber(value.elapsedMs)
  );
}

function isSessionRouterSkippedEvent(
  value: unknown
): value is SessionRouterSkippedEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.at === "string" &&
    typeof value.requestId === "string" &&
    isNullableString(value.provider) &&
    typeof value.reason === "string" &&
    isNullableNumber(value.elapsedMs)
  );
}

function isExhaustionWaits(value: unknown): boolean {
  return isRecord(value) && isNumber(value.count) && isNumber(value.totalMs);
}

function isSessionRouterSummary(value: unknown): value is SessionRouterSummary {
  if (!isRecord(value)) return false;
  if (value.matchedBy !== "thread" && value.matchedBy !== "model-window")
    return false;
  return (
    typeof value.thread === "string" &&
    isNullableString(value.model) &&
    isNumber(value.requests) &&
    isProviderStatsMap(value.byProvider) &&
    isListOf(value.failures, isSessionRouterFailure) &&
    isStringList(value.providerSequence) &&
    isStringList(value.modelSequence) &&
    isAbsentOr(value.skipped, (skipped) =>
      isListOf(skipped, isSessionRouterSkippedEvent)
    ) &&
    isAbsentOr(value.retries, isNumber) &&
    isAbsentOr(value.exhaustionWaits, isExhaustionWaits) &&
    isAbsentOr(value.transportErrors, isNumber) &&
    isAbsentOr(value.events, (events) =>
      isListOf(events, isSessionRouterEventRow)
    )
  );
}

function isLiveRouterState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.reachable === "boolean" &&
    isNullableNumber(value.canonicalLiveCount) &&
    isNullableCountMap(value.byState) &&
    isNullableCountMap(value.liveByRole) &&
    isNullableString(value.startedAt)
  );
}

function isLiveOpenThread(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.modified === "string"
  );
}

function isLiveService(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.pid === "string" &&
    typeof value.started === "string" &&
    typeof value.script === "string"
  );
}

function isDeploymentDrift(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.checked) &&
    isStringList(value.differing) &&
    isStringList(value.missing)
  );
}

function isEveryEntry(
  value: unknown,
  guard: (entry: unknown) => boolean
): boolean {
  return Array.isArray(value) && value.every((entry) => guard(entry));
}

function isSessionLiveReport(value: unknown): value is SessionLiveReport {
  if (!isRecord(value)) return false;
  return (
    isLiveRouterState(value.router) &&
    isEveryEntry(value.openThreads, isLiveOpenThread) &&
    isStringList(value.processes) &&
    isEveryEntry(value.services, isLiveService) &&
    (value.drift === null || isDeploymentDrift(value.drift))
  );
}

function isProviderLastFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === "string" &&
    isNullableString(value.status) &&
    isNullableString(value.cooldownKind) &&
    isNullableString(value.lastFailureClass) &&
    isNullableNumber(value.lastFailureStatus)
  );
}

function isSessionEfficiencySummary(
  value: unknown
): value is SessionEfficiencySummary {
  if (!isRecord(value)) return false;
  return (
    isStringList(value.disabledProviders) &&
    isStringList(value.nullRoleModels) &&
    isAbsentOr(value.providerLastFailures, (failures) =>
      isEveryEntry(failures, isProviderLastFailure)
    )
  );
}

function isSessionPagedSlice(
  value: unknown
): value is SessionPagedSlice<unknown> {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.items) &&
    isNumber(value.total) &&
    isNumber(value.limit) &&
    isNumber(value.offset) &&
    typeof value.hasMore === "boolean"
  );
}

const AGGREGATE_NUMERIC_KEYS: readonly string[] = [
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
  "maxInitialDeveloperChars",
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

const AGGREGATE_NULLABLE_NUMERIC_KEYS: readonly string[] = [
  "cacheHitPct",
  "reasoningPct",
  "maxInitialDeveloperTokens",
  "skillTelemetryReads"
];

const AGGREGATE_COUNT_MAP_KEYS: readonly string[] = [
  "skillsByRoot",
  "skillReadCounts",
  "turnsByOutcome",
  "toolCallsByName",
  "toolFailuresByCategory",
  "routerSkippedByReason"
];

function isSessionDiagnosticsAggregates(
  value: unknown
): value is SessionDiagnosticsAggregates {
  if (!isRecord(value) || AGGREGATE_NUMERIC_KEYS.some((key) => !isNumber(value[key])) || AGGREGATE_NULLABLE_NUMERIC_KEYS.some((key) =>
      !isNullableNumber(value[key])
    ) || AGGREGATE_COUNT_MAP_KEYS.some((key) => !isCountMap(value[key])))
    return false;
  // uniqueSkillsRead counts the keys of skillReadCounts; disagreement means
  // the two rollups were built from different reads.
  if (
    Object.keys(value.skillReadCounts as Record<string, number>).length !==
    value.uniqueSkillsRead
  )
    return false;
  return isProviderStatsMap(value.byProvider);
}

function isSessionLogFileSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.modified === "string" &&
    isNumber(value.bytes)
  );
}

function isSessionBridgeLogAlert(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    isNumber(value.count) &&
    isStringList(value.samples)
  );
}

function hasSessionReportIdentity(value: Record<string, unknown>): boolean {
  return (
    value.schema === SESSION_DIAGNOSTICS_SCHEMA &&
    typeof value.found === "boolean" &&
    typeof value.requestedId === "string" &&
    isNullableString(value.rootSessionId) &&
    typeof value.matchedByThreadId === "boolean" &&
    isNullableClientSurface(value.clientSurface) &&
    (value.nativeSession === undefined ||
      (isRecord(value.nativeSession) &&
        isNullableString(value.nativeSession.startedAt) &&
        typeof value.nativeSession.lastObservedAt === "string" &&
        isNullableString(value.nativeSession.endedAt) &&
        isNullableString(value.nativeSession.model) &&
        isNullableString(value.nativeSession.workspace)))
  );
}

/**
Whether a payload is a usable session diagnostics report.
*/
export function isSessionDiagnosticsReport(
  value: unknown
): value is SessionDiagnosticsReport {
  if (!isRecord(value) || !hasSessionReportIdentity(value)) return false;
  return (
    isListOf(value.threads, isSessionThreadTrace) &&
    isListOf(value.router, isSessionRouterSummary) &&
    isEveryEntry(value.logs, isSessionLogFileSummary) &&
    isEveryEntry(value.bridgeAlerts, isSessionBridgeLogAlert) &&
    (value.live === null || isSessionLiveReport(value.live)) &&
    (value.efficiency === null ||
      isSessionEfficiencySummary(value.efficiency)) &&
    isSessionDiagnosticsAggregates(value.aggregates) &&
    isSessionPagedSlice(value.eventsPage) &&
    isSessionPagedSlice(value.itemsPage)
  );
}

function isRecentSessionSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.started === "string" &&
    typeof value.lastWrite === "string" &&
    isNumber(value.threads) &&
    isNullableString(value.cwd) &&
    isNullableClientSurface(value.clientSurface)
  );
}

/**
Whether a payload is a usable recent-sessions listing.
*/
export function isSessionRecentListResponse(
  value: unknown
): value is SessionRecentListResponse {
  if (!isRecord(value)) return false;
  return (
    value.schema === SESSION_RECENT_LIST_SCHEMA &&
    isNumber(value.limit) &&
    isEveryEntry(value.sessions, isRecentSessionSummary)
  );
}

function hasFleetSessionTokenFields(value: Record<string, unknown>): boolean {
  return (
    isNumber(value.threads) &&
    isNumber(value.totalTokens) &&
    isNumber(value.inputTokens) &&
    isNumber(value.cachedInputTokens) &&
    isNullableNumber(value.cacheHitPct) &&
    isNumber(value.cacheDrops) &&
    isNumber(value.compactions) &&
    isNumber(value.maxSkillsLoaded)
  );
}

function isFleetSessionRow(value: unknown): boolean {
  if (!isRecord(value) || !hasFleetSessionTokenFields(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.started === "string" &&
    typeof value.lastWrite === "string" &&
    isNullableString(value.cwd) &&
    isNullableClientSurface(value.clientSurface) &&
    isNumber(value.toolFailures) &&
    isNumber(value.preToolUseBlocks) &&
    (value.topFailureCategory === null ||
      isToolFailureCategory(value.topFailureCategory)) &&
    isNumber(value.routerRequests) &&
    isNumber(value.routerFailures) &&
    isCountMap(value.routerSkipped) &&
    isCountMap(value.providers)
  );
}

function isReasonCount(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.reason === "string" && isNumber(value.count)
  );
}

function isKeyCount(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.key === "string" && isNumber(value.count)
  );
}

function isFleetScanTotals(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNumber(value.sessions) &&
    isNumber(value.threads) &&
    isNumber(value.totalTokens) &&
    isNumber(value.inputTokens) &&
    isNumber(value.cachedInputTokens) &&
    isNullableNumber(value.cacheHitPct) &&
    isNumber(value.cacheDrops) &&
    isNumber(value.compactions) &&
    isCountMap(value.toolFailuresByCategory) &&
    isEveryEntry(value.preToolUseReasons, isReasonCount) &&
    isEveryEntry(value.routerSkippedByReason, isKeyCount)
  );
}

/**
Whether a payload is a usable fleet scan.
*/
export function isSessionFleetScanResponse(
  value: unknown
): value is SessionFleetScanResponse {
  if (!isRecord(value)) return false;
  return (
    value.schema === SESSION_FLEET_SCAN_SCHEMA &&
    isNumber(value.limit) &&
    isEveryEntry(value.sessions, isFleetSessionRow) &&
    (value.recentSessions === undefined ||
      isEveryEntry(value.recentSessions, isRecentSessionSummary)) &&
    isFleetScanTotals(value.totals)
  );
}

/**
Whether a payload is a usable hook-denial summary.
*/
export function isSessionHookDenialsResponse(
  value: unknown
): value is SessionHookDenialsResponse {
  if (!isRecord(value) || (value.schema !== SESSION_HOOK_DENIALS_SCHEMA) || !isRecord(value.summary)) return false;
  const { summary } = value;
  if (typeof summary.logFile !== "string" ||
    !isNumber(summary.sinceDays) ||
    typeof summary.cutoff !== "string" ||
    !isNumber(summary.totalLines) ||
    !isNumber(summary.preToolUseDenials) || !isCountMap(summary.byPolicy) || !isCountMap(summary.byRole) || !isEveryEntry(summary.byReason, isReasonCount) || !Array.isArray(summary.topCommands)) return false;
  for (const entry of summary.topCommands) {
    if (!isRecord(entry) || typeof entry.commandHead !== "string" ||
      typeof entry.policy !== "string" ||
      !isNumber(entry.count))
      return false;
  }
  return true;
}

/**
Whether a payload is a plain map of strings, used by the Console's checks.
*/
export function isStringRecord(
  value: unknown
): value is Record<string, string> {
  return isStringMap(value);
}
