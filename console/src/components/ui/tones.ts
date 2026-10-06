/**
 * The one owner of the Console's status tones.
 *
 * A tone is the background/text/border trio a state-coloured element wears at
 * 15% background and 40% border opacity. These five literals were written out
 * sixteen times across five files: three times inside the status badge's own
 * variant map, where `valid`, `ready` and `converged` each spelled out the same
 * success trio, and the rest at call sites that decided a tone inline.
 *
 * Naming them once means the badge map can say what it means -- `valid:
 * SUCCESS_TONE`, `ready: SUCCESS_TONE` -- instead of repeating three strings
 * that merely happen to agree, and a call site that picked the wrong tone
 * becomes a wrong identifier rather than an invisible one-character typo in a
 * class string.
 *
 * These deliberately mirror the semantic colour tokens in `app/globals.css`
 * rather than inventing opacity tokens: the tone is the token colour at a fixed
 * emphasis, which is why the family is expressed here instead of as five more
 * theme variables that could be combined incorrectly. An element that needs a
 * different emphasis -- a hover state, or the warning background at 10% that
 * `EnablementToggle` uses -- keeps its own class, because that difference is
 * carrying meaning rather than repeating a convention.
 */
export const ACCENT_TONE_CLASS = "bg-accent/15 text-accent border-accent/40";

export const SUCCESS_TONE_CLASS =
  "bg-success/15 text-success border-success/40";

export const ERROR_TONE_CLASS = "bg-error/15 text-error border-error/40";

export const WARNING_TONE_CLASS =
  "bg-warning/15 text-warning border-warning/40";

export const NEUTRAL_TONE_CLASS =
  "bg-neutral/15 text-neutral border-neutral/40";