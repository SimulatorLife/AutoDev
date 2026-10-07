/**
 * The Console's one definition of what a filter control looks like.
 *
 * These two constants moved out of the components that first needed them because
 * a filter row assembled from two spellings of the same control reads as two
 * products. `/usage`'s custom date range spelled its label group inline, and the
 * Evaluations window needed the identical grouping beside its selects; the
 * control chrome itself already had three importers through `SelectField`, which
 * is a component's constant being used as a stylesheet.
 *
 * Keeping them here rather than in either component also means a caller does not
 * have to know which component owns the vocabulary: a text input, a date input
 * and a select in the same bar all take the same two constants.
 */

/**
 * Shared control chrome for form inputs and selects.
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
 */
export const FIELD_CONTROL_CLASS =
  "appearance-none rounded border border-border-strong bg-input pl-3 pr-8 py-1.5 text-sm text-fg-secondary transition-colors hover:border-fg-muted disabled:cursor-not-allowed disabled:opacity-60 max-w-full min-w-0";

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
