import type { McpServerResource } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

const NOT_OBSERVED_STATUS = "not-observed" as const;

/**
 * MCP servers resource view.
 *
 * This view combines canonical RuleSync declarations with role exposure, but
 * connection state remains unobserved until a Runtime probe reports it. Only
 * explicit target overrides are shown; missing entries are not inferred.
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
      cell: (server) =>
        React.createElement(
          "a",
          {
            className: "font-semibold text-fg font-mono hover:text-accent",
            href: `/mcps/${encodeURIComponent(server.name)}`
          },
          server.name
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
                  "text-xs bg-surface-raised text-fg-secondary px-2 py-0.5 rounded border border-border-strong"
              },
              r
            )
          )
        )
    },
    {
      id: "declaration",
      header: "RuleSync Declaration",
      cell: (server) =>
        React.createElement(StatusBadge, {
          status: server.declared ? "configured" : "invalid",
          label: server.declared ? "Canonical" : "Missing"
        })
    },
    {
      id: "default-state",
      header: "Default State",
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
      cell: (server) => server.transport.toUpperCase()
    },
    {
      id: "targets",
      header: "Explicit Target Overrides",
      cell: (server) =>
        server.targetOverrides.length === 0
          ? "None"
          : server.targetOverrides
              .map(
                ({ target, enabled }) =>
                  `${target}: ${enabled ? "enabled" : "disabled"}`
              )
              .join(", ")
    },
    {
      id: "status",
      header: "Connection",
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
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
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
            className:
              "text-sm font-semibold uppercase tracking-wider text-fg-muted"
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
      DataTable({
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
