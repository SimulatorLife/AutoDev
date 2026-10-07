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
 * Labels stay at the call site. How a vocabulary reads on one compact form is a
 * presentation choice -- sentence case in the records action row, title case in
 * the injection reports -- and a code with no label falls back to its readable
 * form rather than to the wire key, which is what `?? code` would show.
 */
export interface CodeOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** `superseded_by_newer_evidence` reads as `superseded by newer evidence`. */
function readableCode(code: string): string {
  return code.replaceAll("_", " ");
}

export function codeOptions<T extends string>(
  codes: readonly T[],
  labels?: Readonly<Partial<Record<T, string>>> | undefined
): CodeOption<T>[] {
  return codes.map((code) => ({
    value: code,
    label: labels?.[code] ?? readableCode(code)
  }));
}