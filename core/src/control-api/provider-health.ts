import type { ControlApiProviderHealth } from "./types.ts";

export type ProviderHealthReadiness = "ready" | "unavailable" | "not-observed";

/**
 * Derive provider readiness only from Runtime evidence: a successful request,
 * or a passing operator check, that is not superseded by a later failure (of a
 * request or of a check) or an active cooldown/probe failure. A configured
 * route with no successful observation is not proof of health.
 */
export function providerHealthReadiness(
  health: ControlApiProviderHealth | null
): ProviderHealthReadiness {
  if (health === null) return "not-observed";
  if (health.cooldown !== null || health.probeFailureStreak > 0) {
    return "unavailable";
  }
  const check = health.lastCheck;
  const lastSuccessAt = Math.max(
    timestamp(health.lastSuccessAt),
    check?.ok ? timestamp(check.at) : Number.NEGATIVE_INFINITY
  );
  const lastFailureAt = Math.max(
    health.lastFailure === null
      ? Number.NEGATIVE_INFINITY
      : timestamp(health.lastFailure.at, Number.POSITIVE_INFINITY),
    check && !check.ok ? timestamp(check.at) : Number.NEGATIVE_INFINITY
  );
  if (lastSuccessAt === Number.NEGATIVE_INFINITY) {
    return lastFailureAt === Number.NEGATIVE_INFINITY
      ? "not-observed"
      : "unavailable";
  }
  return lastFailureAt > lastSuccessAt ? "unavailable" : "ready";
}

/**
 * Milliseconds for an ISO time, or `invalid` when it is absent or unreadable.
 * An unreadable failure time counts as the latest evidence, as it always has.
 */
function timestamp(
  value: string | null,
  invalid: number = Number.NEGATIVE_INFINITY
): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : invalid;
}
