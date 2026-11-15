/**
 * The quota poll's decisions about *when* a provider may be read again.
 *
 * A vendor that refuses a quota read says when to try again, in the report's
 * own `state.retryAfter`. Anthropic's OAuth usage endpoint -- the source of
 * Claude's quota -- answered a read with a 429 and a retry an hour away, and
 * the Runtime asked again every sixty seconds for the whole of that hour.
 * Every one of those requests was the request the vendor had just asked us not
 * to make, and Claude's quota stayed unreadable for as long as they kept
 * making it.
 *
 * So the poll waits for the moment a provider's own report named, and a
 * provider that is waiting keeps the entry it had: its state, its error and
 * its retry moment are the report's own words, carried forward unchanged, so
 * the Console can keep saying why the usage is missing while the wait lasts.
 */
import type { QuotaAxiResponse } from "quota-axi";

/**
 * The providers whose last reading was refused and whose retry moment has not
 * arrived yet.
 *
 * A report that names no retry moment gives no instruction about when, so that
 * provider is asked again on the next tick, as it was before.
 */
export function deferredQuotaProviders(
  report: QuotaAxiResponse | null,
  nowMs: number
): ReadonlySet<string> {
  const deferred = new Set<string>();
  for (const entry of report?.providers ?? []) {
    if (entry?.state?.status !== "rate_limited") continue;
    const retryAt = Date.parse(entry.state?.retryAfter ?? "");
    if (!Number.isFinite(retryAt)) continue;
    if (retryAt <= nowMs) continue;
    deferred.add(entry.provider);
  }
  return deferred;
}

/**
 * The providers to read on this tick: every provider the report knows about,
 * except the ones still waiting for their retry moment.
 *
 * The set is closed over the providers the report already carries, which is
 * quota-axi's own provider list for a pinned version. A provider that a later
 * version adds arrives with the first full read after the pin moves.
 */
export function dueQuotaProviders(
  report: QuotaAxiResponse | null,
  deferred: ReadonlySet<string>
): string[] {
  if (report === null) return [];
  const due: string[] = [];
  for (const entry of report.providers) {
    if (deferred.has(entry.provider)) continue;
    due.push(entry.provider);
  }
  return due;
}

/**
 * The next report: the providers that were read, plus the entries of the ones
 * that were not.
 *
 * A deferred provider's own entry is carried forward as it was -- no value is
 * translated, merged or inferred -- so the report still says that the read was
 * refused and when it may be tried again, rather than losing the provider from
 * the report and leaving the Console to show nothing for it.
 */
export function mergeQuotaReports(
  previous: QuotaAxiResponse | null,
  next: QuotaAxiResponse,
  deferred: ReadonlySet<string>
): QuotaAxiResponse {
  if (previous === null || deferred.size === 0) return next;
  const merged = new Map<string, QuotaAxiResponse["providers"][number]>();
  for (const entry of next.providers) merged.set(entry.provider, entry);
  for (const entry of previous.providers) {
    if (!deferred.has(entry.provider)) continue;
    if (merged.has(entry.provider)) continue;
    merged.set(entry.provider, entry);
  }
  return { ...next, providers: [...merged.values()] };
}
