import type { ControlApiProviderHealth } from "./types.ts";

export type ProviderHealthReadiness = "ready" | "unavailable" | "not-observed";

/**
 * Derive provider readiness only from Runtime evidence: a successful request,
 * a passing operator check, or a live quota observation with remaining usage,
 * that is not superseded by a later failure (of a request or of a check), an
 * exhausted quota state, or an active provider-wide cooldown. A configured
 * route with no successful observation is not proof of health.
 */
export function providerHealthReadiness(
  health: ControlApiProviderHealth | null
): ProviderHealthReadiness {
  if (health === null) return "not-observed";
  if (health.cooldown !== null) {
    const isScoped =
      health.cooldown.scope === "pool" || health.cooldown.scope === "model";
    const hasHealthyPool =
      isScoped &&
      Array.isArray(health.quota?.pools) &&
      health.quota.pools.some(
        (pool) =>
          (pool.status === "available" ||
            pool.status === "warning" ||
            pool.status === "unlimited") &&
          !pool.cooldown &&
          !health.poolCooldowns?.[pool.pool]
      );
    if (!hasHealthyPool) {
      return "unavailable";
    }
  }
  const quota = health.quota ?? null;
  if (quota?.status === "ok" && quota.summaryStatus === "exhausted") {
    return "unavailable";
  }
  const check = health.lastCheck;
  const quotaAvailableAt =
    quota?.status === "ok" &&
    (quota.summaryStatus === "available" ||
      quota.summaryStatus === "warning" ||
      quota.summaryStatus === "unlimited")
      ? timestamp(quota.updatedAt)
      : Number.NEGATIVE_INFINITY;
  const lastSuccessAt = Math.max(
    timestamp(health.lastSuccessAt),
    check?.ok ? timestamp(check.at) : Number.NEGATIVE_INFINITY,
    quotaAvailableAt
  );
  const failureIsOtherPoolOnly =
    health.lastFailure?.pool != null &&
    Array.isArray(quota?.pools) &&
    quota.pools.some(
      (pool) =>
        pool.pool !== health.lastFailure?.pool &&
        (pool.status === "available" ||
          pool.status === "warning" ||
          pool.status === "unlimited") &&
        !pool.cooldown &&
        !health.poolCooldowns?.[pool.pool]
    );
  const isRateLimitFailureClass =
    health.lastFailure?.failureClass === "quota_exhausted" ||
    health.lastFailure?.failureClass === "session_limit" ||
    health.lastFailure?.failureClass === "throttled";
  const hasAnyActiveCooldown =
    health.cooldown !== null ||
    Boolean(
      health.poolCooldowns && Object.keys(health.poolCooldowns).length > 0
    ) ||
    Boolean(
      health.modelCooldowns && Object.keys(health.modelCooldowns).length > 0
    );
  const failureIsExpiredRateLimit =
    isRateLimitFailureClass &&
    !hasAnyActiveCooldown &&
    lastSuccessAt > Number.NEGATIVE_INFINITY;
  const lastFailureAt = Math.max(
    health.lastFailure === null ||
      failureIsOtherPoolOnly ||
      failureIsExpiredRateLimit
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
