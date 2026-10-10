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
