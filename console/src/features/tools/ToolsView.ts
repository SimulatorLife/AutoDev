"use client";

import type { ToolCatalogItem } from "@simulatorlife/autodev-core";
import React, { useState } from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

/**
 * Partial configuration read model built from the execution contract.
 * It lists explicitly enumerated role MCP/plugin tools and native web-research
 * capabilities; it does not claim to be the complete tool inventory. When the
 * source has no runtime status, configuration presence stays distinct from
 * runtime readiness and the view renders `Unknown`.
 */

export interface ToolsViewProps {
  readonly tools: readonly ToolCatalogItem[];
  readonly coverage: "partial" | "unknown";
}

export function ToolsView({
  tools,
  coverage
}: ToolsViewProps): React.JSX.Element {
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
                "No role attribution"
              )
            : null
        )
    },
    {
      id: "status",
      header: "Availability",
      cell: (tool) =>
        tool.status === "ready"
          ? React.createElement(StatusBadge, { status: "ready" })
          : tool.status === "unavailable"
            ? React.createElement(StatusBadge, { status: "unavailable" })
            : React.createElement(StatusBadge, {
                status: "not-observed",
                label: "Unknown"
              })
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "tools",
      "data-tools-availability-observed": tools.some(
        (t) => t.status === "ready" || t.status === "unavailable"
      )
        ? "true"
        : "false"
    },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-4 gap-4" },
      React.createElement(StatCard, {
        title: "Known Declarations",
        value: coverage === "unknown" ? "Unknown" : tools.length
      }),
      React.createElement(StatCard, {
        title: "Known Native",
        value: coverage === "unknown" ? "Unknown" : nativeCount
      }),
      React.createElement(StatCard, {
        title: "Known MCP",
        value: coverage === "unknown" ? "Unknown" : mcpCount
      }),
      React.createElement(StatCard, {
        title: "Known Plugin",
        value: coverage === "unknown" ? "Unknown" : pluginCount
      })
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
        "Configured Tool Declarations"
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
    React.createElement(
      "p",
      {
        className:
          "rounded border border-amber-900/70 bg-amber-950/30 p-3 text-xs text-amber-200",
        "data-tools-coverage": coverage
      },
      coverage === "unknown"
        ? "The execution-contract role inventory is not observed; tool declarations are unavailable."
        : "Partial configuration projection: explicitly enumerated role MCP/plugin tools and native web-research capabilities only. Other tools, runtime availability, and historical use are not observed."
    ),
    DataTable({
      data: filtered,
      columns,
      keyExtractor: (tool: ToolCatalogItem) =>
        `${tool.source}:${tool.server ?? ""}:${tool.name}`,
      emptyMessage:
        coverage === "unknown"
          ? "Execution-contract tool declarations are not observed."
          : "No tool declarations were enumerated in the current execution contract."
    })
  );
}
