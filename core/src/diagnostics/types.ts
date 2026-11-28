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

import { z } from "zod";

import { type AcpPinRecord, acpPinRecordSchema } from "./acp-pins.ts";
import { CLIENT_SURFACES, type ClientSurface } from "./client-surface.ts";

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
  `acp-pin`: attributed by an authoritative Runtime/ACP session pin.
  `thread`: every matched router event names the thread. `model-window`: some are
  older events matched by model and time, so same-model threads interleave.
  */
  readonly matchedBy: "acp-pin" | "thread" | "model-window";
  readonly pinSessionId?: string;
  readonly pinRole?: string;
  readonly pinTransport?: "acp" | "opencli";
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
  readonly acpPins?: readonly AcpPinRecord[];
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
Runtime Zod schemas and response guards.

The Console reads these payloads over HTTP from a service it does
not control, so a malformed body must fail closed rather than be
rendered as though it were evidence.
------------------------------------------------------------------
*/

const finiteNumberSchema = z.number().finite();
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();
const countSchema = z
  .number()
  .int()
  .min(0)
  .refine((value) => Number.isSafeInteger(value));
const nullableCountSchema = countSchema.nullable();
const nullableStringSchema = z.string().nullable();
const countMapSchema = z.record(z.string(), finiteNumberSchema);
const nullableCountMapSchema = countMapSchema.nullable();
const stringListSchema = z.array(z.string());
export const stringRecordSchema = z.record(z.string(), z.string());
const nullableClientSurfaceSchema = z.enum(CLIENT_SURFACES).nullable();
const toolFailureCategorySchema = z.enum(TOOL_FAILURE_CATEGORIES);

const sessionToolFailureSchema = z.object({
  at: z.string(),
  tool: z.string(),
  callId: z.string(),
  detail: z.string(),
  category: toolFailureCategorySchema.optional(),
  input: z.string().optional()
});

const sessionThreadTurnSchema = z.object({
  turnId: z.string(),
  started: nullableStringSchema,
  ended: nullableStringSchema,
  outcome: z.string(),
  detail: nullableStringSchema
});

const sessionThreadGapSchema = z.object({
  seconds: finiteNumberSchema,
  after: z.string(),
  before: z.string(),
  at: z.string()
});

const sessionInvestigationSchema = z.object({
  observed: z.boolean(),
  firstEditAt: nullableStringSchema,
  toolCalls: finiteNumberSchema,
  tokens: nullableFiniteNumberSchema,
  filesRead: finiteNumberSchema,
  repeatedReads: finiteNumberSchema,
  searches: finiteNumberSchema,
  repeatedSearches: finiteNumberSchema,
  context: z.object({
    ccc: finiteNumberSchema,
    cgc: finiteNumberSchema,
    lsp: finiteNumberSchema
  })
});

const sessionThreadTokenUsageSchema = z.object({
  observed: z.boolean(),
  samples: finiteNumberSchema,
  inputTokens: finiteNumberSchema,
  cachedInputTokens: finiteNumberSchema,
  outputTokens: finiteNumberSchema,
  reasoningOutputTokens: finiteNumberSchema,
  totalTokens: finiteNumberSchema,
  cacheHitPct: nullableFiniteNumberSchema,
  reasoningPct: nullableFiniteNumberSchema,
  peakInputTokens: finiteNumberSchema,
  cacheDrops: finiteNumberSchema
});

const sessionThreadCompactionSummarySchema = z.object({
  count: finiteNumberSchema,
  contextCompactedEvents: finiteNumberSchema,
  maxReplacementItems: finiteNumberSchema,
  maxReplacementBytes: finiteNumberSchema,
  maxReplacementImages: finiteNumberSchema,
  responseImageItems: finiteNumberSchema
});

function validateSkillReadCounts(
  prompt: {
    readonly skillsRead: readonly string[];
    readonly skillReadCounts: Readonly<Record<string, number>>;
  },
  context: z.RefinementCtx
): void {
  const listed = new Set(prompt.skillsRead);
  const keys = Object.keys(prompt.skillReadCounts);
  if (listed.size !== prompt.skillsRead.length || keys.length !== listed.size) {
    context.addIssue({
      code: "custom",
      message: "skillReadCounts must match skillsRead exactly"
    });
    return;
  }
  for (const skill of prompt.skillsRead) {
    const count = prompt.skillReadCounts[skill];
    if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
      context.addIssue({
        code: "custom",
        message: `skillReadCounts entry '${skill}' must be an integer >= 1`
      });
    }
  }
}

const sessionThreadPromptOverheadSchema = z
  .object({
    initialDeveloperBytes: finiteNumberSchema,
    initialDeveloperChars: countSchema,
    initialDeveloperTokens: nullableCountSchema,
    skillsCatalogBytes: finiteNumberSchema,
    skillsLoaded: finiteNumberSchema,
    skillsByRoot: countMapSchema,
    skillsRead: stringListSchema,
    skillReadCounts: countMapSchema,
    skillTelemetryReads: nullableFiniteNumberSchema
  })
  .superRefine(validateSkillReadCounts);

const sessionThreadEfficiencySchema = z.object({
  tokens: sessionThreadTokenUsageSchema,
  compaction: sessionThreadCompactionSummarySchema,
  prompt: sessionThreadPromptOverheadSchema
});

const sessionThreadAnomaliesSchema = z.object({
  tagOnlyMessages: finiteNumberSchema,
  samples: stringListSchema
});

const sessionThreadItemSchema = z.object({
  at: z.string(),
  kind: z.string(),
  detail: z.string(),
  threadId: z.string()
});

const sessionThreadTraceSchema = z.object({
  id: z.string(),
  sessionId: nullableStringSchema,
  parentId: nullableStringSchema,
  nickname: nullableStringSchema,
  role: nullableStringSchema,
  model: nullableStringSchema,
  modelProvider: nullableStringSchema,
  cliVersion: nullableStringSchema,
  clientSurface: nullableClientSurfaceSchema,
  cwd: nullableStringSchema,
  file: z.string(),
  start: nullableStringSchema,
  end: nullableStringSchema,
  counts: countMapSchema,
  turns: z.array(sessionThreadTurnSchema),
  gaps: z.array(sessionThreadGapSchema),
  tools: countMapSchema,
  toolFailures: z.array(sessionToolFailureSchema),
  anomalies: sessionThreadAnomaliesSchema.optional(),
  efficiency: sessionThreadEfficiencySchema.optional(),
  investigation: sessionInvestigationSchema,
  items: z.array(sessionThreadItemSchema).optional()
});

const sessionRouterEventRowSchema = z.object({
  at: z.string(),
  requestId: z.string(),
  thread: nullableStringSchema,
  phase: z.string(),
  role: nullableStringSchema,
  requestedModel: nullableStringSchema,
  provider: nullableStringSchema,
  model: nullableStringSchema,
  outcome: nullableStringSchema,
  status: nullableFiniteNumberSchema,
  failureClass: nullableStringSchema,
  reason: nullableStringSchema.optional(),
  spawnFailureReason: nullableStringSchema,
  denialReason: nullableStringSchema,
  elapsedMs: nullableFiniteNumberSchema,
  toolCalls: nullableFiniteNumberSchema,
  selection: nullableStringSchema,
  errorName: nullableStringSchema.optional(),
  errorCode: nullableStringSchema.optional()
});

const sessionRouterProviderStatsSchema = z.object({
  requests: finiteNumberSchema,
  failures: finiteNumberSchema,
  elapsedMs: finiteNumberSchema,
  toolCalls: finiteNumberSchema
});

const providerStatsMapSchema = z.record(
  z.string(),
  sessionRouterProviderStatsSchema
);

const sessionRouterFailureSchema = z.object({
  at: z.string(),
  requestId: z.string(),
  provider: nullableStringSchema,
  status: nullableFiniteNumberSchema,
  failureClass: nullableStringSchema,
  spawnFailureReason: nullableStringSchema.optional(),
  elapsedMs: nullableFiniteNumberSchema
});

const sessionRouterSkippedEventSchema = z.object({
  at: z.string(),
  requestId: z.string(),
  provider: nullableStringSchema,
  reason: z.string(),
  elapsedMs: nullableFiniteNumberSchema
});

const sessionRouterSummarySchema = z.object({
  thread: z.string(),
  model: nullableStringSchema,
  matchedBy: z.enum(["acp-pin", "thread", "model-window"]),
  pinSessionId: z.string().optional(),
  pinRole: z.string().optional(),
  pinTransport: z.enum(["acp", "opencli"]).optional(),
  requests: finiteNumberSchema,
  byProvider: providerStatsMapSchema,
  failures: z.array(sessionRouterFailureSchema),
  providerSequence: stringListSchema,
  modelSequence: stringListSchema,
  skipped: z.array(sessionRouterSkippedEventSchema).optional(),
  retries: finiteNumberSchema.optional(),
  exhaustionWaits: z
    .object({
      count: finiteNumberSchema,
      totalMs: finiteNumberSchema
    })
    .optional(),
  transportErrors: finiteNumberSchema.optional(),
  events: z.array(sessionRouterEventRowSchema).optional()
});

const liveRouterSchema = z.object({
  reachable: z.boolean(),
  canonicalLiveCount: nullableFiniteNumberSchema,
  byState: nullableCountMapSchema,
  liveByRole: nullableCountMapSchema,
  startedAt: nullableStringSchema
});

const liveOpenThreadSchema = z.object({
  id: z.string(),
  modified: z.string()
});

const liveServiceSchema = z.object({
  pid: z.string(),
  started: z.string(),
  script: z.string()
});

const liveDriftSchema = z.object({
  checked: finiteNumberSchema,
  differing: stringListSchema,
  missing: stringListSchema
});

const sessionLiveReportSchema = z.object({
  router: liveRouterSchema,
  openThreads: z.array(liveOpenThreadSchema),
  processes: stringListSchema,
  services: z.array(liveServiceSchema),
  drift: liveDriftSchema.nullable()
});

const providerLastFailureSchema = z.object({
  provider: z.string(),
  status: nullableStringSchema,
  cooldownKind: nullableStringSchema,
  lastFailureClass: nullableStringSchema,
  lastFailureStatus: nullableFiniteNumberSchema
});

const sessionEfficiencySummarySchema = z.object({
  disabledProviders: stringListSchema,
  nullRoleModels: stringListSchema,
  providerLastFailures: z.array(providerLastFailureSchema).optional()
});

function sessionPagedSliceSchema<Item extends z.ZodTypeAny>(itemSchema: Item) {
  return z.object({
    items: z.array(itemSchema),
    total: finiteNumberSchema,
    limit: finiteNumberSchema,
    offset: finiteNumberSchema,
    hasMore: z.boolean()
  });
}

const sessionDiagnosticsAggregatesSchema = z
  .object({
    threadCount: finiteNumberSchema,
    totalTokens: finiteNumberSchema,
    inputTokens: finiteNumberSchema,
    cachedInputTokens: finiteNumberSchema,
    outputTokens: finiteNumberSchema,
    reasoningOutputTokens: finiteNumberSchema,
    cacheHitPct: nullableFiniteNumberSchema,
    reasoningPct: nullableFiniteNumberSchema,
    peakInputTokens: finiteNumberSchema,
    cacheDrops: finiteNumberSchema,
    compactions: finiteNumberSchema,
    contextCompactedEvents: finiteNumberSchema,
    maxReplacementItems: finiteNumberSchema,
    maxReplacementBytes: finiteNumberSchema,
    maxReplacementImages: finiteNumberSchema,
    responseImageItems: finiteNumberSchema,
    maxInitialDeveloperBytes: finiteNumberSchema,
    maxInitialDeveloperChars: finiteNumberSchema,
    maxInitialDeveloperTokens: nullableFiniteNumberSchema,
    maxSkillsCatalogBytes: finiteNumberSchema,
    maxSkillsLoaded: finiteNumberSchema,
    skillsByRoot: countMapSchema,
    uniqueSkillsRead: finiteNumberSchema,
    skillReadCounts: countMapSchema,
    skillTelemetryReads: nullableFiniteNumberSchema,
    turnsTotal: finiteNumberSchema,
    turnsByOutcome: countMapSchema,
    gapsCount: finiteNumberSchema,
    toolCallsTotal: finiteNumberSchema,
    toolCallsByName: countMapSchema,
    toolFailuresTotal: finiteNumberSchema,
    toolFailuresByCategory: countMapSchema,
    preToolUseBlocks: finiteNumberSchema,
    routerRequests: finiteNumberSchema,
    routerFailures: finiteNumberSchema,
    routerSkippedTotal: finiteNumberSchema,
    routerSkippedByReason: countMapSchema,
    routerRetries: finiteNumberSchema,
    exhaustionWaits: finiteNumberSchema,
    transportErrors: finiteNumberSchema,
    providerHops: finiteNumberSchema,
    byProvider: providerStatsMapSchema
  })
  .superRefine((aggregates, context) => {
    if (
      Object.keys(aggregates.skillReadCounts).length !==
      aggregates.uniqueSkillsRead
    ) {
      context.addIssue({
        code: "custom",
        message:
          "uniqueSkillsRead must equal the number of keys in skillReadCounts"
      });
    }
  });

const sessionLogFileSummarySchema = z.object({
  file: z.string(),
  modified: z.string(),
  bytes: finiteNumberSchema
});

const sessionBridgeLogAlertSchema = z.object({
  file: z.string(),
  count: finiteNumberSchema,
  samples: stringListSchema
});

const nativeSessionEvidenceSchema = z.object({
  startedAt: nullableStringSchema,
  lastObservedAt: z.string(),
  endedAt: nullableStringSchema,
  model: nullableStringSchema,
  workspace: nullableStringSchema
});

/**
Zod schema for one session's full diagnostics report.
*/
export const sessionDiagnosticsReportSchema = z.object({
  schema: z.literal(SESSION_DIAGNOSTICS_SCHEMA),
  found: z.boolean(),
  requestedId: z.string(),
  rootSessionId: nullableStringSchema,
  matchedByThreadId: z.boolean(),
  clientSurface: nullableClientSurfaceSchema,
  nativeSession: nativeSessionEvidenceSchema.optional(),
  acpPins: z.array(acpPinRecordSchema).optional(),
  threads: z.array(sessionThreadTraceSchema),
  router: z.array(sessionRouterSummarySchema),
  logs: z.array(sessionLogFileSummarySchema),
  bridgeAlerts: z.array(sessionBridgeLogAlertSchema),
  live: sessionLiveReportSchema.nullable(),
  efficiency: sessionEfficiencySummarySchema.nullable(),
  aggregates: sessionDiagnosticsAggregatesSchema,
  eventsPage: sessionPagedSliceSchema(sessionRouterEventRowSchema),
  itemsPage: sessionPagedSliceSchema(sessionThreadItemSchema)
});

/**
Whether a payload is a usable session diagnostics report.
*/
export function isSessionDiagnosticsReport(
  value: unknown
): value is SessionDiagnosticsReport {
  return sessionDiagnosticsReportSchema.safeParse(value).success;
}

const recentSessionSummarySchema = z.object({
  id: z.string(),
  started: z.string(),
  lastWrite: z.string(),
  threads: finiteNumberSchema,
  cwd: nullableStringSchema,
  clientSurface: nullableClientSurfaceSchema
});

/**
Zod schema for the recent-sessions listing.
*/
export const sessionRecentListResponseSchema = z.object({
  schema: z.literal(SESSION_RECENT_LIST_SCHEMA),
  limit: finiteNumberSchema,
  sessions: z.array(recentSessionSummarySchema)
});

/**
Whether a payload is a usable recent-sessions listing.
*/
export function isSessionRecentListResponse(
  value: unknown
): value is SessionRecentListResponse {
  return sessionRecentListResponseSchema.safeParse(value).success;
}

const reasonCountSchema = z.object({
  reason: z.string(),
  count: finiteNumberSchema
});

const keyCountSchema = z.object({
  key: z.string(),
  count: finiteNumberSchema
});

const fleetSessionRowSchema = z.object({
  id: z.string(),
  started: z.string(),
  lastWrite: z.string(),
  cwd: nullableStringSchema,
  clientSurface: nullableClientSurfaceSchema,
  threads: finiteNumberSchema,
  totalTokens: finiteNumberSchema,
  inputTokens: finiteNumberSchema,
  cachedInputTokens: finiteNumberSchema,
  cacheHitPct: nullableFiniteNumberSchema,
  cacheDrops: finiteNumberSchema,
  compactions: finiteNumberSchema,
  maxSkillsLoaded: finiteNumberSchema,
  toolFailures: finiteNumberSchema,
  preToolUseBlocks: finiteNumberSchema,
  topFailureCategory: toolFailureCategorySchema.nullable(),
  routerRequests: finiteNumberSchema,
  routerFailures: finiteNumberSchema,
  routerSkipped: countMapSchema,
  providers: countMapSchema
});

const fleetScanTotalsSchema = z.object({
  sessions: finiteNumberSchema,
  threads: finiteNumberSchema,
  totalTokens: finiteNumberSchema,
  inputTokens: finiteNumberSchema,
  cachedInputTokens: finiteNumberSchema,
  cacheHitPct: nullableFiniteNumberSchema,
  cacheDrops: finiteNumberSchema,
  compactions: finiteNumberSchema,
  toolFailuresByCategory: countMapSchema,
  preToolUseReasons: z.array(reasonCountSchema),
  routerSkippedByReason: z.array(keyCountSchema)
});

/**
Zod schema for the cross-session fleet scan.
*/
export const sessionFleetScanResponseSchema = z.object({
  schema: z.literal(SESSION_FLEET_SCAN_SCHEMA),
  limit: finiteNumberSchema,
  sessions: z.array(fleetSessionRowSchema),
  recentSessions: z.array(recentSessionSummarySchema).optional(),
  totals: fleetScanTotalsSchema
});

/**
Whether a payload is a usable fleet scan.
*/
export function isSessionFleetScanResponse(
  value: unknown
): value is SessionFleetScanResponse {
  return sessionFleetScanResponseSchema.safeParse(value).success;
}

const topCommandSchema = z.object({
  commandHead: z.string(),
  policy: z.string(),
  count: finiteNumberSchema
});

const hookDenialsSummarySchema = z.object({
  logFile: z.string(),
  sinceDays: finiteNumberSchema,
  cutoff: z.string(),
  totalLines: finiteNumberSchema,
  preToolUseDenials: finiteNumberSchema,
  byPolicy: countMapSchema,
  byRole: countMapSchema,
  byReason: z.array(reasonCountSchema),
  topCommands: z.array(topCommandSchema)
});

/**
Zod schema for the hook-denial summary response.
*/
export const sessionHookDenialsResponseSchema = z.object({
  schema: z.literal(SESSION_HOOK_DENIALS_SCHEMA),
  summary: hookDenialsSummarySchema
});

/**
Whether a payload is a usable hook-denial summary.
*/
export function isSessionHookDenialsResponse(
  value: unknown
): value is SessionHookDenialsResponse {
  return sessionHookDenialsResponseSchema.safeParse(value).success;
}

/**
Whether a payload is a plain map of strings, used by the Console's checks.
*/
export function isStringRecord(
  value: unknown
): value is Record<string, string> {
  return stringRecordSchema.safeParse(value).success;
}
