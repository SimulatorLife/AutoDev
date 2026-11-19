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
  type SessionThreadItem,
  type SessionThreadTrace
} from "@simulatorlife/autodev-core";

import {
  buildEfficiencySummary,
  collectLiveDiagnostics,
  readBridgeLogAlerts,
  readLogSummaries
} from "./live-context.ts";
import {
  readRouterEvents,
  routerEventsForThread,
  shift,
  summarizeRouter
} from "./router-events.ts";
import { findSessionRollouts, rolloutRoots } from "./rollout-discovery.ts";
import { traceThread } from "./thread-tracer.ts";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function addCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

/** The session-wide rollups every surface shows first. */
export function computeAggregates(
  threads: readonly SessionThreadTrace[],
  router: readonly SessionRouterSummary[]
): SessionDiagnosticsAggregates {
  let totalTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let peakInputTokens = 0;
  let cacheDrops = 0;
  let compactions = 0;
  let contextCompactedEvents = 0;
  let maxReplacementItems = 0;
  let maxReplacementBytes = 0;
  let maxReplacementImages = 0;
  let responseImageItems = 0;
  let maxInitialDeveloperBytes = 0;
  let maxSkillsCatalogBytes = 0;
  let maxSkillsLoaded = 0;
  let turnsTotal = 0;
  let gapsCount = 0;
  let toolCallsTotal = 0;
  let toolFailuresTotal = 0;
  let preToolUseBlocks = 0;
  let routerRequests = 0;
  let routerFailures = 0;
  let routerSkippedTotal = 0;
  let routerRetries = 0;
  let exhaustionWaits = 0;
  let transportErrors = 0;
  let providerHops = 0;
  let skillTelemetryReads: number | null = null;

  const skillsByRoot: Record<string, number> = {};
  const turnsByOutcome: Record<string, number> = {};
  const toolCallsByName: Record<string, number> = {};
  const toolFailuresByCategory: Record<string, number> = {};
  const routerSkippedByReason: Record<string, number> = {};
  const byProvider: Record<string, SessionRouterProviderStats> = {};
  const uniqueSkillsRead = new Set<string>();

  for (const thread of threads) {
    turnsTotal += thread.turns.length;
    gapsCount += thread.gaps.length;
    for (const turn of thread.turns) addCount(turnsByOutcome, turn.outcome);
    for (const [tool, count] of Object.entries(thread.tools)) {
      toolCallsByName[tool] = (toolCallsByName[tool] ?? 0) + count;
      toolCallsTotal += count;
    }
    for (const failure of thread.toolFailures) {
      const category =
        failure.category ?? classifyToolFailure(failure.detail, failure.input);
      addCount(toolFailuresByCategory, category);
      toolFailuresTotal += 1;
      if (category === "pretooluse-hook") preToolUseBlocks += 1;
    }
    const efficiency = thread.efficiency;
    if (!efficiency) continue;
    totalTokens += efficiency.tokens.totalTokens;
    inputTokens += efficiency.tokens.inputTokens;
    cachedInputTokens += efficiency.tokens.cachedInputTokens;
    outputTokens += efficiency.tokens.outputTokens;
    reasoningOutputTokens += efficiency.tokens.reasoningOutputTokens;
    peakInputTokens = Math.max(
      peakInputTokens,
      efficiency.tokens.peakInputTokens
    );
    cacheDrops += efficiency.tokens.cacheDrops;
    compactions += efficiency.compaction.count;
    contextCompactedEvents += efficiency.compaction.contextCompactedEvents;
    maxReplacementItems = Math.max(
      maxReplacementItems,
      efficiency.compaction.maxReplacementItems
    );
    maxReplacementBytes = Math.max(
      maxReplacementBytes,
      efficiency.compaction.maxReplacementBytes
    );
    maxReplacementImages = Math.max(
      maxReplacementImages,
      efficiency.compaction.maxReplacementImages
    );
    responseImageItems += efficiency.compaction.responseImageItems;
    maxInitialDeveloperBytes = Math.max(
      maxInitialDeveloperBytes,
      efficiency.prompt.initialDeveloperBytes
    );
    maxSkillsCatalogBytes = Math.max(
      maxSkillsCatalogBytes,
      efficiency.prompt.skillsCatalogBytes
    );
    maxSkillsLoaded = Math.max(
      maxSkillsLoaded,
      efficiency.prompt.skillsLoaded
    );
    for (const [root, count] of Object.entries(efficiency.prompt.skillsByRoot))
      skillsByRoot[root] = (skillsByRoot[root] ?? 0) + count;
    for (const skill of efficiency.prompt.skillsRead) uniqueSkillsRead.add(skill);
    if (efficiency.prompt.skillTelemetryReads !== null)
      skillTelemetryReads =
        (skillTelemetryReads ?? 0) + efficiency.prompt.skillTelemetryReads;
  }

  for (const summary of router) {
    routerRequests += summary.requests;
    routerFailures += summary.failures.length;
    routerRetries += summary.retries ?? 0;
    transportErrors += summary.transportErrors ?? 0;
    exhaustionWaits += summary.exhaustionWaits?.count ?? 0;
    providerHops += Math.max(0, summary.providerSequence.length - 1);
    for (const [provider, stats] of Object.entries(summary.byProvider)) {
      const existing = byProvider[provider] ?? {
        requests: 0,
        failures: 0,
        elapsedMs: 0,
        toolCalls: 0
      };
      byProvider[provider] = {
        requests: existing.requests + stats.requests,
        failures: existing.failures + stats.failures,
        elapsedMs: existing.elapsedMs + stats.elapsedMs,
        toolCalls: existing.toolCalls + stats.toolCalls
      };
    }
    for (const skipped of summary.skipped ?? []) {
      routerSkippedTotal += 1;
      addCount(routerSkippedByReason, skipped.reason);
    }
  }

  return {
    threadCount: threads.length,
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheHitPct:
      inputTokens > 0 ? round1((cachedInputTokens / inputTokens) * 100) : null,
    reasoningPct:
      outputTokens > 0 ? round1((reasoningOutputTokens / outputTokens) * 100) : null,
    peakInputTokens,
    cacheDrops,
    compactions,
    contextCompactedEvents,
    maxReplacementItems,
    maxReplacementBytes,
    maxReplacementImages,
    responseImageItems,
    maxInitialDeveloperBytes,
    maxSkillsCatalogBytes,
    maxSkillsLoaded,
    skillsByRoot,
    uniqueSkillsRead: uniqueSkillsRead.size,
    skillTelemetryReads,
    turnsTotal,
    turnsByOutcome,
    gapsCount,
    toolCallsTotal,
    toolCallsByName,
    toolFailuresTotal,
    toolFailuresByCategory,
    preToolUseBlocks,
    routerRequests,
    routerFailures,
    routerSkippedTotal,
    routerSkippedByReason,
    routerRetries,
    exhaustionWaits,
    transportErrors,
    providerHops,
    byProvider
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
  return events.sort((a, b) => a.at.localeCompare(b.at));
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
    threads,
    router,
    logs: readLogSummaries(options.codexHome),
    bridgeAlerts,
    live: liveResult.live,
    efficiency,
    aggregates: computeAggregates(threads, router),
    eventsPage: options.includeEvents
      ? paginate(events, options.eventsLimit, options.eventsOffset)
      : { items: [], total: 0, limit: options.eventsLimit, offset: options.eventsOffset, hasMore: false },
    itemsPage: options.includeItems
      ? paginate(items, options.itemsLimit, options.itemsOffset)
      : { items: [], total: 0, limit: options.itemsLimit, offset: options.itemsOffset, hasMore: false }
  };
}
