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
 */
export const STATE_PILL_BUTTON_CLASS =
  "whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium transition-colors cursor-pointer disabled:cursor-not-allowed";
