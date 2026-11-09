import { isTransientFailureClass } from "./provider-limits.ts";
import type {
  ControlApiProviderHealth,
  ControlApiSubproviderQuota
} from "./types.ts";

export type ProviderHealthReadiness = "ready" | "unavailable" | "not-observed";

function isFailureOtherPoolOnly(
  health: ControlApiProviderHealth,
  pools: readonly ControlApiSubproviderQuota[] | undefined
): boolean {
  if (!Array.isArray(pools) || pools.length === 0) return false;
  const failedPool =
    health.lastFailure?.pool ??
    (health.lastFailure?.model
      ? (pools.find((pool) => pool.models.includes(health.lastFailure!.model!))
          ?.pool ?? null)
      : null);
  if (failedPool == null) return false;
  return pools.some(
    (pool) =>
      pool.pool !== failedPool &&
      (pool.status === "available" ||
        pool.status === "warning" ||
        pool.status === "unlimited") &&
      !pool.cooldown &&
      !health.poolCooldowns?.[pool.pool]
  );
}

/**
 * Whether a failure has stopped being live evidence.
 *
 * A transient failure is live while the Runtime is still cooling the provider
 * down for it, and stops being live once that cooldown has passed: the Runtime
 * will route to the provider again, so the failure no longer speaks for it.
 * A provider with no positive evidence at all -- it has never served a request
 * and never passed a check -- has nothing to fall back on, so its failure stands.
 */
function isFailureExpiredTransient(
  health: ControlApiProviderHealth,
  lastSuccessAt: number
): boolean {
  if (lastSuccessAt === Number.NEGATIVE_INFINITY) return false;
  if (!isTransientFailureClass(health.lastFailure?.failureClass)) return false;
  const hasActiveCooldown =
    health.cooldown !== null ||
    Boolean(
      health.poolCooldowns && Object.keys(health.poolCooldowns).length > 0
    ) ||
    Boolean(
      health.modelCooldowns && Object.keys(health.modelCooldowns).length > 0
    );
  return !hasActiveCooldown;
}

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
  const failureIsOtherPoolOnly = isFailureOtherPoolOnly(health, quota?.pools);
  const failureIsExpiredTransient = isFailureExpiredTransient(
    health,
    lastSuccessAt
  );
  const lastFailureAt = Math.max(
    health.lastFailure === null ||
      failureIsOtherPoolOnly ||
      failureIsExpiredTransient
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

function timestamp(
  value: string | null,
  invalid: number = Number.NEGATIVE_INFINITY
): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : invalid;
}
