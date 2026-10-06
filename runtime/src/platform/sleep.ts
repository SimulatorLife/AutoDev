/**
 * The one pause the platform lifecycle steps share.
 *
 * Every ensure step and the service supervisor accepts a `sleep` in its
 * dependency bundle so tests can advance time without waiting for it, and each
 * one supplied its own inline `new Promise((resolve) => setTimeout(resolve, ms))`.
 * Seven copies of that line meant the timing seam those tests stand on was
 * defined seven times, so any change to how a pause is scheduled -- clearing
 * the timer, yielding to the event loop first -- would have had to be made
 * seven times and silently drift in between.
 *
 * This is deliberately not the router's abortable `delay`. That lives a layer up
 * in `router/proxy.ts`, takes an AbortSignal, and exists for request
 * cancellation; reusing it here would make every platform entry point depend on
 * the router for a plain timer, and the platform layer does not import the
 * router anywhere today.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
