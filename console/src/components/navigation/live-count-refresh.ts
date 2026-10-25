import { isWholePageNavigationPending } from "./whole-page-navigation.ts";

/**
 * Whether the live counts should be refreshed now.
 *
 * A refresh that lands while the Console is navigating takes the navigation's
 * place in the router: Next.js keeps the navigation it is running as a promise
 * in its state, and `router.refresh()` replaces that promise with its own, so
 * the navigation never applies its page -- the address bar does not move and
 * the page the operator asked for does not arrive.
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

/** Scheduler boundary keeps interval behavior and cleanup independently testable. */
export function startLiveCountRefresh(
  dispatch: () => void,
  scheduler: Pick<
    typeof globalThis,
    "setInterval" | "clearInterval"
  > = globalThis
): () => void {
  const timer = scheduler.setInterval(dispatch, LIVE_COUNT_REFRESH_INTERVAL_MS);
  return () => scheduler.clearInterval(timer);
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
