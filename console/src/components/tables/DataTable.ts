import React from "react";

export interface ColumnDef<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => React.ReactNode;
  readonly width?: string | undefined;
}

export interface DataTableProps<T> {
  readonly data: readonly T[];
  readonly columns: readonly ColumnDef<T>[];
  readonly keyExtractor: (row: T) => string;
  readonly emptyMessage?: string | undefined;
}

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  emptyMessage = "No items to display."
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

  return React.createElement(
    "div",
    {
      className:
        "overflow-x-auto rounded-lg border border-border bg-surface/60 shadow"
    },
    React.createElement(
      "table",
      {
        className: "min-w-full divide-y divide-border text-left text-sm"
      },
      React.createElement(
        "thead",
        { className: "bg-background/60 text-fg-muted font-medium" },
        React.createElement(
          "tr",
          null,
          columns.map((col) =>
            React.createElement(
              "th",
              {
                key: col.id,
                scope: "col",
                className: "px-4 py-3 text-xs uppercase tracking-wider",
                style: col.width ? { width: col.width } : undefined
              },
              col.header
            )
          )
        )
      ),
      // Cell styles are declared once on the body rather than on every
      // cell: each repeated class string is sent in both the HTML and the RSC
      // payload, and tables are the largest pages the Console renders.
      React.createElement(
        "tbody",
        {
          className:
            "divide-y divide-border text-fg [&>tr>td]:px-4 [&>tr>td]:py-3 [&>tr>td]:whitespace-nowrap"
        },
        data.map((row) =>
          React.createElement(
            "tr",
            { key: keyExtractor(row) },
            columns.map((col) =>
              React.createElement("td", { key: col.id }, col.cell(row))
            )
          )
        )
      )
    )
  );
}
