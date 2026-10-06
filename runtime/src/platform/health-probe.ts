/**
 * The one HTTP health probe the platform lifecycle steps use to ask a managed
 * service whether it is up.
 *
 * Every ensure step builds the same closure: fetch the service's health endpoint
 * under a one-second bound and report `response.ok`, folding any failure into
 * `false`. Six modules each carried their own copy, and those copies had already
 * drifted -- one added `cache: "no-store"`, another named the response `res`
 * instead of `response` -- so one question about one service was being asked six
 * subtly different ways.
 *
 * Two properties are the reason this is shared rather than left inline. A probe
 * must never throw, because its callers poll it through a bounded readiness wait
 * whose contract is a plain boolean; an unreachable service, a refused
 * connection, and an elapsed timeout are all simply "not ready yet". And it must
 * stay bounded itself, because a service that accepts the connection and then
 * stalls would otherwise hold the wait past its own deadline.
 *
 * This module owns how a probe observes a service. `wait-for-probe.ts` owns how
 * often and for how long that observation is retried; the `probe` itself reaches
 * the caller as an injected dependency, which is what lets tests answer the
 * readiness question without a socket.
 */

/** Ceiling on a single health request, so a hung service cannot outlive the wait. */
const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
 * Build a probe for `url` that resolves true only when the service answers with a
 * successful status, and false for any failure at all.
 *
 * `init` is forwarded to `fetch` for callers that need a specific request shape
 * (Console, for instance, must bypass the HTTP cache so a stale success cannot
 * report a stopped service as ready). The one-second signal is applied last and
 * cannot be overridden, because an unbounded probe defeats the wait that drives it.
 */
export function httpHealthProbe(
  url: string,
  init: RequestInit = {}
): () => Promise<boolean> {
  return async () => {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}
