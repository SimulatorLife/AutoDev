import { isTransientFailureClass } from "./provider-limits.ts";
import type { ControlApiProviderHealth } from "./types.ts";

export type ProviderHealthReadiness = "ready" | "unavailable" | "not-observed";

/**
 * The failure class of a provider whose account has to be signed in again.
 *
 * A browser-driven provider (the opencli web-chat sites) serves through the
 * operator's own signed-in browser, so a signed-out site -- or a Google account
 * without the Gemini app -- is not an outage the provider recovers from by
 * itself: it waits for the operator. The bridge reports it under this code
 * from its health endpoint, its model listing and its turns, and the Runtime
 * records it under this class wherever it records a provider failure.
 */
export const SIGN_IN_REQUIRED_FAILURE_CLASS = "sign_in_required";

/**
 * Whether the provider is unavailable because its account must be signed in
 * again: its health reads unavailable, and the evidence that decides it is a
 * sign-in -- the active cooldown when there is one (it is the Runtime's live
 * verdict), otherwise the newer of its last failure and a failed check. A
 * provider that recovered since, or failed for another reason after, is not
 * reported as needing a sign-in.
 */
export function providerSignInRequired(
  health: ControlApiProviderHealth | null
): boolean {
  if (health === null || providerHealthReadiness(health) !== "unavailable")
    return false;
  if (health.cooldown !== null)
    return health.cooldown.failureClass === SIGN_IN_REQUIRED_FAILURE_CLASS;
  const failures = [
    health.lastFailure === null
      ? null
      : {
          at: timestamp(health.lastFailure.at),
          failureClass: health.lastFailure.failureClass
        },
    health.lastCheck === null || health.lastCheck.ok
      ? null
      : {
          at: timestamp(health.lastCheck.at),
          failureClass: health.lastCheck.failureClass
        }
  ].filter((failure) => failure !== null);
  const latest = failures.sort((a, b) => b.at - a.at)[0];
  return latest?.failureClass === SIGN_IN_REQUIRED_FAILURE_CLASS;
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
      health.modelCooldowns && Object.keys(health.modelCooldowns).length > 0
    );
  return !hasActiveCooldown;
}

export function providerHealthReadiness(
  health: ControlApiProviderHealth | null
): ProviderHealthReadiness {
  if (health === null) return "not-observed";
  if (health.cooldown !== null) return "unavailable";
  const check = health.lastCheck;
  const lastSuccessAt = Math.max(
    timestamp(health.lastSuccessAt),
    check?.ok ? timestamp(check.at) : Number.NEGATIVE_INFINITY
  );
  const failureIsExpiredTransient = isFailureExpiredTransient(
    health,
    lastSuccessAt
  );
  const lastFailureAt = Math.max(
    health.lastFailure === null || failureIsExpiredTransient
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
