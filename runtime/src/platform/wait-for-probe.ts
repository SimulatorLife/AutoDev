/** Gap between readiness probes, bounded by the remaining wait budget. */
const PROBE_POLL_INTERVAL_MS = 100;

export interface ProbeWaitDeps {
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Poll on a monotonic clock and perform one final observation at the deadline.
 * Individual probes must be bounded by their owner; the last probe may finish
 * after the wait budget. An invalid budget is a configuration error.
 */
export async function waitForProbe(
  deps: ProbeWaitDeps,
  timeoutMs: number
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Readiness timeout must be finite and nonnegative.");
  }
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- observe sequentially; never overlap probes.
    if (await deps.probe()) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    // eslint-disable-next-line no-await-in-loop -- respect the readiness budget.
    await deps.sleep(Math.min(PROBE_POLL_INTERVAL_MS, Math.ceil(remaining)));
  }
  return deps.probe();
}
