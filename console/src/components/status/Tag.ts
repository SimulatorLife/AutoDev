/**
 * Console tag shapes.
 *
 * A tag is a small atomic label: a provider name, a model id, a record kind, a
 * workflow trigger. It carries no interactive behaviour and no state — when an
 * element shows a state it is a status badge, not a tag.
 *
 * The tag family had drifted into at least five geometries: horizontal padding
 * at `px-1`, `px-1.5` and `px-2`; font size at `text-xs` and `text-micro`; and
 * borders appearing and disappearing. The result was visible inside a single
 * table row, where a tag in one column sat next to a differently sized tag in
 * the next. `TAG_SHAPE` is the one shape; colour, monospace and truncation stay
 * with the caller because those carry meaning rather than form.
 *
 * This is deliberately *not* the same shape as `StatusBadge`'s. A badge is a
 * state word and is fully rounded to read as a pill; a tag is an identifier or
 * category and is squared to a 4px radius so the two never read as the same
 * kind of thing in a dense table.
 */
export const TAG_SHAPE =
  "inline-flex w-fit max-w-full items-center whitespace-nowrap rounded border px-2 py-0.5 text-xs";
