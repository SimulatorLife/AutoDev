import type {
  ControlApiMcpRuntimeResponse,
  McpServerResource,
  RuleSyncValidationIssue
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { chipList, StatusChip } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { MONO_ID_LINK_CLASS } from "../../components/ui/text-classes.ts";
import { McpConnectionBadge } from "./runtime-evidence.ts";

/**
 * MCP servers resource view.
 *
 * This view composes two reads that stay separate on purpose. The catalog
 * says what each server *is* -- the canonical RuleSync declaration and the
 * generated role projection. The Runtime's observation says what it has
 * *reached*. A server the Runtime has never seen says "Not observed", and a
 * declared server is never presented as a connected one.
 */

export interface McpsViewProps {
  readonly servers: readonly McpServerResource[];
  /**
   * What the Runtime has observed of the MCP servers it has seen.
   *
   * `null` means the observation read was unavailable, which is a different
   * state from an observation of nothing: the first says the evidence could
   * not be read, the second says the Runtime has seen no MCP server at all.
   * The Runtime's own summary carries the same distinction in its nullable
   * counts, so the page never has to infer one from the other.
   */
  readonly runtime: ControlApiMcpRuntimeResponse | null;
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
  runtime,
  validationIssues,
  sourceValidity
}: McpsViewProps): React.JSX.Element {
  const observations = new Map(
    (runtime?.servers ?? []).map((server) => [server.name, server] as const)
  );
  const columns: ColumnDef<McpServerResource>[] = [
    {
      id: "name",
      header: "Server Name",
      // The primary key of the row and its link target. Measured in the browser
      // at 1440 against the live catalog, the widest server name is
      // `openaiDeveloperDocs` at 161px, so the column needs 193 with the cell's
      // own 32px of padding.
      //
      // Every weight here is sized to the larger of that content budget and the
      // column's own header, and the seven of them now add up to 1118 -- the
      // width the console actually gives this table at a 1440 viewport -- so the
      // table fits its content column and the Connection column is visible
      // without a sideways scroll.
      //
      // They used to add up to 1302 against that same 1118, which is what put
      // the Connection column past the right edge of the content column: the
      // budget was 184px larger than the room it was declared against, so the
      // table scrolled sideways to a column nobody could see. The arithmetic
      // the comment used to carry described a 904px table and the weights
      // described a 1302px one, and the two had never been reconciled -- which
      // is how a column ends up 198px wider than the name it holds.
      //
      // A header that does not fit its column is the one defect the target
      // state names outright; a name that truncates gives itself back on hover
      // and a title.
      weight: 205,
      cell: (server) =>
        React.createElement(
          NavigationLink,
          {
            className: MONO_ID_LINK_CLASS,
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
      // The longest role chip measures 120px and this header measures 135, so
      // the header is the floor: 167 with the cell's own 32px of padding.
      weight: 180,
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
      // Sized against the pill rather than the word: "Canonical" measures
      // 107px with its status dot and padding, against 62px of header text.
      weight: 135,
      cell: (server) =>
        React.createElement(StatusBadge, {
          status: server.declared ? "configured" : "invalid",
          label: server.declared ? "Canonical" : "Missing"
        })
    },
    {
      id: "default-state",
      header: "Default State",
      // Sized for the badge, not for the header. "Not observed" measures 128px
      // as a badge -- status dot, gap and padding -- against 59px of header. A
      // measurement that reads only the badge's label span reports 78px here
      // and calls the column fine while the pill is cut 8px on every row.
      //
      // 160 is that badge with the cell's own 32px of padding.
      weight: 155,
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
      // adds its own 32px of padding, so 114. "STDIO" is only 74. At 95 the
      // header ran into "OVERRIDES" with no gap between the two.
      weight: 125,
      cell: (server) => server.transport.toUpperCase()
    },
    {
      id: "targets",
      header: "Overrides",
      // This is the column that yields, and it yields on purpose.
      //
      // The seven columns cannot all have what they want. Measured, their needs
      // are 193px for this table's primary key and 165px for the widest target
      // chip, while their own headers need another 743px between them, and that
      // comes to 100.2% of the table at 1440. Something has to give, and this
      // is the cheapest thing to give up: `antigravity-cli` truncates to about
      // 143px and the full `target: enabled` is on the chip's title, whereas a
      // header rendering as an ellipsis is the one layout defect the target
      // state names outright, and the guard "no column is narrower than its own
      // header" fails on it.
      //
      // The status dot is what makes the column affordable at all. Spelling the
      // state out made the chip 175px wide; the dot form is 133px, and the state
      // is still on the chip's title and on the dot's own accessible label.
      weight: 125,
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
      // Carries the same "Not observed" badge as Default State, so it needs the
      // same 128px of badge -- and the observed case is wider than that: the
      // pill reads "Runtime health: stale", which measures 156px. 193 holds
      // both with the cell's own 32px of padding.
      weight: 193,
      // The connection claim is the Runtime's, and it is per server: a server
      // the Runtime has observed reports the health it reported, and a server
      // it has never seen stays "Not observed". The cell carries the flag so
      // the claim is readable per row rather than once for the page.
      cell: (server) => {
        const observation = observations.get(server.name);
        return React.createElement(
          "span",
          {
            "data-mcp-connection-observed": observation ? "true" : "false",
            ...(observation
              ? { "data-mcp-runtime-health": observation.health }
              : {})
          },
          React.createElement(McpConnectionBadge, {
            evidence: observation ?? null
          })
        );
      }
    }
  ];

  const observedServers = runtime?.observedServers ?? null;
  const readyServers = runtime?.health?.ready ?? null;

  return React.createElement(
    PageBody,
    {
      feature: "mcps",
      attributes: {
        // The connection claim moved to the rows. The page used to carry one
        // flag for the whole list, which could not say which server the
        // observation belonged to; the cell carries it now, per server.
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
        title: "Observed Servers",
        value: observedServers ?? NOT_OBSERVED_LABEL,
        subtitle:
          observedServers === null
            ? "Runtime observation unavailable"
            : "Reached by the Runtime"
      }),
      React.createElement(StatCard, {
        title: "Runtime Health",
        value:
          readyServers === null
            ? NOT_OBSERVED_LABEL
            : readyServers === 0
              ? "None ready"
              : `${String(readyServers)} ready`,
        subtitle:
          readyServers === null
            ? "No runtime observation"
            : "Runtime's own verdict"
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
