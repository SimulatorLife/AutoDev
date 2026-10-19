import type { ControlApiProviderHealth } from "./types.ts";

export type ProviderHealthReadiness = "ready" | "unavailable" | "not-observed";

/**
 * Derive provider readiness only from Runtime evidence of a successful request
 * that is not superseded by a later failure or an active cooldown/probe failure.
 * A configured route with no successful observation is not proof of health.
 */
export function providerHealthReadiness(
  health: ControlApiProviderHealth | null
): ProviderHealthReadiness {
  if (health === null) return "not-observed";
  if (health.cooldown !== null || health.probeFailureStreak > 0) {
    return "unavailable";
  }

  const lastSuccessAt =
    health.lastSuccessAt === null
      ? Number.NaN
      : Date.parse(health.lastSuccessAt);
  if (!Number.isFinite(lastSuccessAt)) {
    return health.lastFailure === null ? "not-observed" : "unavailable";
  }

  if (health.lastFailure !== null) {
    const lastFailureAt = Date.parse(health.lastFailure.at);
    if (!Number.isFinite(lastFailureAt) || lastFailureAt > lastSuccessAt) {
      return "unavailable";
    }
  }
  return "ready";
}
