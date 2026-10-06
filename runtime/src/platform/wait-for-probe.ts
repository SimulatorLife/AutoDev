/**
 * The one readiness wait shared by the platform lifecycle ensure steps.
 *
 * Every managed service (router, console, Claude, Copilot, MiniMax, Antigravity)
 * is started by launchd or a detached fallback launcher and then has to be
 * observed answering its health endpoint before the caller may report it ready.
 * Each of those modules carried its own copy of that poll, and the copies had
 * already drifted apart: some took a timeout and derived the deadline, one took
 * a pre-computed deadline and gave up without a final check, so a service that
 * came up exactly at its timeout was ready for one caller and not-ready for
 * another. One helper keeps the deadline arithmetic, the poll interval, and the
 * terminal check identical everywhere.
 *
 * The wait stays bounded: it polls until the deadline, then performs one final
 * probe and returns that result. Returning the last probe rather than a hard
 * `false` is what keeps a service that became ready during the final sleep from
 * being reported as failed, and it means callers never have to re-probe after a
 * timeout to learn the outcome.
 */

/** Gap between readiness probes. Short enough to stay inside typical budgets. */
const PROBE_POLL_INTERVAL_MS = 100;

/** The two members every ensure step's dependency bundle already carries. */
export interface ProbeWaitDeps {
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Resolve true once `deps.probe` reports healthy, polling until `timeoutMs`
 * elapses and then returning the outcome of one last probe.
 */
export async function waitForProbe(
  deps: ProbeWaitDeps,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) return deps.probe();
    if (await deps.probe()) return true;
    await deps.sleep(PROBE_POLL_INTERVAL_MS);
  }
}
