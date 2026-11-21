/**
 * The session report composer.
 *
 * This is where the pieces of one session's evidence are joined: the rollouts
 * of every thread, the router's events for those threads, the bridge logs, the
 * live runtime state, and the persisted router state. The result is the single
 * report the Console, the CLI and the skill wrapper all read.
 */

import {
  classifyToolFailure,
  SESSION_DIAGNOSTICS_SCHEMA,
  type SessionDiagnosticsAggregates,
  type SessionDiagnosticsReport,
  type SessionPagedSlice,
  type SessionRouterEventRow,
  type SessionRouterProviderStats,
  type SessionRouterSummary,
  type SessionThreadEfficiency,
  type SessionThreadItem,
  type SessionThreadPromptOverhead,
  type SessionThreadTrace
} from "@simulatorlife/autodev-core";

import {
  buildEfficiencySummary,
  collectLiveDiagnostics,
  readBridgeLogAlerts,
  readLogSummaries
} from "./live-context.ts";
import { findSessionRollouts, rolloutRoots } from "./rollout-discovery.ts";
import {
  readRouterEvents,
  routerEventsForThread,
  shift,
  summarizeRouter
} from "./router-events.ts";
import { traceThread } from "./thread-tracer.ts";

const COLLATOR = new Intl.Collator();

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function addCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type ThreadActivityTotals = Pick<
  SessionDiagnosticsAggregates,
  | "turnsTotal"
  | "turnsByOutcome"
  | "gapsCount"
  | "toolCallsTotal"
  | "toolCallsByName"
  | "toolFailuresTotal"
  | "toolFailuresByCategory"
  | "preToolUseBlocks"
>;

type TokenAndCompactionTotals = Pick<
  SessionDiagnosticsAggregates,
  | "totalTokens"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "peakInputTokens"
  | "cacheDrops"
  | "compactions"
  | "contextCompactedEvents"
  | "maxReplacementItems"
  | "maxReplacementBytes"
  | "maxReplacementImages"
  | "responseImageItems"
>;

type PromptTotals = Pick<
  SessionDiagnosticsAggregates,
  | "maxInitialDeveloperBytes"
  | "maxInitialDeveloperChars"
  | "maxInitialDeveloperTokens"
  | "maxSkillsCatalogBytes"
  | "maxSkillsLoaded"
  | "skillsByRoot"
  | "uniqueSkillsRead"
  | "skillReadCounts"
  | "skillTelemetryReads"
>;

type RouterTotals = Pick<
  SessionDiagnosticsAggregates,
  | "routerRequests"
  | "routerFailures"
  | "routerSkippedTotal"
  | "routerSkippedByReason"
  | "routerRetries"
  | "exhaustionWaits"
  | "transportErrors"
  | "providerHops"
  | "byProvider"
>;

/** Add every count of `source` into `target`. */
function addCounts(
  target: Record<string, number>,
  source: Readonly<Record<string, number>>
): void {
  for (const [key, count] of Object.entries(source))
    target[key] = (target[key] ?? 0) + count;
}

/** The larger of two optional measurements; null only when both are absent. */
function maxOrNull(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return current === null ? next : Math.max(current, next);
}

/** The sum of two optional counts; null only when both are absent. */
function sumOrNull(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return (current ?? 0) + next;
}

/** Turns, gaps, tool calls and tool failures across every thread. */
function threadActivityTotals(
  threads: readonly SessionThreadTrace[]
): ThreadActivityTotals {
  const totals: Mutable<ThreadActivityTotals> = {
    turnsTotal: 0,
    turnsByOutcome: {},
    gapsCount: 0,
    toolCallsTotal: 0,
    toolCallsByName: {},
    toolFailuresTotal: 0,
    toolFailuresByCategory: {},
    preToolUseBlocks: 0
  };
  const turnsByOutcome: Record<string, number> = {};
  const toolCallsByName: Record<string, number> = {};
  const toolFailuresByCategory: Record<string, number> = {};
  for (const thread of threads) {
    totals.turnsTotal += thread.turns.length;
    totals.gapsCount += thread.gaps.length;
    for (const turn of thread.turns) addCount(turnsByOutcome, turn.outcome);
    addCounts(toolCallsByName, thread.tools);
    for (const count of Object.values(thread.tools))
      totals.toolCallsTotal += count;
    for (const failure of thread.toolFailures) {
      const category =
        failure.category ?? classifyToolFailure(failure.detail, failure.input);
      addCount(toolFailuresByCategory, category);
      totals.toolFailuresTotal += 1;
      if (category === "pretooluse-hook") totals.preToolUseBlocks += 1;
    }
  }
  return { ...totals, turnsByOutcome, toolCallsByName, toolFailuresByCategory };
}

/** Token usage and compaction across every measured thread. */
function tokenAndCompactionTotals(
  efficiencies: readonly SessionThreadEfficiency[]
): TokenAndCompactionTotals {
  const totals: Mutable<TokenAndCompactionTotals> = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    peakInputTokens: 0,
    cacheDrops: 0,
    compactions: 0,
    contextCompactedEvents: 0,
    maxReplacementItems: 0,
    maxReplacementBytes: 0,
    maxReplacementImages: 0,
    responseImageItems: 0
  };
  for (const { tokens, compaction } of efficiencies) {
    totals.totalTokens += tokens.totalTokens;
    totals.inputTokens += tokens.inputTokens;
    totals.cachedInputTokens += tokens.cachedInputTokens;
    totals.outputTokens += tokens.outputTokens;
    totals.reasoningOutputTokens += tokens.reasoningOutputTokens;
    totals.peakInputTokens = Math.max(
      totals.peakInputTokens,
      tokens.peakInputTokens
    );
    totals.cacheDrops += tokens.cacheDrops;
    totals.compactions += compaction.count;
    totals.contextCompactedEvents += compaction.contextCompactedEvents;
    totals.maxReplacementItems = Math.max(
      totals.maxReplacementItems,
      compaction.maxReplacementItems
    );
    totals.maxReplacementBytes = Math.max(
      totals.maxReplacementBytes,
      compaction.maxReplacementBytes
    );
    totals.maxReplacementImages = Math.max(
      totals.maxReplacementImages,
      compaction.maxReplacementImages
    );
    totals.responseImageItems += compaction.responseImageItems;
  }
  return totals;
}

/** The skill read counts of a session, keyed in the same order as a thread's. */
function sortedCounts(
  counts: Readonly<Record<string, number>>
): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) sorted[key] = counts[key] ?? 0;
  return sorted;
}

/**
 * Prompt overhead across every measured thread.
 *
 * Sizes are maxima, because every thread carries its own copy of the prompt.
 * Skill reads are summed, because every read of a thread is a real read: the
 * session count of a skill is the number of times any thread read it.
 */
function promptTotals(
  prompts: readonly SessionThreadPromptOverhead[]
): PromptTotals {
  const totals: Mutable<PromptTotals> = {
    maxInitialDeveloperBytes: 0,
    maxInitialDeveloperChars: 0,
    maxInitialDeveloperTokens: null,
    maxSkillsCatalogBytes: 0,
    maxSkillsLoaded: 0,
    skillsByRoot: {},
    uniqueSkillsRead: 0,
    skillReadCounts: {},
    skillTelemetryReads: null
  };
  const skillsByRoot: Record<string, number> = {};
  const skillReadCounts: Record<string, number> = {};
  for (const prompt of prompts) {
    totals.maxInitialDeveloperBytes = Math.max(
      totals.maxInitialDeveloperBytes,
      prompt.initialDeveloperBytes
    );
    totals.maxInitialDeveloperChars = Math.max(
      totals.maxInitialDeveloperChars,
      prompt.initialDeveloperChars
    );
    totals.maxInitialDeveloperTokens = maxOrNull(
      totals.maxInitialDeveloperTokens,
      prompt.initialDeveloperTokens
    );
    totals.maxSkillsCatalogBytes = Math.max(
      totals.maxSkillsCatalogBytes,
      prompt.skillsCatalogBytes
    );
    totals.maxSkillsLoaded = Math.max(
      totals.maxSkillsLoaded,
      prompt.skillsLoaded
    );
    addCounts(skillsByRoot, prompt.skillsByRoot);
    addCounts(skillReadCounts, prompt.skillReadCounts);
    totals.skillTelemetryReads = sumOrNull(
      totals.skillTelemetryReads,
      prompt.skillTelemetryReads
    );
  }
  const sortedReadCounts = sortedCounts(skillReadCounts);
  return {
    ...totals,
    skillsByRoot,
    uniqueSkillsRead: Object.keys(sortedReadCounts).length,
    skillReadCounts: sortedReadCounts
  };
}

function addProviderStats(
  target: Record<string, SessionRouterProviderStats>,
  source: Readonly<Record<string, SessionRouterProviderStats>>
): void {
  for (const [provider, stats] of Object.entries(source)) {
    const existing = target[provider];
    target[provider] = {
      requests: (existing?.requests ?? 0) + stats.requests,
      failures: (existing?.failures ?? 0) + stats.failures,
      elapsedMs: (existing?.elapsedMs ?? 0) + stats.elapsedMs,
      toolCalls: (existing?.toolCalls ?? 0) + stats.toolCalls
    };
  }
}

/** Router requests, failures, retries and provider hops across the session. */
function routerTotals(router: readonly SessionRouterSummary[]): RouterTotals {
  const totals: Mutable<RouterTotals> = {
    routerRequests: 0,
    routerFailures: 0,
    routerSkippedTotal: 0,
    routerSkippedByReason: {},
    routerRetries: 0,
    exhaustionWaits: 0,
    transportErrors: 0,
    providerHops: 0,
    byProvider: {}
  };
  const routerSkippedByReason: Record<string, number> = {};
  const byProvider: Record<string, SessionRouterProviderStats> = {};
  for (const summary of router) {
    totals.routerRequests += summary.requests;
    totals.routerFailures += summary.failures.length;
    totals.routerRetries += summary.retries ?? 0;
    totals.transportErrors += summary.transportErrors ?? 0;
    totals.exhaustionWaits += summary.exhaustionWaits?.count ?? 0;
    totals.providerHops += Math.max(0, summary.providerSequence.length - 1);
    addProviderStats(byProvider, summary.byProvider);
    for (const skipped of summary.skipped ?? []) {
      totals.routerSkippedTotal += 1;
      addCount(routerSkippedByReason, skipped.reason);
    }
  }
  return { ...totals, routerSkippedByReason, byProvider };
}

/** The session-wide rollups every surface shows first. */
export function computeAggregates(
  threads: readonly SessionThreadTrace[],
  router: readonly SessionRouterSummary[]
): SessionDiagnosticsAggregates {
  const efficiencies = threads.flatMap((thread) =>
    thread.efficiency ? [thread.efficiency] : []
  );
  const tokens = tokenAndCompactionTotals(efficiencies);
  return {
    threadCount: threads.length,
    ...tokens,
    cacheHitPct:
      tokens.inputTokens > 0
        ? round1((tokens.cachedInputTokens / tokens.inputTokens) * 100)
        : null,
    reasoningPct:
      tokens.outputTokens > 0
        ? round1((tokens.reasoningOutputTokens / tokens.outputTokens) * 100)
        : null,
    ...promptTotals(efficiencies.map((efficiency) => efficiency.prompt)),
    ...threadActivityTotals(threads),
    ...routerTotals(router)
  };
}

/** How one session's diagnostics should be read. */
export interface SessionDiagnosticsOptions {
  /** The session or thread id being inspected. */
  readonly id: string;
  readonly codexHome: string;
  readonly routerLog: string;
  /** Skip everything that reads live state. */
  readonly offline: boolean;
  readonly includeEfficiency: boolean;
  readonly includeEvents: boolean;
  readonly eventsLimit: number;
  readonly eventsOffset: number;
  readonly includeItems: boolean;
  readonly itemsLimit: number;
  readonly itemsOffset: number;
  /** Narrow the events and items to one thread of the session. */
  readonly threadId?: string | undefined;
  readonly repoRoot?: string | null | undefined;
  /** The router's status, read in-process instead of over loopback. */
  readonly routerStatus?: (() => unknown) | undefined;
}

/** Slice a bounded page out of a longer list. */
function paginate<T>(
  items: readonly T[],
  limit: number,
  offset: number
): SessionPagedSlice<T> {
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    total,
    limit,
    offset,
    hasMore: offset + page.length < total
  };
}

/** The router events of the whole session, de-duplicated and in order. */
function sessionRouterEvents(
  threads: readonly SessionThreadTrace[],
  rows: readonly SessionRouterEventRow[]
): SessionRouterEventRow[] {
  const seen = new Set<string>();
  const events: SessionRouterEventRow[] = [];
  for (const thread of threads) {
    for (const event of routerEventsForThread(thread, rows)) {
      const key = `${event.at}\0${event.requestId}\0${event.phase}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events.sort((a, b) => COLLATOR.compare(a.at, b.at));
}

/**
 * Read one session's diagnostics.
 *
 * The report answers for a session that does not exist as well as for one that
 * does: `found` is false when no rollout matched, which is a fact about the
 * machine and not a failure of the read.
 */
export async function buildSessionDiagnosticsReport(
  options: SessionDiagnosticsOptions
): Promise<SessionDiagnosticsReport> {
  const rollouts = findSessionRollouts(
    rolloutRoots(options.codexHome),
    options.id
  );
  const threads = rollouts.map((file) =>
    traceThread(file, {
      items: options.includeItems,
      codexHome: options.codexHome
    })
  );
  const stamps = threads
    .flatMap((thread) => [thread.start, thread.end])
    .filter((value): value is string => typeof value === "string")
    .sort();
  const rows =
    stamps.length > 0
      ? await readRouterEvents(
          options.routerLog,
          shift(stamps[0]!, -5),
          shift(stamps.at(-1)!, 60)
        )
      : [];
  const router = threads.map((thread) =>
    summarizeRouter(thread, rows, options.includeEvents)
  );
  const bridgeAlerts = readBridgeLogAlerts(options.codexHome);
  const liveResult = await collectLiveDiagnostics({
    codexHome: options.codexHome,
    offline: options.offline,
    ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
    ...(options.routerStatus === undefined
      ? {}
      : { routerStatus: options.routerStatus })
  });
  const efficiency = options.includeEfficiency
    ? buildEfficiencySummary(options.codexHome, liveResult.status)
    : null;

  const rootThread = threads.find((thread) => thread.parentId === null);
  const rootSessionId =
    rootThread?.sessionId ?? rootThread?.id ?? threads[0]?.sessionId ?? null;
  const matchedByThreadId =
    rootSessionId !== null && options.id !== rootSessionId;
  const clientSurface = rootThread?.clientSurface ?? null;

  const allEvents = sessionRouterEvents(threads, rows);
  const events = options.threadId
    ? allEvents.filter((event) => event.thread === options.threadId)
    : allEvents;
  const allItems: SessionThreadItem[] = threads.flatMap((thread) =>
    (thread.items ?? []).map((item) => ({ ...item, threadId: thread.id }))
  );
  const items = options.threadId
    ? allItems.filter((item) => item.threadId === options.threadId)
    : allItems;

  return {
    schema: SESSION_DIAGNOSTICS_SCHEMA,
    found: threads.length > 0,
    requestedId: options.id,
    rootSessionId,
    matchedByThreadId,
    clientSurface,
    threads,
    router,
    logs: readLogSummaries(options.codexHome),
    bridgeAlerts,
    live: liveResult.live,
    efficiency,
    aggregates: computeAggregates(threads, router),
    eventsPage: options.includeEvents
      ? paginate(events, options.eventsLimit, options.eventsOffset)
      : {
          items: [],
          total: 0,
          limit: options.eventsLimit,
          offset: options.eventsOffset,
          hasMore: false
        },
    itemsPage: options.includeItems
      ? paginate(items, options.itemsLimit, options.itemsOffset)
      : {
          items: [],
          total: 0,
          limit: options.itemsLimit,
          offset: options.itemsOffset,
          hasMore: false
        }
  };
}
