/**
Derive the share of logical routed requests with a source-confirmed context
compaction. Callers provide counts from the same historical scope and range.
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
Derive the share of logical routed requests that changed the provider
serving the agent. Callers provide counts from the same historical scope and
range.

A hop is a logical request, so more hops than logical requests would mean
the two counts describe different things; the rate is then not observed
rather than a number nobody can act on.
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

/**
Derive launch success rate (`started / (started + rejected + failedBeforeStart)`),
keeping pre-start admission/launch failures distinct from post-start work
outcomes (`succeeded / failed / cancelled`).
*/
export function deriveAgentLaunchSuccessRatePercent(
  started: number | null,
  rejected: number | null,
  failedBeforeStart: number | null
): number | null {
  if (
    started === null ||
    rejected === null ||
    failedBeforeStart === null ||
    !Number.isSafeInteger(started) ||
    !Number.isSafeInteger(rejected) ||
    !Number.isSafeInteger(failedBeforeStart) ||
    started < 0 ||
    rejected < 0 ||
    failedBeforeStart < 0
  ) {
    return null;
  }
  const resolved = started + rejected + failedBeforeStart;
  if (resolved <= 0) return null;
  return (started / resolved) * 100;
}
