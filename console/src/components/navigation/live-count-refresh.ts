import {
  browserVisibilitySource,
  type VisibilitySource
} from "./visibility.ts";
import { isWholePageNavigationPending } from "./whole-page-navigation.ts";

/**
 * Whether the live counts should be refreshed now.
 *
 * A refresh that lands while the Console is navigating takes the navigation's
 * place in the router: Next.js keeps the navigation it is running as a promise
 * in its state, and a refresh replaces that promise with its own, so the
 * navigation never applies its page -- the address bar does not move and the
 * page the operator asked for does not arrive.
 *
 * It is not a rare race. The refresh runs every five seconds and the
 * navigation to the densest page in the Console -- the providers table, with a
 * write form for every role and every limit -- takes longer than that to issue
 * its request, so the two landed on top of each other every time.
 *
 * So the refresh waits for the navigation. The counts it refreshes are the
 * counts of the page the operator is on, and a page that is being replaced
 * does not need its counts refreshed.
 */
export function shouldRefreshLiveCounts(): boolean {
  return !isWholePageNavigationPending();
}

/** Periodically refresh only views that render Runtime live-count evidence. */
export const LIVE_COUNT_REFRESH_INTERVAL_MS = 5000;
export const LIVE_COUNT_REFRESH_EVENT = "autodev:refresh-live-counts";

/**
 * The interval that refreshes the live counts.
 *
 * The scheduler boundary keeps interval behavior and cleanup independently
 * testable.
 *
 * The refresh only runs while the operator is looking at the page. A hidden
 * tab is not read, so refreshing it is work nobody asked for: on the
 * providers page it is the largest route in the Console, re-serialized in full
 * every five seconds, for as long as the tab was open and unread.
 *
 * Becoming visible again is a refresh in its own right. The counts the
 * operator comes back to are as old as the moment they left, and the operator
 * is about to read them, so the page refreshes the moment it is shown rather
 * than waiting out the remainder of the interval.
 */
export function startLiveCountRefresh(
  dispatch: () => void,
  scheduler: Pick<
    typeof globalThis,
    "setInterval" | "clearInterval"
  > = globalThis,
  visibility: VisibilitySource = browserVisibilitySource()
): () => void {
  const refreshIfVisible = (): void => {
    if (!visibility.isVisible()) return;
    dispatch();
  };
  const timer = scheduler.setInterval(
    refreshIfVisible,
    LIVE_COUNT_REFRESH_INTERVAL_MS
  );
  const stopWatchingVisibility = visibility.onVisible(refreshIfVisible);
  return () => {
    scheduler.clearInterval(timer);
    stopWatchingVisibility();
  };
}

/** Connect the page's refresh event to the shared Next router owner. */
export function registerLiveCountRefresh(
  refresh: () => void,
  target: EventTarget = globalThis.window
): () => void {
  const handleRefresh = (): void => refresh();
  target.addEventListener(LIVE_COUNT_REFRESH_EVENT, handleRefresh);
  return () =>
    target.removeEventListener(LIVE_COUNT_REFRESH_EVENT, handleRefresh);
}
