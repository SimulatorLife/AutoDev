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

export function withControlFailure(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${CONTROL_FAILED_PARAM}=${CONTROL_FAILED_VALUE}`;
}

/** Mark a redirect target being built with the flag. */
export function markControlFailure(url: URL): void {
  url.searchParams.set(CONTROL_FAILED_PARAM, CONTROL_FAILED_VALUE);
}

export function isControlFailure(
  raw: string | readonly string[] | undefined
): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === CONTROL_FAILED_VALUE;
}
