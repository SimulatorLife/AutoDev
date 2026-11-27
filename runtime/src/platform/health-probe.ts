/**
A bounded HTTP status probe shared by managed service readiness checks.
*/
const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
Caller cancellation may shorten, never extend, the probe's own deadline.
Redirects do not establish readiness of the service being checked.
*/
export function httpHealthProbe(
  url: string,
  init: RequestInit = {}
): () => Promise<boolean> {
  return async () => {
    try {
      const deadline = AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS);
      const signal = init.signal
        ? AbortSignal.any([init.signal, deadline])
        : deadline;
      signal.throwIfAborted();
      const response = await fetch(url, {
        ...init,
        redirect: "error",
        signal
      });
      // We only need the status. Release the unread response stream rather
      // than keeping connections occupied until the deadline or GC.
      void response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  };
}
