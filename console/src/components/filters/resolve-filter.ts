/**
 * Resolution for bounded URL filters, and the fact to report when one cannot be
 * applied.
 *
 * A list page reads its filters out of the query string, and every one of those
 * values is arbitrary text: a bookmark can outlive the option it names, and a
 * URL can be hand-edited. Each page used to answer an unrecognised value the
 * same way -- substitute the default, then render that default as though the
 * reader had chosen it. `?source=bogus` on `/tools` answered with the whole
 * catalog and the "all" chip drawn as selected; `?kind=bogus` on `/memory` drew
 * a select reading "All Kinds" while the request carried `kind=bogus`. Both
 * pages asserted a state they had not observed, which is the one thing this
 * product never does with a filter it could not honour.
 *
 * The fix is to stop treating a coercion as a resolution. A filter is silent,
 * applied, or *not applied and named*: `resolveFilter` returns the value to
 * apply alongside the request it could not use, and the page renders that fact
 * instead of inventing the missing one.
 */

/** A filter this page was asked to apply and could not. */
export interface UnappliedFilter {
  /** The query key, as it appears in the URL: `source`, `kind`. */
  readonly name: string;
  /** What the URL carried, shortened so it cannot reflow the page. */
  readonly value: string;
}

export interface ResolvedFilter {
  /** The value to apply. The fallback whenever nothing was applied. */
  readonly value: string;
  /** Set only when the URL named a value outside `allowed`. */
  readonly unapplied: UnappliedFilter | null;
}

export interface FilterSpec {
  /** The query key, as it appears in the URL. */
  readonly name: string;
  /**
   * Every value this page accepts. Must contain `fallback`: "all" is a real
   * answer to `?source=all`, not a request for an unknown source.
   */
  readonly allowed: readonly string[];
  /** What to apply when the URL is silent, and when it names nothing accepted. */
  readonly fallback: string;
}

/**
 * Long enough to identify the request, short enough that a pasted query string
 * cannot push the rest of the row off the page.
 */
const MAX_REPORTED_LENGTH = 40;

function shorten(value: string): string {
  return value.length > MAX_REPORTED_LENGTH
    ? `${value.slice(0, MAX_REPORTED_LENGTH - 1)}…`
    : value;
}

export function resolveFilter(
  raw: string | undefined,
  spec: FilterSpec
): ResolvedFilter {
  const requested = (raw ?? "").trim();
  if (requested === "") {
    return { value: spec.fallback, unapplied: null };
  }
  if (spec.allowed.includes(requested)) {
    return { value: requested, unapplied: null };
  }
  return {
    value: spec.fallback,
    unapplied: { name: spec.name, value: shorten(requested) }
  };
}
