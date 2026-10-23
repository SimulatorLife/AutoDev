/**
 * The Console's one definition of what a filter control looks like.
 *
 * These constants moved out of the components that first needed them because
 * a filter row assembled from two spellings of the same control reads as two
 * products. `/usage`'s custom date range spelled its label group inline, and the
 * Evaluations window needed the identical grouping beside its selects; the
 * control chrome itself already had three importers through `SelectField`, which
 * is a component's constant being used as a stylesheet.
 *
 * Keeping them here rather than in either component also means a caller does not
 * have to know which component owns the vocabulary: a text input, a date input
 * and a select in the same bar all take the same chrome.
 *
 * The chrome is one thing; the cursor is another, and it is the one property
 * that differs by role. A select opens a list, a text field takes a caret, a
 * checkbox toggles -- so each has its own constant below, and the shared chrome
 * carries none of them.
 */

/**
 * Shared control chrome for form inputs.
 *
 * Exported so a date or text input in the same filter bar matches a select
 * beside it; a filter row with two different control weights reads as two
 * different products.
 *
 * `max-w-full min-w-0` makes every control shrinkable. A native select's
 * intrinsic width comes from its widest option, so a select labelled with a
 * long workspace id or model name used to push its row past the viewport and
 * take the Apply button with it. The constraints apply only when the control
 * would otherwise be wider than the space it is given.
 *
 * This is the *input* chrome, and it is deliberately not the chrome of every
 * control. The cursor is the one property that differs by role, so it is not on
 * this constant: a select opens a list, a text field takes a caret, and a
 * button acts. One shared string could only ever spell one of those, and
 * spelling it for the most common case gave the other two the wrong one.
 */
export const FIELD_CONTROL_CLASS =
  "appearance-none rounded border border-border-strong bg-input pl-3 pr-8 py-1.5 text-sm text-fg-secondary transition-colors hover:border-fg-muted disabled:cursor-not-allowed disabled:opacity-60 max-w-full min-w-0";

/**
 * A select is a target: clicking it opens a list of choices.
 *
 * The Console fixed this for buttons -- "the cursor is the primary signal that a
 * thing is clickable" -- and never applied the same rule to the control the
 * button vocabulary was copied from. Every select in the product rendered with
 * the default arrow while carrying the Console's own drawn chevron and a border
 * that reads as a target, so the pointer contradicted the chrome on the page
 * where an operator chooses a role priority, a model, a workspace or a date
 * range.
 *
 * The disabled cursor already lived on the shared chrome: a disabled control is
 * still a target, and says so.
 */
export const SELECT_CONTROL_CLASS = `${FIELD_CONTROL_CLASS} cursor-pointer`;

/**
 * A text field takes text: the caret is the affordance.
 *
 * `appearance-none` removes the platform widget but not the caret, so this
 * states the intent rather than relying on the browser's default for an input
 * whose chrome the Console replaced.
 */
export const TEXT_CONTROL_CLASS = `${FIELD_CONTROL_CLASS} cursor-text`;

/**
 * The Console's one checkbox.
 *
 * There were five checkboxes in the product and they did not agree about
 * anything: three sizes (a native default, 14px, and 16px), two chromes (the
 * platform widget and a hand-written `rounded border bg-input` box that no
 * other checkbox wore), and two accents -- one of them `accent-error`, which
 * painted a confirmation box in the destructive colour even though the box was
 * confirming rather than destroying anything.
 *
 * None of them showed the pointer, so every one of them contradicted its own
 * chrome: a square that reads as a target and answers with the arrow.
 *
 * `size-4` is 16px, the size the Console's own largest checkbox already used.
 * The clickable region is the whole label, which `CheckboxField` gives a 24px
 * minimum so the target meets the same floor the link chips meet.
 */
export const CHECKBOX_CONTROL_CLASS =
  "size-4 shrink-0 cursor-pointer rounded border border-border-strong bg-input accent-accent transition-colors hover:border-fg-muted disabled:cursor-not-allowed disabled:opacity-60";

/**
 * The destructive accent, for a box that confirms an irreversible action.
 *
 * The box itself is not the destructive thing -- confirming a purge is -- so
 * the colour belongs to the confirmation the operator is making, not to the
 * control. It is opt-in for that reason: an accent that appears on every
 * checkbox is not a signal about anything.
 */
export const CHECKBOX_DESTRUCTIVE_CLASS = "accent-error";

/**
 * The label-and-control pair a bare `<input>` needs to sit in a filter bar.
 *
 * `SelectField` and `FilterSearchField` render their own markup, so this exists
 * for the controls that have no component: the date inputs on `/usage`'s custom
 * range and on `/evaluations`' run-time window. Without it those two each
 * spelled the grouping themselves, and a third surface would have picked
 * whichever it had copied.
 */
export const FIELD_GROUP_CLASS =
  "flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-fg-muted";
