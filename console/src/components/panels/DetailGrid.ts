import React from "react";

import { SECTION_LABEL_CLASS } from "../ui/text-classes.ts";

/**
 * One definition of how many columns a card row has at each viewport width.
 *
 * The row was hand-written at thirty-two sites with five different spellings,
 * and the disagreement was visible rather than cosmetic: eleven sites took the
 * two-column step at `sm` (640px) and four at `md` (768px), so an operator
 * moving between Agents and Tools at a 700px window saw a two-column row on
 * one page and a single-column stack on another. Three Memory grids started at
 * `grid-cols-2` and never collapsed at all.
 *
 * Every row therefore resolves its columns through this table, so a breakpoint
 * means the same thing on every page by construction:
 *
 * | columns | below `sm` | `sm` | `lg` | `xl` |
 * | ------- | ---------- | ---- | ---- | ---- |
 * | 2       | 1          | 2    | 2    | 2    |
 * | 3       | 1          | 2    | 3    | 3    |
 * | 4       | 1          | 2    | 4    | 4    |
 * | 5       | 1          | 2    | 3    | 5    |
 *
 * Three cards deliberately reach three at `lg` rather than at `sm`, and five
 * reaches five only at `xl`.
 *
 * This paragraph previously gave arithmetic for both steps and flagged itself
 * as unmeasured: a three-up row at 640px "is roughly 170px per card, which
 * wraps the uppercase titles onto three lines", and a four-card row at 768px
 * "was measuring about 158px per card". Both were wrong. Measured in a browser
 * against the three-up rows this ladder governs (`/mcps/[name]`'s state row and
 * `/prompts/[name]`'s card row, which until recently hand-rolled
 * `grid gap-4 md:grid-cols-3` instead of coming through here):
 *
 * | viewport | columns | card width | title lines |
 * | -------- | ------- | ---------- | ----------- |
 * | 640px    | 2       | 268px      | 1           |
 * | 768px    | 2       | 332px      | 1           |
 * | 900px    | 2       | 398px      | 1           |
 * | 1024px   | 3       | 301px      | 1           |
 * | 1440px   | 3       | 363px      | 1           |
 *
 * The card is 268px at 640px rather than 170px -- the 56px rail, the page
 * gutter and the `gap-4` were not all subtracted in the original estimate -- and
 * the uppercase titles never wrapped, at any width, including the narrowest
 * three-up step. So the stated reason for deferring to `lg` does not hold.
 *
 * The ladder is left as it is anyway. Two-up between `md` and `lg` costs
 * nothing that was measured: the titles fit either way, and a 398px card is not
 * worse to read than a 260px one. Changing a shared ladder because its
 * justification turned out to be false would trade a documented decision for an
 * undocumented one; the honest fix is to record that the claim was false, which
 * is what this does.
 */
export type GridColumns = 2 | 3 | 4 | 5;

const GRID_LADDER: Readonly<Record<GridColumns, string>> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
};

/** The shared base: one column until `sm`, then the ladder's step for `columns`. */
export function gridRowClass(
  columns: GridColumns,
  gap: "gap-3" | "gap-4" | "gap-6" = "gap-4"
): string {
  // `items-start` so a row keeps its natural height instead of stretching every
  // card to the tallest one, which leaves a short summary with a tall empty box
  // under it.
  return `grid grid-cols-1 items-start ${gap} ${GRID_LADDER[columns]}`;
}

export interface GridRowProps {
  readonly columns: GridColumns;
  readonly children?: React.ReactNode;
}

export function StatGrid({
  columns,
  children
}: GridRowProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: gridRowClass(columns),
      "data-stat-grid": String(columns)
    },
    children
  );
}

export interface DetailGridProps extends GridRowProps {
  /**
   * Accessible name, for the rare grid that is not already inside a named
   * section.
   *
   * A `<dl>` does not need a name to be usable, and giving it one when its
   * section already carries a heading makes the region announce itself twice:
   * the heading names it on the way in, then the list announces the same thing
   * again. It is worse than redundant when the two wordings differ, because the
   * page then gives one region two names and a reader has to work out which is
   * the heading. So this is optional by design -- omit it wherever the
   * enclosing `<section>` has an `<h2>`/`<h3>` naming the same facts, and supply
   * it only when the grid stands alone.
   */
  readonly label?: string | undefined;
  /**
   * Spacing relative to whatever precedes the grid. The column ladder is
   * shared and not overridable -- that is the whole point -- but how far a
   * grid sits from the control above it is a local decision.
   */
  readonly className?: string | undefined;
}

/**
 * The `<dl>` behind a row of label/value pairs.
 *
 * A definition list is the right structure for a labelled fact and the row it
 * sits in needs no further structure of its own, so this is a `<dl>` rather
 * than the `<div>` the other card rows use.
 */
export function DetailGrid({
  columns,
  label,
  className,
  children
}: DetailGridProps): React.JSX.Element {
  return React.createElement(
    "dl",
    {
      className: `${gridRowClass(columns)}${className === undefined ? "" : ` ${className}`}`,
      ...(label === undefined ? {} : { "aria-label": label }),
      "data-detail-grid": String(columns)
    },
    children
  );
}

export interface DetailValueProps {
  readonly label: string;
  readonly children?: React.ReactNode;
  /**
   * Replaces the value's treatment outright rather than adding to it. The
   * default is monospace because almost every value here is an identifier.
   * Append would be the friendlier API and the wrong one: two calls to the same
   * utility in one attribute do not resolve by attribute order, so appending a
   * `text-xs` onto a base carrying `text-sm` produces a value whose font size
   * depends on the generated stylesheet rather than on the code. Pass `null`
   * for a value that is not text at all -- a status badge or a link, which
   * brings its own typography.
   */
  readonly valueClassName?: string | null | undefined;
  /**
   * Replaces the row's layout, for the one case that needs it: a fact spanning
   * two columns because it is too long to sit in one.
   */
  readonly rowClassName?: string | undefined;
}

/**
 * One labelled fact inside a `DetailGrid`.
 *
 * Four copies of this existed -- in the agent, agents-list, provider and model
 * detail views -- and three of them were byte-identical, so a change to the
 * value's typography had to be made four times and nothing failed when one was
 * missed. The two that had drifted show what drift costs: the agent detail
 * copy had dropped the wrapping rule, and the agents-list copy had grown a
 * `valueClassName: null` escape hatch for values that are not text.
 */
export function DetailValue({
  label,
  children,
  valueClassName,
  rowClassName
}: DetailValueProps): React.JSX.Element {
  const base = "font-mono text-sm text-fg break-words";
  const classes = valueClassName === undefined ? base : valueClassName;
  return React.createElement(
    "div",
    {
      className: `flex min-w-0 flex-col gap-1${rowClassName === undefined ? "" : ` ${rowClassName}`}`
    },
    React.createElement("dt", { className: SECTION_LABEL_CLASS }, label),
    React.createElement(
      "dd",
      classes === null ? null : { className: classes },
      children
    )
  );
}

/**
 * The box a field is drawn in when it needs a border of its own.
 *
 * The same box was written out in three feature views and none of them shared
 * an owner, so the three copies drifted. The tool detail copy labelled its
 * fields with `text-fg-muted block mb-1` and rendered the value in monospace;
 * the MCP copy used a byte-identical label constant under a different name
 * (`CONFIGURATION_LABEL_CLASS`) and dropped `font-mono` from the value; the
 * allowlist `<li>`s added `font-mono text-xs` to the box itself. Moving between
 * a tool and an MCP server therefore changed what a field label looked like,
 * and `DetailValue`'s label -- the one four other detail pages use -- was a
 * third appearance.
 *
 * So the field label has one treatment now, taken from `SECTION_LABEL_CLASS`
 * exactly as `DetailValue` takes it, and the value gets `DetailValue`'s
 * monospace treatment. The box keeps the `rounded border bg-background/40 p-3`
 * shape all three sites had already agreed on.
 */
export const FIELD_BOX_CLASS =
  "rounded border border-border bg-background/40 p-3";

export interface FieldBoxProps {
  readonly label: string;
  readonly children?: React.ReactNode;
  /**
   * Replaces the value's treatment outright, on `DetailValue`'s terms: pass
   * `null` for a value that brings its own typography, such as a status badge
   * or a link, rather than appending a utility that may not resolve.
   */
  readonly valueClassName?: string | null | undefined;
  readonly className?: string | undefined;
}

/**
 * One labelled field inside a box, as a `<dt>`/`<dd>` pair.
 *
 * A labelled fact belongs in a definition list, so the enclosing stack is a
 * `<dl>` and this is the `<div>` that groups one fact's term from its
 * description. The tool and MCP detail views both used to emit
 * `div > span > span` instead, which is neither a definition list nor
 * announced as one.
 */
export function FieldBox({
  label,
  children,
  valueClassName,
  className
}: FieldBoxProps): React.JSX.Element {
  const base = "font-mono text-sm text-fg break-all";
  const classes = valueClassName === undefined ? base : valueClassName;
  return React.createElement(
    "div",
    {
      className: `${FIELD_BOX_CLASS}${className === undefined ? "" : ` ${className}`}`
    },
    React.createElement("dt", { className: SECTION_LABEL_CLASS }, label),
    React.createElement(
      "dd",
      classes === null ? null : { className: classes },
      children
    )
  );
}
