/**
 * Select options for a vocabulary the Runtime validates.
 *
 * Every bounded vocabulary in this feature -- evidence kinds, reason codes,
 * outcome kinds, report kinds, use kinds -- is defined in Core and checked
 * against it by the Runtime. The Console only *offers* it. So the values here
 * come from Core's list and never from a local copy: a form offering its own
 * spelling can offer something the Runtime refuses, and cannot offer something
 * it just gained, and nothing fails until an operator reaches for it.
 *
 * Labels are required and exhaustive, and that is the point. A fallback that
 * prettified an unknown code (`superseded_by_newer_evidence` becoming
 * `superseded by newer evidence`) looked safe and was not: for a single-word
 * code it hands back the wire key itself, so `used` and `success` render raw —
 * which this repo has tests forbidding. Requiring a complete
 * `Record<T, string>` turns "Core gained a code the Console has no word for"
 * into a typecheck failure instead, which is the only version of that change
 * anyone actually wants to notice.
 */
export interface CodeOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function codeOptions<T extends string>(
  codes: readonly T[],
  labels: Readonly<Record<T, string>>
): CodeOption<T>[] {
  return codes.map((code) => ({ value: code, label: labels[code] }));
}
