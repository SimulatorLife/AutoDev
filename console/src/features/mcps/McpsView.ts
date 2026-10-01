import React from "react";

import type { McpRoleExposure } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { type ColumnDef, DataTable } from "../../components/tables/DataTable.ts";

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
      header: "Status",
      cell: () => React.createElement(StatusBadge, { status: "ready", label: "Connected" })
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "mcps" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, {
        title: "Configured MCPs",
        value: servers.length
      }),
      React.createElement(StatCard, {
        title: "Active Shims",
        value: servers.length,
        subtitle: "tools/call monitored"
      }),
      React.createElement(StatCard, {
        title: "Health",
        value: "100%",
        subtitle: "All servers available"
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
        keyExtractor: (s: McpRoleExposure) => s.server
      })
    )
  );
}
