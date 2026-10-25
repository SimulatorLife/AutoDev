/**
 * The Console's one definition of a state-coloured button.
 *
 * A control that shows a state and can change it is a button wearing a status
 * colour: the agent enablement pill and the model enablement pill are the same
 * control, and they were the same control written twice -- the same chrome
 * string, the same three tones, and the same paragraph explaining why the
 * hover strengthens the border instead of tinting the fill. Two features
 * changing the same vocabulary is how they drift apart.
 *
 * They had also drifted already: the two spellings of the chrome were
 * identical, and neither of them carried a pointer cursor, so a control that
 * shows a state and takes a click still pointed at nothing. The pointer is the
 * primary signal that a thing is clickable, and the shared button vocabulary
 * carries it for every other control in the Console.
 *
 * `warning/10` is deliberately not `WARNING_TONE_CLASS`'s `/15`: the hover
 * state here strengthens the border instead of tinting the fill, because a
 * heavier translucent background pulls the status text below the WCAG AA
 * contrast floor, and a pill that becomes unreadable on hover is not a hover
 * state. See the family note in `components/ui/tones.ts`.
 */

/** The three states a state-coloured button can show. */
export type StatePillTone = "on" | "off" | "unknown";

export const STATE_PILL_TONE_CLASS = {
  on: "bg-success/15 text-success border-success/60 hover:border-success/70",
  off: "bg-warning/10 text-warning border-warning/60 hover:border-warning/70",
  unknown: "bg-neutral/15 text-fg-muted border-neutral/60"
} as const;

/**
 * The chrome every state-coloured button wears, whatever it is about.
 *
 * A disabled button keeps the not-allowed cursor: the control is still a
 * target, and saying so is more useful than an arrow that claims it is not.
 *
 * `min-h-6` is the 24px floor of WCAG 2.5.8, and it belongs here for the same
 * reason it belongs on the link chips: this pill is a *button*, not a piece of
 * prose, and a button is an inline-block box, so `min-height` applies to it and
 * the floor is real rather than decorative. Without it the pill measured 22px --
 * `text-xs` on a 16px line, plus `py-0.5` and the border -- and the control
 * that enables and disables an agent role was the smallest target on the page.
 */
export const STATE_PILL_BUTTON_CLASS =
  "inline-flex min-h-6 items-center whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium transition-colors cursor-pointer disabled:cursor-not-allowed";

/**
 * The accessible name for a state-coloured button.
 *
 * The pill wears the item's current state and activates the opposite, so one
 * control carries both -- and the name has to carry both as well.
 *
 * A name that carried only the action said what the control would do and
 * nothing about the state it was in: every agent row's enablement pill
 * announced "Disable browser-tester", "Disable default", "Disable explorer",
 * and a screen reader could not tell an enabled agent from a disabled one,
 * because the visible word -- the state -- was overridden by the label. The
 * name therefore begins with the visible word and then names the action and
 * the thing the action applies to.
 *
 * That also keeps the visible label inside the accessible name, which is what
 * WCAG 2.5.3 asks for and what voice control needs: a person who says the word
 * they can see has to find the control that says it.
 */
export function statePillName(stateLabel: string, detail: string): string {
  return `${stateLabel}: ${detail}`;
}
