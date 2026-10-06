/**
 * The one owner of "what do I print about a value I caught?".
 *
 * Every `catch` in the Runtime has to turn an `unknown` into something a human
 * can act on. That decision was being re-made at every catch site, and it had
 * already drifted into three textual forms: a private helper in three modules,
 * an inline ternary in dozens, and a second inline spelling that interpolates
 * the thrown value instead of calling `String` on it.
 *
 * Those spellings happen to agree -- inside a template literal `${x}` *is*
 * `String(x)` -- so this is about ownership rather than a behaviour fix. What
 * it buys is that the next person adding a catch site picks up one named
 * decision instead of choosing between three, and that the choice is stated in
 * a single place instead of being re-derived from whatever the neighbouring
 * line happens to look like.
 *
 * `String(error)` is deliberate for the non-Error branch, not an oversight: a
 * thrown value is not always an `Error`, and stringifying whatever was thrown
 * is the only way to keep the detail.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
