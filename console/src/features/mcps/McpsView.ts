import type {
  McpServerResource,
  RuleSyncValidationIssue
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { chipList, StatusChip } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";

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
  /**
   * Why the source is invalid.
   *
   * Required rather than defaulted to `[]`: the page renders an empty server
   * list on an invalid source, so without the reasons it says "no servers" for
   * a file that declares some and could not be applied. The loader has already
   * located the fault.
   */
  readonly validationIssues: readonly RuleSyncValidationIssue[];
}

export function McpsView({
  servers,
  validationIssues,
  sourceValidity
}: McpsViewProps): React.JSX.Element {
  const columns: ColumnDef<McpServerResource>[] = [
    {
      id: "name",
      header: "Server Name",
      // The primary key of the row, and the link target. It was declared at 150,
      // tied with the RuleSync declaration column and below `Configured roles`,
      // so at the table's 864px floor -- what every viewport under 864 sees --
      // it resolved to 105px against roles' 135. Measured at 390px, every server
      // name rendered as eight characters plus an ellipsis: `cocoind…`,
      // `codegra…`, `openaiD…`.
      //
      // 163 is not 230 any more, and the reason is arithmetic rather than taste.
      // Measured in the browser, each of the seven columns needs this much of the
      // 864px floor: 84 for this one's own header, 120 for the longest role chip,
      // 123 for the "Canonical" pill, 144 for each "Not observed" pill, 114 for
      // "TRANSPORT" -- which is wider than the cell it labels -- and 108 for
      // "OVERRIDES". That is 793px before this column gets a pixel, so it takes
      // the 111px that is left. A header that does not fit its column is the one
      // defect the target state names outright; a name that truncates gives
      // itself back on hover and a title.
      weight: 163,
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
      weight: 177,
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
      // "Canonical" is a 91px pill and needs 123px of column at the table's
      // 864px floor. Sized against the pill rather than the word: the word is
      // 55px, which is what an earlier measurement read.
      weight: 181,
      cell: (server) =>
        React.createElement(StatusBadge, {
          status: server.declared ? "configured" : "invalid",
          label: server.declared ? "Canonical" : "Missing"
        })
    },
    {
      id: "default-state",
      header: "Default State",
      // Sized for the badge, not for the header. "Default State" is the
      // longest header in the table and it still fitted at 152, but the column
      // holds a `StatusBadge` and the longest label that badge ever carries is
      // "Not observed" -- status dot, rounded padding and all, 117px. At 152 the
      // cell granted 109, so every not-observed server's pill was clipped 8px
      // at its right edge on every viewport up to 768. A header-width check
      // cannot see this: the header was never the problem.
      weight: 212,
      cell: (server) =>
        React.createElement(StatusBadge, {
          status: server.enabled === null ? NOT_OBSERVED_STATUS : "configured",
          label:
            server.enabled === null
              ? NOT_OBSERVED_LABEL
              : server.enabled
                ? "Enabled"
                : "Disabled"
        })
    },
    {
      id: "transport",
      header: "Transport",
      // Sized for its own header, which is wider than the cell it labels: nine
      // characters of 12px uppercase with tracking measure 82px, and the cell
      // adds its own 32px of padding, so 114. At 95 the header ran into
      // "OVERRIDES" with no gap between the two and "STDIO" cut to "STD…".
      weight: 168,
      cell: (server) => server.transport.toUpperCase()
    },
    {
      id: "targets",
      header: "Overrides",
      // Sized for its own header, which needs 108px: 76px of text plus the
      // cell's padding. The content would like 162 -- a 130px `antigravity-cli`
      // chip plus padding -- and does not get it, which is the point of the
      // arithmetic on Server Name: this table's seven columns ask for 793px of
      // the 864px floor between them before the primary key takes any, so
      // something has to truncate and this is the column whose loss is cheapest.
      // The status dot is what makes that survivable. The spelled-out state made
      // an `antigravity-cli: enabled` chip 175px wide where `antigravity-cli`
      // with a dot is 130px, and the full `target: enabled` is on the chip's
      // title either way.
      weight: 159,
      align: "tokens",
      cell: (server) =>
        chipList({
          items: server.targetOverrides,
          renderKey: (override) => override.target,
          emptyLabel: "None",
          testId: "mcp-target-overrides",
          renderItem: ({ target, enabled }) =>
            React.createElement(StatusChip, {
              status: enabled ? "valid" : "unavailable",
              stateLabel: enabled ? "Enabled" : "Disabled",
              label: target,
              // The dot carries the state for sighted readers; this is what puts
              // it back for everyone else once the chip truncates.
              title: `${target}: ${enabled ? "enabled" : "disabled"}`
            })
        })
    },
    {
      id: "status",
      header: "Connection",
      // Carries the same "Not observed" pill as Default State, so it needs the
      // same share; at 176 it was cut 11px on every row.
      weight: 212,
      cell: () =>
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: NOT_OBSERVED_LABEL
        })
    }
  ];

  return React.createElement(
    PageBody,
    {
      feature: "mcps",
      attributes: {
        "data-mcp-connection-observed": "false",
        "data-mcp-source-validity":
          sourceValidity === null ? NOT_OBSERVED_STATUS : String(sourceValidity)
      }
    },
    React.createElement(SourceValidationIssues, {
      issues: validationIssues,
      testId: "mcp-validation-issues",
      subject: "MCP source"
    }),
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
              : NOT_OBSERVED_LABEL,
        subtitle: "RuleSync declaration"
      }),
      React.createElement(StatCard, {
        title: "Active Shims",
        value: NOT_OBSERVED_LABEL,
        subtitle: "Awaiting runtime probe"
      }),
      React.createElement(StatCard, {
        title: "Health",
        value: NOT_OBSERVED_LABEL,
        subtitle: "No runtime probe yet"
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { className: "mb-3 flex flex-wrap items-center justify-between gap-3" },
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
