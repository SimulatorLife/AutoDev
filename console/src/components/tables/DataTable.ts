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
   * Column width as a CSS length, applied to the header and every body cell.
   *
   * The table uses `table-layout: fixed`, so a declared width is the column's
   * real width and content is laid out inside it instead of expanding the
   * column. Columns without a declared width share whatever horizontal space
   * is left over. This is what keeps a dense operator table inside the page
   * instead of forcing a horizontal scroll at ordinary desktop widths.
   */
  readonly width?: string | undefined;
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
 * Width granted to a `tokens` column when the view does not declare one.
 * Below roughly this width a list of chips degrades into one chip per line,
 * which turns a dense operator table into a wall of vertical stacks.
 */
const TOKENS_COLUMN_WIDTH = "14rem";

/**
 * Floor for the table itself. The table takes the full width of its wrapper,
 * but never squeezes below this, so a narrow window scrolls horizontally
 * instead of crushing every column into an unreadable sliver.
 */
const TABLE_MIN_WIDTH_CLASS = "min-w-[56rem]";

function cellClassName(column: ColumnDef<never>): string {
  const align = column.align ?? "truncate";
  if (align === "tokens") return "whitespace-normal break-normal";
  if (align === "prose") return "whitespace-normal break-words";
  return "truncate";
}

/**
 * Line clamp for a `prose` cell.
 *
 * `-webkit-line-clamp` only takes effect on a box display, so the clamp is
 * applied to a wrapper *inside* the cell rather than to the `<td>` itself: a
 * clamped table cell stops laying out as a table cell and the row height stops
 * tracking the content. Returns `null` when the column is not clamped.
 */
function proseClampClass(column: ColumnDef<never>): string | null {
  if ((column.align ?? "truncate") !== "prose") return null;
  if (column.clampLines === undefined) return null;
  return `line-clamp-${Math.max(1, Math.trunc(column.clampLines))}`;
}

function columnWidth(column: ColumnDef<never>): string | undefined {
  if (column.width !== undefined) return column.width;
  return (column.align ?? "truncate") === "tokens"
    ? TOKENS_COLUMN_WIDTH
    : undefined;
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

  const widths = columns.map((col) => columnWidth(col as ColumnDef<never>));
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
        // Fixed layout keeps the table inside the page: a declared width is a
        // real width, and undeclared columns share the remaining space, so no
        // single long cell can push the table past the viewport.
        className: `w-full ${TABLE_MIN_WIDTH_CLASS} table-fixed divide-y divide-border text-left text-sm`
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
                className:
                  "px-4 py-3 text-xs uppercase tracking-wider truncate",
                style: (() => {
                  const width = widths[index];
                  return width === undefined ? undefined : { width };
                })()
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
                  style: (() => {
                    const width = widths[index];
                    return width === undefined ? undefined : { width };
                  })(),
                  className: `px-4 py-3 align-top ${cellClassName(
                    col as ColumnDef<never>
                  )}`
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
