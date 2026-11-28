import { shouldRefreshLiveCounts } from "../../components/navigation/live-count-refresh.ts";
import {
  browserVisibilitySource,
  type VisibilitySource
} from "../../components/navigation/visibility.ts";

/**
Canonical Usage polling intervals mandated by `autodev-console-target-state.md`:
- Historical Usage widgets refresh at most every 60 seconds while visible.
- Live Active Sessions state refreshes at most every 5 seconds while visible.
*/
export const HISTORICAL_USAGE_REFRESH_INTERVAL_MS = 60_000;
export const ACTIVE_SESSIONS_REFRESH_INTERVAL_MS = 5000;
export const MAX_USAGE_BACKOFF_INTERVAL_MS = 300_000;

/**
Compute the delay before the next automatic Usage refresh.

Healthy streams run at the cadence the view requires (60s for historical
aggregations, 5s for live Runtime state). When a source fails or rate-limits,
successive retries double up to `MAX_USAGE_BACKOFF_INTERVAL_MS` rather than
creating an unbounded retry loop.
*/
export function computeUsageRefreshDelayMs(
  baseIntervalMs: number,
  consecutiveFailures: number
): number {
  if (consecutiveFailures <= 0) return baseIntervalMs;
  const exponent = Math.min(consecutiveFailures, 6);
  return Math.min(
    baseIntervalMs * 2 ** exponent,
    MAX_USAGE_BACKOFF_INTERVAL_MS
  );
}

export type UsageRefreshScheduler = Pick<
  typeof globalThis,
  "setTimeout" | "clearTimeout"
>;

export interface UsageRefreshLoopOptions {
  readonly baseIntervalMs: number;
  readonly refresh: () => Promise<boolean>;
  readonly isPaused: () => boolean;
  readonly scheduler?: UsageRefreshScheduler;
  readonly visibility?: VisibilitySource;
  readonly canRefresh?: () => boolean;
  readonly onScheduledDelay?: (delayMs: number) => void;
}

/**
Run a visibility-aware, backoff-bounded Usage refresh loop.

Returns a handle to trigger an immediate manual refresh or stop the loop
while cancelling any pending timeout and detaching visibility listeners.
*/
export function startUsageRefreshLoop({
  baseIntervalMs,
  refresh,
  isPaused,
  scheduler = globalThis,
  visibility = browserVisibilitySource(),
  canRefresh = shouldRefreshLiveCounts,
  onScheduledDelay
}: UsageRefreshLoopOptions): {
  readonly stop: () => void;
  readonly triggerNow: () => void;
} {
  let isStopped = false;
  let isInFlight = false;
  let consecutiveFailures = 0;
  let timer: ReturnType<UsageRefreshScheduler["setTimeout"]> | null = null;

  const clearScheduled = (): void => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  const scheduleNext = (delayMs: number): void => {
    clearScheduled();
    if (isStopped || isPaused() || !visibility.isVisible()) return;
    onScheduledDelay?.(delayMs);
    timer = scheduler.setTimeout(() => {
      timer = null;
      void runTick(false);
    }, delayMs);
  };

  const didRefreshSucceed = async (): Promise<boolean> => {
    try {
      return await refresh();
    } catch {
      return false;
    }
  };

  const finishAttempt = (hasSucceeded: boolean): void => {
    isInFlight = false;
    if (isStopped) return;
    if (hasSucceeded) {
      consecutiveFailures = 0;
      scheduleNext(baseIntervalMs);
      return;
    }
    consecutiveFailures += 1;
    scheduleNext(
      computeUsageRefreshDelayMs(baseIntervalMs, consecutiveFailures)
    );
  };

  const runTick = async (isManual: boolean): Promise<void> => {
    if (isStopped || isInFlight) return;
    if (!isManual && (isPaused() || !visibility.isVisible() || !canRefresh())) {
      if (!isPaused() && visibility.isVisible()) {
        // Defer cleanly when a whole-page Next.js navigation is in flight so
        // we never cancel the operator's navigation.
        scheduleNext(baseIntervalMs);
      }
      return;
    }

    clearScheduled();
    isInFlight = true;
    const hasSucceeded = await didRefreshSucceed();
    finishAttempt(hasSucceeded);
  };

  const stopWatchingVisibility = visibility.onVisible(() => {
    if (isStopped || isPaused()) return;
    void runTick(false);
  });

  if (!isPaused() && visibility.isVisible()) {
    scheduleNext(baseIntervalMs);
  }

  return {
    stop: () => {
      isStopped = true;
      clearScheduled();
      stopWatchingVisibility();
    },
    triggerNow: () => {
      if (isStopped || isInFlight) return;
      consecutiveFailures = 0;
      clearScheduled();
      void runTick(true);
    }
  };
}
