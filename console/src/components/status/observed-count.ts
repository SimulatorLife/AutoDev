import { NOT_OBSERVED_LABEL } from "./StatusBadge.ts";

/**
 * A count that may not have been observed.
 *
 * The target state's state-correctness rule is that a missing measurement stays
 * explicit: never synthesize a zero because the telemetry is absent. A count is
 * where that rule bites hardest, because the number is exactly right for the
 * elements that were observed and merely incomplete for the ones that were not.
 * An incomplete count rendered as a number is a measurement nobody made, and the
 * operator cannot tell it apart from a measured one -- the two differ only in
 * a claim the number does not carry.
 *
 * So a count is a number only when everything it counts was observed. Otherwise
 * it is not observed, and the caller says how much was missing.
 */
export interface ObservedCount {
  /** The counted value, or null when it was not observed. */
  readonly value: number | null;
  /** True when the count was observed. */
  readonly observed: boolean;
}

/**
 * One measurement, and whether it was taken.
 *
 * `null` and `undefined` both mean "not observed" here: they are what a read
 * that failed, or a read that was never issued, arrives as. Neither is a zero,
 * and neither may be rendered as one.
 */
export function observedTotal(value: number | null | undefined): ObservedCount {
  return value === null || value === undefined
    ? { value: null, observed: false }
    : { value, observed: true };
}

/**
 * A count over a scope of elements, and whether that scope was observed in full.
 */
export interface ScopedCount extends ObservedCount {
  /** How many observed elements of the scope satisfy the counted property. */
  readonly value: number;
  /** How many elements of the scope could not be observed at all. */
  readonly unobserved: number;
}

/**
 * Count the elements of `scope` that satisfy `satisfies`.
 *
 * An element that was not observed is counted as missing rather than as a
 * failure of the property, because "nobody looked" is not "the answer was no".
 * The `value` is therefore a lower bound whenever `observed` is false, which is
 * exactly why `countValue` refuses to show it as the scope's count.
 */
export function scopedCount<T>(
  scope: readonly T[],
  isObserved: (item: T) => boolean,
  satisfies: (item: T) => boolean
): ScopedCount {
  let value = 0;
  let unobserved = 0;
  for (const item of scope) {
    if (!isObserved(item)) {
      unobserved += 1;
      continue;
    }
    if (satisfies(item)) value += 1;
  }
  return { value, unobserved, observed: unobserved === 0 };
}

/**
 * The value a count renders as: the number when it was observed, and the shared
 * "Not observed" label when it was not.
 */
export function countValue(count: ObservedCount): string | number {
  return count.observed && count.value !== null
    ? count.value
    : NOT_OBSERVED_LABEL;
}
