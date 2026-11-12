/**
 * Canonical classification of provider failure classes and limit scopes across
 * Core, Runtime, and Console.
 */

/**
 * Hard limit failure classes: the provider is completely out of quota
 * or session allowance until its declared window resets.
 */
export const PROVIDER_HARD_LIMIT_CLASSES = Object.freeze([
  "quota_exhausted",
  "session_limit"
] as const);

export type ProviderHardLimitClass =
  (typeof PROVIDER_HARD_LIMIT_CLASSES)[number];

/**
 * The failure classes that describe a condition which passes with time or cooldown.
 *
 * A rate limit, a throttle, a busy upstream, a timeout, a 5xx: each of them was
 * true of one request and is not a standing fact about the provider. The
 * Runtime already treats them that way -- it cools the provider down for the
 * failure and routes to it again once the cooldown has passed.
 *
 * Deliberately absent are standing facts: `authentication` (requires credential fix)
 * and request refusals (`invalid_model`, `unsupported_request`, `request_error`).
 */
export const PROVIDER_TRANSIENT_FAILURE_CLASSES = Object.freeze([
  "capacity",
  "cooldown",
  "overloaded",
  "quota_exhausted",
  "rate_limit",
  "session_limit",
  "throttled",
  "timeout",
  "transient",
  "unavailable",
  "upstream_error"
] as const);

export type ProviderTransientFailureClass =
  (typeof PROVIDER_TRANSIENT_FAILURE_CLASSES)[number];

export function isHardLimitClass(
  failureClass: string | null | undefined
): boolean {
  return (
    typeof failureClass === "string" &&
    (PROVIDER_HARD_LIMIT_CLASSES as readonly string[]).includes(failureClass)
  );
}

export function isTransientFailureClass(
  failureClass: string | null | undefined
): boolean {
  return (
    typeof failureClass === "string" &&
    (PROVIDER_TRANSIENT_FAILURE_CLASSES as readonly string[]).includes(
      failureClass
    )
  );
}
