import type { McpRoleExposure } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

/**
 * MCP servers resource view.
 *
 * Until the MCPJam-style connection probe/runtime telemetry adapter exists, we
 * must NOT report `Connected` or `100%`. A configured server is only that:
 * configured. Actual connection state is `unknown` until a runtime probe
 * reports it.
 */

export interface McpsViewProps {
  readonly servers: readonly McpRoleExposure[];
}

export function McpsView({ servers }: McpsViewProps): React.JSX.Element {
  const columns: ColumnDef<McpRoleExposure>[] = [
    {
      id: "name",
      header: "Server Name",
      cell: (server) =>
        React.createElement(
          "span",
          { className: "font-semibold text-slate-100 font-mono" },
          server.server
        )
    },
    {
      id: "roles",
      header: "Exposed Roles",
      cell: (server) =>
        React.createElement(
          "div",
          { className: "flex flex-wrap gap-1" },
          server.roles.map((r) =>
            React.createElement(
              "span",
              {
                key: r,
                className:
                  "text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700"
              },
              r
            )
          )
        )
    },
    {
      id: "status",
      header: "Connection",
      cell: () =>
        React.createElement(StatusBadge, {
          status: "unavailable",
          label: "Unknown"
        })
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "mcps",
      "data-mcp-connection-observed": "false"
    },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, {
        title: "Configured MCPs",
        value: servers.length,
        subtitle: "RuleSync declaration"
      }),
      React.createElement(StatCard, {
        title: "Active Shims",
        value: "Not observed",
        subtitle: "Awaiting runtime probe"
      }),
      React.createElement(StatCard, {
        title: "Health",
        value: "Unknown",
        subtitle: "No runtime probe yet"
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
        },
        "Model Context Protocol Servers"
      ),
      DataTable({
        data: servers,
        columns,
        keyExtractor: (s: McpRoleExposure) => s.server,
        emptyMessage:
          "No MCP servers configured. RuleSync `.rulesync/mcp.jsonc` is the canonical source."
      })
    )
  );
}
