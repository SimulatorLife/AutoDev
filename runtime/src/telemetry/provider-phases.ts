/**
 * Where a provider bridge's turn spent its time, reported on the response it
 * returns so the router -- the one owner of AutoDev's OpenTelemetry -- can
 * record it on the attempt it already measures.
 *
 * A web-chat bridge's turn is mostly two waits: for a free browser tab, and
 * for the site to answer. The router sees only their sum, so without this the
 * Usage view cannot tell tab contention from a slow model. Bridges own no
 * telemetry SDK; this field is the whole contract between them and the router.
 */

/** The response field a bridge writes and the router reads. */
export const PROVIDER_PHASES_FIELD = "autodev_phases";

export interface ProviderPhaseTiming {
  /** Time the turn waited for the provider to take it (a free tab). */
  queuedMs: number;
  /** Time the provider spent on the turn once it had it. */
  onSiteMs: number;
}

/** The wire form a bridge puts on its response object. */
export function providerPhasesField(
  timing: ProviderPhaseTiming
): Record<
  typeof PROVIDER_PHASES_FIELD,
  { queued_ms: number; on_site_ms: number }
> {
  return {
    [PROVIDER_PHASES_FIELD]: {
      queued_ms: Math.round(timing.queuedMs),
      on_site_ms: Math.round(timing.onSiteMs)
    }
  };
}

function durationMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The phases a response reports, or null when it reports none or a malformed
 * value. An unreported phase stays unknown rather than becoming zero.
 */
export function providerPhasesFromResponse(
  response: unknown
): ProviderPhaseTiming | null {
  if (!response || typeof response !== "object") return null;
  const raw = (response as Record<string, unknown>)[PROVIDER_PHASES_FIELD];
  if (!raw || typeof raw !== "object") return null;
  const queuedMs = durationMs((raw as Record<string, unknown>).queued_ms);
  const onSiteMs = durationMs((raw as Record<string, unknown>).on_site_ms);
  return queuedMs === null || onSiteMs === null ? null : { queuedMs, onSiteMs };
}
