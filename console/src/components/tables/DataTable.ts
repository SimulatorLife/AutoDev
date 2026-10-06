import React from "react";

import { EmptyState } from "../status/EmptyState.ts";

/**
 * How a cell lays out its content inside the column.
 *
 * - `truncate` (default): one line, ellipsis when it does not fit. A cell
 *   whose content is a plain string gets a `title` carrying the whole value,
 *   so the ellipsis never becomes the only copy. A cell built from elements
 *   owns its own recovery -- a chip or badge titles itself, and a link's
 *   destination carries the value.
 * - `tokens`: discrete items (chips, links, badges) that wrap onto new lines
 *   between items. Individual tokens are never split mid-token, so a model id
 *   or environment variable stays readable.
 * - `prose`: flowing sentences that wrap on word boundaries.
 */
export type ColumnAlign = "truncate" | "tokens" | "prose";

export interface ColumnDef<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => React.ReactNode;
  /**
   * Relative share of the table's width. Weights are resolved to
   * percentages of the table's own width, so a table always fills its
   * container and a column set that is too wide shrinks proportionally
   * instead of pushing the table into a horizontal scroll.
   *
   * Absolute lengths cannot work here: with `table-layout: fixed` the browser
   * treats a declared `width` as a hard minimum and grows the table past its
   * container rather than scaling it down.
   */
  readonly weight?: number | undefined;
  readonly align?: ColumnAlign | undefined;
  /** Clamp `prose` cells to this many lines. Requires `align: "prose"`. */
  readonly clampLines?: number | undefined;
}

export interface DataTableProps<T> {
  readonly data: readonly T[];
  readonly columns: readonly ColumnDef<T>[];
  readonly keyExtractor: (row: T) => string;
  readonly emptyMessage?: string | undefined;
  readonly onRowClick?: ((row: T) => void) | undefined;
}

/**
 * Width share granted to a `tokens` column when the view does not declare one.
 * Below roughly this share a list of chips degrades into one chip per line,
 * which turns a dense operator table into a wall of vertical stacks.
 *
 * These defaults are expressed on the same scale the views author weights on
 * (a declared weight is roughly the column's share in pixels). A default that
 * was much smaller would leave every undeclared column as a sliver next to a
 * column that declared a few hundred units.
 */
const TOKENS_COLUMN_WEIGHT = 170;

/**
 * Weight granted to a column that declares nothing: enough for a short label
 * plus its cell padding.
 */
const DEFAULT_COLUMN_WEIGHT = 100;

/**
 * Highest floor any table may demand.
 *
 * A floor is a legibility limit, not a target: it exists so a table scrolls
 * when the window genuinely cannot give its columns room. Deriving the floor
 * from the weight sum alone made it the table's *natural* width, so any table
 * whose columns wanted even a little more than the page offered scrolled at
 * full desktop width — a 26px scroll on a 1440px window, with no small-screen
 * cause.
 *
 * The cap sits below the tightest layout the Console actually produces, which
 * is not the narrowest viewport: at 1280 the sidebar is still expanded, so the
 * content column measures about 901px, and at 1024 the rail leaves about 877px.
 * A cap under both keeps every table scroll-free at those widths; below them the
 * region scrolls as intended.
 */
const TABLE_FLOOR_CEILING_PX = 54 * 16;

/**
 * Floor for the table itself, derived from the weights this table declares.
 *
 * The table takes the full width of its wrapper but never squeezes below the
 * budget its own columns were measured for. Below it the table region scrolls
 * horizontally instead of shrinking every column: badges truncate, chips wrap
 * one per line, and headers break mid-word long before they are legible.
 * Scrolling keeps every cell readable; crushing it does not.
 *
 * The floor is per table rather than one constant for the whole Console
 * because the columns differ: a four-column table declares far less total
 * weight than the eight-column MCP table, so a shared floor would give the
 * narrow one a scrollbar at desktop widths for twelve pixels of nothing while
 * the wide one still needed it. Weights are authored on roughly a pixel-per-unit
 * scale, so their sum is the width the columns were measured at.
 */
function tableMinWidthPx(columns: readonly ColumnDef<never>[]): number {
  const natural = columns.reduce(
    (sum, column) => sum + columnWeight(column),
    0
  );
  return Math.min(natural, TABLE_FLOOR_CEILING_PX);
}

function cellClassName(column: ColumnDef<never>): string {
  const align = column.align ?? "truncate";
  if (align === "tokens") return "whitespace-normal break-normal";
  if (align === "prose") return "whitespace-normal break-words";
  return "truncate";
}

/**
 * Clamp classes written out in full rather than interpolated into a class
 * name: Tailwind only emits rules for class strings it can see in the source,
 * so a dynamically built `line-clamp-${n}` would ship without any CSS.
 */
const LINE_CLAMP_CLASSES: Readonly<Record<number, string>> = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6"
};

/**
 * Line clamp for a `prose` cell.
 *
 * `-webkit-line-clamp` only takes effect on a box display, so the clamp is
 * applied to a wrapper *inside* the cell rather than to the `<td>` itself: a
 * clamped table cell stops laying out as a table cell and the row height stops
 * tracking the content. Returns `null` when the column is not clamped, or when
 * it asks for a line count this component has no class for.
 */
function proseClampClass(column: ColumnDef<never>): string | null {
  if ((column.align ?? "truncate") !== "prose") return null;
  if (column.clampLines === undefined) return null;
  return LINE_CLAMP_CLASSES[Math.trunc(column.clampLines)] ?? null;
}

/** Effective width share for a column. */
function columnWeight(column: ColumnDef<never>): number {
  if (column.weight !== undefined && column.weight > 0) return column.weight;
  return (column.align ?? "truncate") === "tokens"
    ? TOKENS_COLUMN_WEIGHT
    : DEFAULT_COLUMN_WEIGHT;
}

/**
 * The hover text for a truncating cell that holds nothing but a string.
 *
 * Returns `undefined` for anything else. An element cell already carries its
 * own recovery -- `Chip` titles itself, a link holds the value in its
 * destination -- and titling the cell as well would either duplicate that or,
 * worse, invent text that does not match what the element shows.
 */
function truncatingCellTitle(
  column: ColumnDef<never>,
  content: React.ReactNode
): string | undefined {
  const truncates = (column.align ?? "truncate") === "truncate";
  // An empty cell needs no title; `title=""` is a tooltip with nothing in it.
  const text = typeof content === "string" && content.length > 0 ? content : "";
  return truncates ? text || undefined : undefined;
}

/**
 * Resolve every column to a percentage of the table width. Percentages are
 * relative, so the table keeps filling its container at any viewport size and
 * a column set that needs more room than is available shrinks proportionally
 * rather than overflowing.
 */
function columnWidths(columns: readonly ColumnDef<never>[]): string[] {
  const weights = columns.map((column) => columnWeight(column));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Rounded so the emitted markup stays readable and stable; the last column
  // absorbs the rounding remainder so the shares still total 100%.
  const rounded = weights.map(
    (weight) => Math.round((weight / total) * 10_000) / 100
  );
  const last = rounded.length - 1;
  rounded[last] =
    Math.round(
      (100 - rounded.slice(0, last).reduce((sum, value) => sum + value, 0)) *
        100
    ) / 100;
  return rounded.map((value) => `${value}%`);
}

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  emptyMessage = "No items to display.",
  onRowClick
}: DataTableProps<T>): React.JSX.Element {
  if (data.length === 0) {
    return React.createElement(EmptyState, {
      message: emptyMessage,
      testId: "table"
    });
  }

  const widths = columnWidths(columns as readonly ColumnDef<never>[]);
  const clamps = columns.map((col) => proseClampClass(col as ColumnDef<never>));

  return React.createElement(
    "div",
    {
      className:
        "overflow-x-auto rounded-lg border border-border bg-surface/60 shadow"
    },
    React.createElement(
      "table",
      {
        // Fixed layout plus percentage widths keeps the table inside its
        // container at every viewport: columns hold their declared ratio and
        // shrink proportionally when the set needs more room than is
        // available. The inline floor is derived from this table's own weights
        // rather than authored, so it stays correct when a view rebalances.
        className:
          "w-full table-fixed divide-y divide-border text-left text-sm",
        style: {
          minWidth: `${tableMinWidthPx(columns as readonly ColumnDef<never>[])}px`
        }
      },
      React.createElement(
        "thead",
        { className: "bg-background/60 text-fg-muted font-medium" },
        React.createElement(
          "tr",
          null,
          columns.map((col, index) =>
            React.createElement(
              "th",
              {
                key: col.id,
                scope: "col",
                // A header is a label, not a value: it wraps rather than
                // truncating. Column widths are relative, so at a narrower
                // viewport a single header can lose the few pixels it needs to
                // fit on one line, and "CONVERGEN…" tells an operator less than
                // two short lines do.
                //
                // It wraps at word boundaries only. `break-words` was letting a
                // single-word header split mid-word -- "CONVERGENC E" -- which
                // reads as a rendering fault rather than as a label. A label
                // that genuinely cannot fit its column is a width problem, and
                // the width is the column's `weight`; the header refuses to
                // paper over it.
                className:
                  "px-4 py-2.5 text-xs uppercase leading-tight tracking-wider break-normal",
                style: { width: widths[index] }
              },
              col.header
            )
          )
        )
      ),
      React.createElement(
        "tbody",
        { className: "divide-y divide-border text-fg" },
        data.map((row) => {
          const key = keyExtractor(row);
          const isClickable = Boolean(onRowClick);
          return React.createElement(
            "tr",
            {
              key,
              onClick: onRowClick ? () => onRowClick(row) : undefined,
              className: `transition-colors ${
                isClickable ? "cursor-pointer hover:bg-hover" : ""
              }`
            },
            columns.map((col, index) => {
              const content = col.cell(row);
              const clamp = clamps[index];
              const hover = truncatingCellTitle(col, content);
              return React.createElement(
                "td",
                {
                  key: col.id,
                  className: `px-4 py-3 align-top ${cellClassName(
                    col as ColumnDef<never>
                  )}`,
                  style: { width: widths[index] },
                  // Truncation removes information, so a truncating cell that
                  // holds nothing but text keeps the whole value on its hover
                  // title. Without this the operator's only copy of a 60-
                  // character scope is the first 20 pixels of it. Element
                  // content is left alone: a chip or badge titles itself, and
                  // a link already carries the value in its destination, so
                  // titling here would either duplicate or invent text.
                  ...(hover === undefined ? {} : { title: hover })
                },
                clamp === null
                  ? content
                  : React.createElement("div", { className: clamp }, content)
              );
            })
          );
        })
      )
    )
  );
}
