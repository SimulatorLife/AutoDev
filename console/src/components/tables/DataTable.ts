import React from "react";

/**
 * How a cell lays out its content inside the column.
 *
 * - `truncate` (default): one line, ellipsis when it does not fit. The full
 *   value stays reachable through the row's own detail view.
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
  return columns.reduce((sum, column) => sum + columnWeight(column), 0);
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
    return React.createElement(
      "div",
      {
        className:
          "p-8 text-center text-fg-muted bg-surface/40 rounded-lg border border-border"
      },
      React.createElement("p", { className: "text-sm" }, emptyMessage)
    );
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
                className:
                  "px-4 py-2.5 text-xs uppercase leading-tight tracking-wider break-words",
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
              return React.createElement(
                "td",
                {
                  key: col.id,
                  className: `px-4 py-3 align-top ${cellClassName(
                    col as ColumnDef<never>
                  )}`,
                  style: { width: widths[index] }
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
