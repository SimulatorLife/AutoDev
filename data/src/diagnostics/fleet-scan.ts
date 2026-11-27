/**
The cross-session fleet scan.

One session's report answers "what happened to this session". The fleet scan
answers the question an operator actually has when several sessions look
wrong: "which sessions look wrong, and why". It reads the rotated router
logs once and then walks the newest sessions, so the whole fleet costs one
pass over the logs rather than one pass per session.
*/

import {
  classifyToolFailure,
  type FleetScanTotals,
  type FleetSessionRow,
  SESSION_FLEET_SCAN_SCHEMA,
  type SessionFleetScanResponse,
  type SessionRouterSummary,
  type SessionThreadTrace,
  type ToolFailureCategory
} from "@simulatorlife/autodev-core";

import {
  listRecentSessions,
  mergeNativeRecentSessions,
  readHeadMeta,
  rolloutFiles,
  rolloutRoots
} from "./rollout-discovery.ts";
import { readRouterEvents, shift, summarizeRouter } from "./router-events.ts";
import { traceThread } from "./thread-tracer.ts";
import type { MutableFleetRow } from "./working-shapes.ts";

const COLLATOR = new Intl.Collator();
const PRETOOLUSE_MARKER = "Command blocked by PreToolUse hook:";
const PRETOOLUSE_HINT_SUFFIX_REGEX =
  /[ \t]+(?:Work from|Use |Delegate |Call |Allowed:|Tip:)/u;
const REASON_LIMIT = 10;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
The policy reason behind a `PreToolUse` block, without the trailing hint.
*/
export function extractPreToolUseReason(detail: string): string | null {
  const markerIndex = detail.indexOf(PRETOOLUSE_MARKER);
  if (markerIndex === -1) return null;
  const afterMarker = detail
    .slice(markerIndex + PRETOOLUSE_MARKER.length)
    .trimStart();
  const newlineIndex = afterMarker.indexOf("\n");
  const reasonLine =
    newlineIndex === -1 ? afterMarker : afterMarker.slice(0, newlineIndex);
  const suffixAt = reasonLine.search(PRETOOLUSE_HINT_SUFFIX_REGEX);
  const clipped = suffixAt === -1 ? reasonLine : reasonLine.slice(0, suffixAt);
  const trimmed = clipped.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
The rollouts of the selected sessions, grouped by the session they own.
*/
function rolloutsForSelectedSessions(
  codexHome: string,
  selectedIds: Set<string>
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const files = rolloutRoots(codexHome)
    .flatMap((root) => rolloutFiles(root))
    .sort((a, b) => COLLATOR.compare(pathBasename(b), pathBasename(a)));
  for (const file of files) {
    const meta = readHeadMeta(file);
    if (!meta) continue;
    const owner =
      typeof meta.session_id === "string" && selectedIds.has(meta.session_id)
        ? meta.session_id
        : typeof meta.id === "string" && selectedIds.has(meta.id)
          ? meta.id
          : typeof meta.parent_thread_id === "string" &&
              selectedIds.has(meta.parent_thread_id)
            ? meta.parent_thread_id
            : null;
    if (!owner) continue;
    const list = grouped.get(owner) ?? [];
    list.push(file);
    grouped.set(owner, list);
  }
  return grouped;
}

/**
The last path segment, without the filesystem.
*/
function pathBasename(value: string): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? value : value.slice(index + 1);
}

interface SessionFleetAccumulator {
  row: MutableFleetRow;
  failureCounts: Map<ToolFailureCategory, number>;
}

/**
The fleet totals while they are being accumulated.

The published `FleetScanTotals` is immutable, so the running totals are a
separate mutable shape that is frozen once the scan is done.
*/
interface MutableFleetTotals {
  sessions: number;
  threads: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheDrops: number;
  compactions: number;
  toolFailuresByCategory: Record<string, number>;
}

function accumulateFleetThread(
  thread: SessionThreadTrace,
  router: SessionRouterSummary,
  accumulator: SessionFleetAccumulator,
  totals: MutableFleetTotals,
  preToolReasons: Map<string, number>,
  skippedReasons: Map<string, number>
): void {
  const efficiency = thread.efficiency;
  if (efficiency) {
    accumulator.row.totalTokens += efficiency.tokens.totalTokens;
    accumulator.row.inputTokens += efficiency.tokens.inputTokens;
    accumulator.row.cachedInputTokens += efficiency.tokens.cachedInputTokens;
    accumulator.row.cacheDrops += efficiency.tokens.cacheDrops;
    accumulator.row.compactions += efficiency.compaction.count;
    if (efficiency.prompt.skillsLoaded > accumulator.row.maxSkillsLoaded)
      accumulator.row.maxSkillsLoaded = efficiency.prompt.skillsLoaded;
    totals.totalTokens += efficiency.tokens.totalTokens;
    totals.inputTokens += efficiency.tokens.inputTokens;
    totals.cachedInputTokens += efficiency.tokens.cachedInputTokens;
    totals.cacheDrops += efficiency.tokens.cacheDrops;
    totals.compactions += efficiency.compaction.count;
  }
  for (const failure of thread.toolFailures) {
    accumulator.row.toolFailures += 1;
    const category =
      failure.category ?? classifyToolFailure(failure.detail, failure.input);
    accumulator.failureCounts.set(category, (accumulator.failureCounts.get(category) ?? 0) + 1);
    totals.toolFailuresByCategory[category] =
      (totals.toolFailuresByCategory[category] ?? 0) + 1;
    if (category === "pretooluse-hook") {
      accumulator.row.preToolUseBlocks += 1;
      const reason = extractPreToolUseReason(failure.detail) ?? failure.detail;
      preToolReasons.set(reason, (preToolReasons.get(reason) ?? 0) + 1);
    }
  }
  accumulator.row.routerRequests += router.requests;
  accumulator.row.routerFailures += router.failures.length;
  for (const [provider, stats] of Object.entries(router.byProvider)) {
    accumulator.row.providers[provider] =
      (accumulator.row.providers[provider] ?? 0) + stats.requests;
  }
  for (const skipped of router.skipped ?? []) {
    const key = `${skipped.provider ?? "?"}:${skipped.reason}`;
    accumulator.row.routerSkipped[key] = (accumulator.row.routerSkipped[key] ?? 0) + 1;
    skippedReasons.set(key, (skippedReasons.get(key) ?? 0) + 1);
  }
}

/**
How the fleet scan should read.
*/
export interface FleetScanOptions {
  readonly codexHome: string;
  readonly routerLog: string;
  readonly limit: number;
}

/**
Summarize efficiency, failures, `PreToolUse` blocks, and router skips across
the newest sessions.
*/
export async function scanRecentSessions(
  options: FleetScanOptions
): Promise<SessionFleetScanResponse> {
  const recent = listRecentSessions(
    rolloutRoots(options.codexHome),
    options.limit
  );
  const bySession = rolloutsForSelectedSessions(
    options.codexHome,
    new Set(recent.map((session) => session.id))
  );
  const tracedBySession = new Map<string, SessionThreadTrace[]>();
  const stamps: string[] = [];
  let totalThreads = 0;

  for (const session of recent) {
    const traces = (bySession.get(session.id) ?? []).map((file) =>
      traceThread(file, { items: false, codexHome: options.codexHome })
    );
    tracedBySession.set(session.id, traces);
    totalThreads += traces.length;
    for (const trace of traces) {
      if (trace.start) stamps.push(trace.start);
      if (trace.end) stamps.push(trace.end);
    }
  }
  stamps.sort();
  const rows =
    stamps.length > 0
      ? await readRouterEvents(
          options.routerLog,
          shift(stamps[0]!, -5),
          shift(stamps.at(-1)!, 60)
        )
      : [];

  const totals: MutableFleetTotals = {
    sessions: recent.length,
    threads: totalThreads,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheDrops: 0,
    compactions: 0,
    toolFailuresByCategory: {}
  };
  const preToolReasons = new Map<string, number>();
  const skippedReasons = new Map<string, number>();
  const sessionRows: FleetSessionRow[] = [];

  for (const session of recent) {
    const traces = tracedBySession.get(session.id) ?? [];
    const rootTrace = traces.find((trace) => trace.parentId === null);
    const accumulator: SessionFleetAccumulator = {
      failureCounts: new Map(),
      row: {
        id: session.id,
        started: session.started,
        lastWrite: session.lastWrite,
        cwd: session.cwd,
        clientSurface: rootTrace?.clientSurface ?? session.clientSurface,
        threads: traces.length > 0 ? traces.length : session.threads,
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheHitPct: null,
        cacheDrops: 0,
        compactions: 0,
        maxSkillsLoaded: 0,
        toolFailures: 0,
        preToolUseBlocks: 0,
        topFailureCategory: null,
        routerRequests: 0,
        routerFailures: 0,
        routerSkipped: {},
        providers: {}
      }
    };
    for (const trace of traces) {
      accumulateFleetThread(
        trace,
        summarizeRouter(trace, rows, false),
        accumulator,
        totals,
        preToolReasons,
        skippedReasons
      );
    }
    accumulator.row.cacheHitPct =
      accumulator.row.inputTokens > 0
        ? round1((accumulator.row.cachedInputTokens / accumulator.row.inputTokens) * 100)
        : null;
    const topFailure = [...accumulator.failureCounts.entries()].sort(
      (a, b) => b[1] - a[1]
    )[0];
    accumulator.row.topFailureCategory = topFailure?.[0] ?? null;
    sessionRows.push(accumulator.row);
  }

  const publishedTotals: FleetScanTotals = {
    sessions: totals.sessions,
    threads: totals.threads,
    totalTokens: totals.totalTokens,
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheHitPct:
      totals.inputTokens > 0
        ? round1((totals.cachedInputTokens / totals.inputTokens) * 100)
        : null,
    cacheDrops: totals.cacheDrops,
    compactions: totals.compactions,
    toolFailuresByCategory: totals.toolFailuresByCategory,
    preToolUseReasons: [...preToolReasons]
      .sort((a, b) => b[1] - a[1])
      .slice(0, REASON_LIMIT)
      .map(([reason, count]) => ({ reason, count })),
    routerSkippedByReason: [...skippedReasons]
      .sort((a, b) => b[1] - a[1])
      .slice(0, REASON_LIMIT)
      .map(([key, count]) => ({ key, count }))
  };

  const recentSessions = mergeNativeRecentSessions(
    recent,
    options.limit,
    options.routerLog
  );
  const rolloutIds = new Set(recent.map((session) => session.id));
  return {
    schema: SESSION_FLEET_SCAN_SCHEMA,
    limit: options.limit,
    sessions: sessionRows,
    ...(recentSessions.some((session) => !rolloutIds.has(session.id)) && { recentSessions }),
    totals: publishedTotals
  };
}
