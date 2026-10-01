import React, { useState } from "react";

import type { ToolCatalogItem } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { type ColumnDef, DataTable } from "../../components/tables/DataTable.ts";

export interface ToolsViewProps {
  readonly tools: readonly ToolCatalogItem[];
}

export function ToolsView({ tools }: ToolsViewProps): React.JSX.Element {
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const filtered = tools.filter((t) =>
    sourceFilter === "all" ? true : t.source === sourceFilter
  );

  const nativeCount = tools.filter((t) => t.source === "native").length;
  const mcpCount = tools.filter((t) => t.source === "mcp").length;
  const pluginCount = tools.filter((t) => t.source === "plugin").length;

  const columns: ColumnDef<ToolCatalogItem>[] = [
    {
      id: "name",
      header: "Tool Name",
      cell: (tool) =>
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: "font-semibold text-slate-100 font-mono" },
            tool.name
          ),
          tool.description
            ? React.createElement(
                "p",
                { className: "text-xs text-slate-400 mt-0.5" },
                tool.description
              )
            : null
        )
    },
    {
      id: "source",
      header: "Source",
      cell: (tool) =>
        React.createElement(
          "span",
          {
            className: `text-xs px-2 py-0.5 rounded font-mono border ${
              tool.source === "mcp"
                ? "bg-cyan-950/60 text-cyan-300 border-cyan-800"
                : tool.source === "native"
                  ? "bg-emerald-950/60 text-emerald-300 border-emerald-800"
                  : "bg-purple-950/60 text-purple-300 border-purple-800"
            }`
          },
          `${tool.source} ${tool.server ? `(${tool.server})` : ""}`.trim()
        )
    },
    {
      id: "exposedRoles",
      header: "Exposed Roles",
      cell: (tool) =>
        React.createElement(
          "div",
          { className: "flex flex-wrap gap-1" },
          tool.exposedRoles.map((r) =>
            React.createElement(
              "span",
              {
                key: r,
                className:
                  "text-xs bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700"
              },
              r
            )
          ),
          tool.exposedRoles.length === 0
            ? React.createElement(
                "span",
                { className: "text-xs text-slate-500" },
                "Universal"
              )
            : null
        )
    },
    {
      id: "status",
      header: "Status",
      cell: (tool) =>
        React.createElement(StatusBadge, { status: tool.status ?? "ready" })
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "tools" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-4 gap-4" },
      React.createElement(StatCard, { title: "Total Tools", value: tools.length }),
      React.createElement(StatCard, { title: "Native Tools", value: nativeCount }),
      React.createElement(StatCard, { title: "MCP Tools", value: mcpCount }),
      React.createElement(StatCard, { title: "Plugin Tools", value: pluginCount })
    ),
    React.createElement(
      "div",
      { className: "flex items-center justify-between" },
      React.createElement(
        "h2",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-400"
        },
        "Effective Tool Catalog"
      ),
      React.createElement(
        "div",
        {
          className:
            "flex items-center gap-1.5 bg-slate-900 border border-slate-800 p-1 rounded-lg"
        },
        ["all", "native", "mcp", "plugin"].map((src) =>
          React.createElement(
            "button",
            {
              key: src,
              type: "button",
              onClick: () => setSourceFilter(src),
              className: `px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                sourceFilter === src
                  ? "bg-slate-800 text-emerald-400"
                  : "text-slate-400 hover:text-slate-200"
              }`
            },
            src
          )
        )
      )
    ),
    DataTable({
      data: filtered,
      columns,
      keyExtractor: (t: ToolCatalogItem) => t.name
    })
  );
}
