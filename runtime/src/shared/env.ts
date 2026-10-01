/**
 * Parse an optional environment value using `Number.parseInt` semantics,
 * including numeric-prefix acceptance and fractional truncation. Missing,
 * non-finite, and negative values use the provided fallback.
 */
export function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
