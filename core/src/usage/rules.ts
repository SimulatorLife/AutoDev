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
