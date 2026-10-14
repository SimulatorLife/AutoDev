/**
 * Pure decisions behind the live batch view, kept separate from the hook so
 * each rule can be tested directly. Every value here is derived from a server
 * response; nothing infers batch state, and nothing treats a failed read as
 * an up-to-date one.
 */
import {
  type ControlApiPlaytestingRunRecord,
  type PlaytestCompletionCounts,
  type PlaytestJsonValue,
  type PlaytestRunAssignmentOutcome,
  PLAYTESTS_EPISODE_STATES,
  PLAYTESTS_GAME_OUTCOMES
} from "@simulatorlife/autodev-core";

/** Terminal states are read once, then that batch stops being polled. */
export const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "truncated"
]);

export const INITIAL_POLL_INTERVAL_MS = 1500;
export const MAX_POLL_INTERVAL_MS = 30_000;
export const MAX_TRACKED_RUNS = 64;

export type PlaytestingActiveRunsFreshness =
  /** At least one nonterminal batch is being watched and reads are succeeding. */
  | "live"
  /** No batch is known nonterminal, so nothing is being watched. */
  | "idle"
  /** A read failed; no displayed value is being claimed as current. */
  | "unavailable";

export interface PlaytestingActiveRun {
  readonly batchId: string;
  readonly assignmentCount: number;
  readonly createdAt: string;
  readonly record: ControlApiPlaytestingRunRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the active-runs envelope for exactly one workspace. Returns null rather
 * than a partial list: one malformed entry fails the whole read, so the view
 * can never show a subset that looks complete.
 */
export function readActiveRuns(
  value: unknown,
  workspaceId: string
): readonly PlaytestingActiveRun[] | null {
  if (!isRecord(value) || value.kind !== "ok" || !isRecord(value.data)) {
    return null;
  }
  const { schema, workspaceId: echoed, runs } = value.data;
  if (
    schema !== "autodev-control-playtesting-runs-v1" ||
    echoed !== workspaceId ||
    !Array.isArray(runs)
  ) {
    return null;
  }
  const parsed: PlaytestingActiveRun[] = [];
  for (const entry of runs.slice(0, MAX_TRACKED_RUNS)) {
    if (
      !isRecord(entry) ||
      typeof entry.batchId !== "string" ||
      entry.batchId.length === 0 ||
      typeof entry.createdAt !== "string" ||
      !isRecord(entry.status) ||
      entry.status.batchId !== entry.batchId ||
      typeof entry.status.status !== "string"
    ) {
      return null;
    }
    parsed.push({
      batchId: entry.batchId,
      assignmentCount: Number(entry.assignmentCount ?? 0),
      createdAt: entry.createdAt,
      record: entry.status as unknown as ControlApiPlaytestingRunRecord
    });
  }
  return parsed;
}

export function isTerminal(record: ControlApiPlaytestingRunRecord): boolean {
  return TERMINAL_RUN_STATES.has(record.status);
}

/** Polling continues only while some batch is genuinely nonterminal. */
export function isWatching(runs: readonly PlaytestingActiveRun[]): boolean {
  return runs.some((run) => !isTerminal(run.record));
}

/** A successful read is `live` or `idle` by whether anything remains to watch. */
export function freshnessForSuccess(
  runs: readonly PlaytestingActiveRun[]
): PlaytestingActiveRunsFreshness {
  return isWatching(runs) ? "live" : "idle";
}

/** A failed read is `unavailable`, never the previous frame's `live`. */
export function freshnessForFailure(): PlaytestingActiveRunsFreshness {
  return "unavailable";
}

export interface PollLoopHandle {
  /** Poll once immediately, then re-arm after each completed poll. */
  readonly start: () => void;
  /** Cancel the pending arm. No further poll is issued. */
  readonly stop: () => void;
}

/**
 * Drive a self-scheduling poll loop.
 *
 * Each completed poll re-arms the next one. Arming once per effect run instead
 * is the defect this exists to make impossible: the effect only re-runs when
 * `watching` flips, so a view whose subject stays nonterminal polled twice and
 * then froze while still showing a live badge. The operator had to click
 * Refresh for the numbers to move — exactly what the live view promises never
 * to require.
 *
 * `shouldContinue` is read *after* every poll rather than captured up front, so
 * reaching a terminal state or pausing ends the loop promptly.
 */
export function createPollLoop(options: {
  readonly poll: () => Promise<void>;
  readonly shouldContinue: () => boolean;
  /** Backoff for the arm following the poll that just completed. */
  readonly delayFor: () => number;
}): PollLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const step = async (): Promise<void> => {
    if (stopped) return;
    await options.poll();
    if (stopped || !options.shouldContinue()) return;
    timer = setTimeout(() => {
      void step();
    }, options.delayFor());
  };
  return {
    start: () => {
      void step();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    }
  };
}

/** Exponential backoff, capped, so a failing Runtime is not hammered. */
export function nextPollDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.floor(consecutiveFailures));
  if (exponent >= 16) return MAX_POLL_INTERVAL_MS;
  return Math.min(
    INITIAL_POLL_INTERVAL_MS * 2 ** exponent,
    MAX_POLL_INTERVAL_MS
  );
}

/**
 * Batch counts, read verbatim from the owner's result. The Console never
 * recomputes assignment outcomes from a subset it happened to receive.
 *
 * The keys are the owner's own `PlaytestCompletionCounts`. Naming them here as
 * that type's keys means a renamed or removed field is a compile error rather
 * than a tile that silently renders "not observed" forever — which is exactly
 * what happened when the panel read `succeeded`/`failed`/`quota-blocked`/
 * `episodes`, none of which the Runtime ever writes.
 */
export function assignmentCounts(
  record: ControlApiPlaytestingRunRecord
): Readonly<Record<keyof PlaytestCompletionCounts, PlaytestJsonValue>> | null {
  if (!isRecord(record.result)) return null;
  const { counts } = record.result;
  if (!isRecord(counts)) return null;
  return counts as Readonly<
    Record<keyof PlaytestCompletionCounts, PlaytestJsonValue>
  >;
}

/**
 * Read each recorded assignment from the run owner's result without inferring
 * game outcomes from Runtime execution state. A malformed row invalidates the
 * whole list; silently dropping one would make the visible results incomplete.
 */
export function assignmentOutcomes(
  record: ControlApiPlaytestingRunRecord
): readonly PlaytestRunAssignmentOutcome[] | null {
  if (!isRecord(record.result) || !Array.isArray(record.result.outcomes)) {
    return null;
  }
  const assignmentIds = new Set<string>();
  const episodeIds = new Set<string>();
  const outcomes: PlaytestRunAssignmentOutcome[] = [];
  for (const value of record.result.outcomes) {
    if (
      !isRecord(value) ||
      typeof value.assignmentId !== "string" ||
      value.assignmentId.trim().length === 0 ||
      value.assignmentId.length > 256 ||
      (typeof value.episodeId !== "string" && value.episodeId !== null) ||
      (typeof value.episodeId === "string" &&
        (value.episodeId.trim().length === 0 ||
          value.episodeId.length > 256)) ||
      typeof value.started !== "boolean" ||
      typeof value.eligible !== "boolean" ||
      !isAssignmentTerminalState(value.state) ||
      !isGameOutcome(value.gameOutcome) ||
      (value.eligible && value.state !== "completed") ||
      (value.episodeId === null &&
        (value.gameOutcome !== null ||
          value.started ||
          value.eligible ||
          (value.state !== "cancelled" &&
            value.state !== "infrastructure-failed"))) ||
      (value.episodeId !== null && value.gameOutcome === null) ||
      assignmentIds.has(value.assignmentId) ||
      (typeof value.episodeId === "string" && episodeIds.has(value.episodeId))
    ) {
      return null;
    }
    assignmentIds.add(value.assignmentId);
    if (typeof value.episodeId === "string") episodeIds.add(value.episodeId);
    outcomes.push({
      assignmentId: value.assignmentId,
      episodeId: value.episodeId,
      state: value.state,
      started: value.started,
      eligible: value.eligible,
      gameOutcome: value.gameOutcome
    });
  }
  return outcomes;
}

function isAssignmentTerminalState(
  value: unknown
): value is PlaytestRunAssignmentOutcome["state"] {
  return (
    typeof value === "string" &&
    PLAYTESTS_EPISODE_STATES.includes(
      value as PlaytestRunAssignmentOutcome["state"]
    ) &&
    value !== "assigned" &&
    value !== "started"
  );
}

function isGameOutcome(
  value: unknown
): value is PlaytestRunAssignmentOutcome["gameOutcome"] {
  return (
    value === null ||
    (typeof value === "string" &&
      PLAYTESTS_GAME_OUTCOMES.includes(
        value as NonNullable<PlaytestRunAssignmentOutcome["gameOutcome"]>
      ))
  );
}
