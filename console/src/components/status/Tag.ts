import React from "react";

/**
 * Console tags.
 *
 * A tag is a small atomic label: a provider name, a model id, a record kind, a
 * workflow trigger. It carries no interactive behaviour and no state — when an
 * element shows a state it is a status badge, not a tag.
 *
 * The tag family had drifted into at least five geometries: horizontal padding
 * at `px-1`, `px-1.5` and `px-2`; font size at `text-xs` and `text-micro`; and
 * borders appearing and disappearing. The result was visible inside a single
 * table row, where a tag in one column sat next to a differently sized tag in
 * the next. `TAG_SHAPE` is the one shape; colour and typography stay with the
 * caller because those carry meaning rather than form.
 *
 * This is deliberately *not* the same shape as `StatusBadge`'s. A badge is a
 * state word and is fully rounded to read as a pill; a tag is an identifier or
 * category and is squared to a 4px radius so the two never read as the same
 * kind of thing in a dense table.
 */
export const TAG_SHAPE =
  // `whitespace-nowrap` is implied by `truncate` and is spelled out anyway,
  // because it is a decision rather than a default: a chip that breaks
  // mid-identifier trades one defect for another, and the earlier fix for a
  // crowded row was `flex-wrap` on the row, not letting the chip squish. Stated
  // here so the next reader sees the rule instead of inferring it from a
  // shorthand.
  "block max-w-full truncate whitespace-nowrap rounded border px-2 py-0.5 text-xs";

/**
 * A tag, which titles itself.
 *
 * Two things make this a component rather than a class constant callers compose.
 *
 * First, truncation. A tag is wider than a narrow table cell sooner than it looks,
 * because its content is an identifier with no spaces to break at. Capped by
 * `max-w-full` it used to be cut by whatever contained it, and because
 * `inline-flex` blockifies to `flex` as a flex item, `text-overflow` did not
 * apply — so the cut carried no ellipsis and no marker at all. Measured on
 * `/github` at 390px: the `workflow_dispatch` trigger chip was capped at 116px
 * against a 131px identifier and rendered the name cut mid-word. The shape is now
 * a block box, which is what makes the ellipsis work, so every tag is visibly cut
 * rather than silently sliced.
 *
 * Second, recovery. Fourteen call sites were assembling the same shape by hand,
 * and a title has to be added per site, so it was added at none of them -- the
 * same failure as composing `NOT_OBSERVED_LABEL` inline and leaving the constant
 * decorative. One component owns the pair.
 *
 * A title on a tag that happens to fit is redundant rather than wrong: it repeats
 * the visible text on hover, which is what `Chip` already does in this product.
 */
/**
 * The wrap variant's shape.
 *
 * `TAG_SHAPE` truncates because a tag is an identifier: `workflow_dispatch` cut
 * at an ellipsis still names the workflow trigger, and a broken line inside it
 * would not. A chip that carries a *reading* rather than an identifier is
 * different, because a reading has more than one part and losing the tail loses
 * one of them. An evaluation metric rendered `tool_failures: 4 · Fai…` is not a
 * shorter metric, it is a metric whose verdict -- the only part of it that says
 * whether the run passed -- is gone.
 *
 * So this shape drops `truncate`/`whitespace-nowrap` for `break-words`. The chip
 * still wraps between items in its container; it can additionally break onto a
 * second line rather than cutting itself, which is the `tokens` align's own
 * documented behaviour for a token too wide for its cell.
 */
const TAG_WRAP_SHAPE =
  "block max-w-full whitespace-normal break-words rounded border px-2 py-0.5 text-xs";

export interface TagProps {
  /** The identifier or category. Also becomes the title. */
  readonly children: string;
  /** Colour and typography only; the shape is not the caller's to change. */
  readonly className?: string | undefined;
  /**
   * Let the chip's own text break instead of truncating.
   *
   * For a chip that carries a measurement. The default truncates, which is right
   * for an identifier whose prefix still identifies it and wrong for a reading
   * whose tail is a separate piece of the same fact.
   */
  readonly wrap?: boolean | undefined;
  /**
   * Overrides the title. Pass `null` for a tag whose visible text is its own
   * answer and whose tooltip would add nothing.
   */
  readonly title?: string | null | undefined;
  /** Extra attributes, for state flags the Console asserts on. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

export function Tag({
  children,
  className,
  wrap = false,
  title,
  dataAttributes
}: TagProps): React.JSX.Element {
  return React.createElement(
    "span",
    {
      className: `${wrap ? TAG_WRAP_SHAPE : TAG_SHAPE}${className === undefined ? "" : ` ${className}`}`,
      ...(title === null ? {} : { title: title ?? children }),
      "data-tag": "true",
      ...dataAttributes
    },
    children
  );
}
