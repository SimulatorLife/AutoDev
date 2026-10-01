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
  readonly onRowClick?: ((row: T) => void) | undefined;
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
          "p-8 text-center text-slate-400 bg-slate-900/40 rounded-lg border border-slate-800"
      },
      React.createElement("p", { className: "text-sm" }, emptyMessage)
    );
  }

  return React.createElement(
    "div",
    {
      className:
        "overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60 shadow"
    },
    React.createElement(
      "table",
      {
        className:
          "min-w-full divide-y divide-slate-800 text-left text-sm"
      },
      React.createElement(
        "thead",
        { className: "bg-slate-950/60 text-slate-400 font-medium" },
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
      React.createElement(
        "tbody",
        { className: "divide-y divide-slate-800 text-slate-200" },
        data.map((row) => {
          const key = keyExtractor(row);
          const isClickable = Boolean(onRowClick);
          return React.createElement(
            "tr",
            {
              key,
              onClick: onRowClick ? () => onRowClick(row) : undefined,
              className: `transition-colors ${
                isClickable
                  ? "cursor-pointer hover:bg-slate-800/50"
                  : "hover:bg-slate-850"
              }`
            },
            columns.map((col) =>
              React.createElement(
                "td",
                {
                  key: col.id,
                  className: "px-4 py-3 whitespace-nowrap"
                },
                col.cell(row)
              )
            )
          );
        })
      )
    )
  );
}
