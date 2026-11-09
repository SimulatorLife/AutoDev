/**
 * Derive the share of logical routed requests with a source-confirmed context
 * compaction. Callers provide counts from the same historical scope and range.
 */
export function deriveContextCompactionRatePercent(
  compactions: number | null,
  logicalRequests: number | null
): number | null {
  if (
    compactions === null ||
    logicalRequests === null ||
    !Number.isSafeInteger(compactions) ||
    !Number.isSafeInteger(logicalRequests) ||
    compactions < 0 ||
    logicalRequests <= 0 ||
    compactions > logicalRequests
  ) {
    return null;
  }
  return (compactions / logicalRequests) * 100;
}

/**
 * Derive the share of logical routed requests that changed the provider
 * serving the agent. Callers provide counts from the same historical scope and
 * range.
 *
 * A hop is a logical request, so more hops than logical requests would mean
 * the two counts describe different things; the rate is then not observed
 * rather than a number nobody can act on.
 */
export function deriveProviderHopRatePercent(
  hops: number | null,
  logicalRequests: number | null
): number | null {
  if (
    hops === null ||
    logicalRequests === null ||
    !Number.isSafeInteger(hops) ||
    !Number.isSafeInteger(logicalRequests) ||
    hops < 0 ||
    logicalRequests <= 0 ||
    hops > logicalRequests
  ) {
    return null;
  }
  return (hops / logicalRequests) * 100;
}
