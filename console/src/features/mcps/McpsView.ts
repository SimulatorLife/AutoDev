import type { McpServerResource } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { Chip, chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

const NOT_OBSERVED_STATUS = "not-observed" as const;

/**
 * MCP servers resource view.
 *
 * This view combines canonical RuleSync declarations with configured role
 * assignments, but connection state remains unobserved until a Runtime probe
 * reports it. Only explicit target overrides are shown; missing entries are
 * not inferred.
 */

export interface McpsViewProps {
  readonly servers: readonly McpServerResource[];
  readonly sourceValidity: boolean | null;
}

export function McpsView({
  servers,
  sourceValidity
}: McpsViewProps): React.JSX.Element {
  const columns: ColumnDef<McpServerResource>[] = [
    {
      id: "name",
      header: "Server Name",
      weight: 150,
      cell: (server) =>
        React.createElement(
          "a",
          {
            className:
              "block truncate font-semibold text-fg font-mono hover:text-accent",
            href: `/mcps/${encodeURIComponent(server.name)}`,
            title: server.name
          },
          server.name
        )
    },
    {
      id: "roles",
      header: "Configured roles",
      align: "tokens",
      weight: 192,
      cell: (server) =>
        chipList({
          items: server.roles,
          emptyLabel: "No roles assigned",
          testId: "mcp-roles"
        })
    },
    {
      id: "declaration",
      header: "RuleSync",
      weight: 110,
      cell: (server) =>
        React.createElement(StatusBadge, {
          status: server.declared ? "configured" : "invalid",
          label: server.declared ? "Canonical" : "Missing"
        })
    },
    {
      id: "default-state",
      header: "Default State",
      weight: 152,
      cell: (server) =>
        React.createElement(StatusBadge, {
          status: server.enabled === null ? NOT_OBSERVED_STATUS : "configured",
          label:
            server.enabled === null
              ? "Unknown"
              : server.enabled
                ? "Enabled"
                : "Disabled"
        })
    },
    {
      id: "transport",
      header: "Transport",
      weight: 130,
      cell: (server) => server.transport.toUpperCase()
    },
    {
      id: "targets",
      header: "Overrides",
      weight: 224,
      align: "tokens",
      cell: (server) =>
        server.targetOverrides.length === 0
          ? React.createElement("span", { className: MUTED_META_CLASS }, "None")
          : chipList({
              items: server.targetOverrides.map(
                ({ target, enabled }) =>
                  `${target}: ${enabled ? "enabled" : "disabled"}`
              ),
              emptyLabel: "None",
              testId: "mcp-target-overrides",
              renderItem: (override) =>
                React.createElement(Chip, { className: "font-mono" }, override)
            })
    },
    {
      id: "status",
      header: "Connection",
      weight: 130,
      cell: () =>
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Not observed"
        })
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "mcps",
      "data-mcp-connection-observed": "false",
      "data-mcp-source-validity":
        sourceValidity === null ? NOT_OBSERVED_STATUS : String(sourceValidity)
    },
    React.createElement(
      StatGrid,
      { columns: 3 },
      React.createElement(StatCard, {
        title: "Configured MCPs",
        value:
          sourceValidity === true
            ? servers.length
            : sourceValidity === false
              ? "Invalid"
              : "Not observed",
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
        "div",
        { className: "mb-3 flex items-center justify-between gap-3" },
        React.createElement(
          "h2",
          {
            className: SECTION_HEADING_CLASS
          },
          "Model Context Protocol Servers"
        ),
        React.createElement(StatusBadge, {
          status:
            sourceValidity === null
              ? NOT_OBSERVED_STATUS
              : sourceValidity
                ? "valid"
                : "invalid",
          label:
            sourceValidity === null
              ? "Source not observed"
              : sourceValidity
                ? "RuleSync source valid"
                : "RuleSync source invalid"
        })
      ),
      sourceValidity === false
        ? React.createElement(
            "p",
            { className: "mb-3 text-sm text-error", role: "alert" },
            "RuleSync `.rulesync/mcp.jsonc` is invalid; no MCP configuration was projected."
          )
        : null,
      React.createElement<DataTableProps<McpServerResource>>(DataTable, {
        data: servers,
        columns,
        keyExtractor: (server: McpServerResource) => server.name,
        emptyMessage:
          sourceValidity === null
            ? "RuleSync `.rulesync/mcp.jsonc` was not found."
            : sourceValidity === false
              ? "No MCP servers can be shown until the canonical source is valid."
              : "No MCP servers configured in RuleSync `.rulesync/mcp.jsonc`."
      })
    )
  );
}
