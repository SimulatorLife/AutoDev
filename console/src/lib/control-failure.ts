/**
 * One vocabulary for "this mutation did not land".
 *
 * Every Console mutation is a server-rendered form POST, so the browser is
 * navigated to whatever the route returns. A route that answers a failed
 * submission with a JSON body therefore dumps `{"error": ...}` into the
 * operator's browser, outside the Console shell and with no way back. Instead a
 * route redirects to the page it came from carrying this flag, and that page
 * renders a notice.
 *
 * The flag deliberately says only "could not be confirmed". A mutation route
 * cannot claim what happened: the refreshed value it redirects to is the
 * authoritative answer, so the notice must not invent a more specific outcome.
 */

/** Query flag a mutation route sets when a change could not be confirmed. */
export const CONTROL_FAILED_PARAM = "control";
const CONTROL_FAILED_VALUE = "failed";

/**
 * Query flag carrying *why* a submission was refused, for the cases where the
 * route knows.
 *
 * The flag above deliberately says only "could not be confirmed", and that is
 * right for the ordinary mutation: the refreshed value the redirect lands on is
 * the authoritative answer, so the notice must not invent an outcome. But
 * "must not invent" is not "must withhold a known fact". A purge refused because
 * the confirmation was not given is a different situation from one the Runtime
 * turned down, and the operator's next move differs completely -- tick the box,
 * versus do not retry because durable memory still cites this envelope. Told
 * only "could not be confirmed", the first operator retries the identical
 * request.
 *
 * So the route carries a code, never a message. A code cannot reflect attacker
 * text into the page, cannot drift from what the route means by it, and cannot
 * be used to claim an outcome the route did not observe.
 */
export const CONTROL_REFUSAL_PARAM = "refusal";
export const CONTROL_REFUSAL_REASONS = [
  "confirmation_missing",
  "reason_not_accepted",
  "reason_required",
  "claim_required",
  "content_required",
  "prior_required",
  "evidence_required",
  "provenance_required",
  // The Runtime rejected the request as invalid, and said so in the code. Not
  // the same as `runtime_refused`, which claims no reason was given: this one
  // names one, and it names one the operator can do nothing about, because the
  // body was assembled by the route rather than typed into the form.
  "request_invalid",
  "runtime_refused",
  // What the Runtime itself said, by code. Each asks for a different next move,
  // so one sentence cannot cover them.
  "still_cited",
  "conflicted",
  "not_found",
  "forbidden",
  "unavailable",
  // The Runtime accepted the request and the work then failed. Distinct from
  // `runtime_refused`, which means it declined without saying why: here it did
  // say, and the answer is a failure rather than a refusal, so retrying is the
  // next move instead of looking for something in the form to correct.
  "operation_failed"
] as const;
export type ControlRefusalReason = (typeof CONTROL_REFUSAL_REASONS)[number];

export function withControlFailure(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${CONTROL_FAILED_PARAM}=${CONTROL_FAILED_VALUE}`;
}

/** Attach the refusal flag to a redirect, with the reason the route observed. */
export function withControlRefusal(
  path: string,
  reason: ControlRefusalReason
): string {
  return `${withControlFailure(path)}&${CONTROL_REFUSAL_PARAM}=${reason}`;
}

/**
 * The refusal reason a redirect carried, or `undefined` when it carried none or
 * carried something this build does not recognise. An unrecognised value is
 * treated as absent rather than rendered: the generic notice is still true.
 */
export function readControlRefusal(
  raw: string | readonly string[] | undefined
): ControlRefusalReason | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (CONTROL_REFUSAL_REASONS as readonly string[]).includes(value ?? "")
    ? (value as ControlRefusalReason)
    : undefined;
}

export function isControlFailure(
  raw: string | readonly string[] | undefined
): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === CONTROL_FAILED_VALUE;
}
