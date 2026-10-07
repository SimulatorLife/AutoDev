import type {
  AgentDefinition,
  ControlApiProvidersResponse,
  ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import {
  DetailGrid,
  DetailValue,
  StatGrid
} from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  MONO_VALUE_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { AgentProviderSummary } from "./AgentProviderSummary.ts";

const NOT_OBSERVED_STATUS = "not-observed";

export interface AgentsViewProps {
  readonly agents: readonly AgentDefinition[];
  readonly providers?: ControlApiProvidersResponse | undefined;
  readonly runtime?: ControlApiRuntimeResponse | undefined;
}

export function AgentsView({
  agents,
  providers,
  runtime
}: AgentsViewProps): React.JSX.Element {
  const readinessObserved =
    agents.length > 0 &&
    agents.every(
      (agent) => agent.status === "ready" || agent.status === "unavailable"
    );
  const convergenceObserved =
    agents.length > 0 &&
    agents.every((agent) => agent.convergence !== NOT_OBSERVED_STATUS);
  const readyAgents = agents.filter((agent) => agent.status === "ready").length;
  const convergedAgents = agents.filter(
    (agent) => agent.convergence === "converged"
  ).length;

  const inFlightCount =
    runtime === undefined ? NOT_OBSERVED_LABEL : runtime.inFlightRequestCount;

  const columns: ColumnDef<AgentDefinition>[] = [
    {
      id: "role",
      header: "Role / Agent",
      weight: 201,
      cell: (agent) =>
        React.createElement(
          "a",
          {
            href: `/agents/${encodeURIComponent(agent.id)}`,
            className:
              "font-semibold text-fg underline-offset-4 hover:underline",
            "aria-label": `Open agent ${agent.role}`,
            title: `${agent.role} (${agent.kind})`
          },
          React.createElement("span", null, agent.role),
          React.createElement(
            "span",
            { className: "ml-2 text-xs text-fg-muted capitalize" },
            `(${agent.kind})`
          )
        )
    },
    {
      id: "primaryModel",
      header: "Primary Model",
      // Gives the share the two badge columns need. The model id titles itself,
      // so narrowing it costs a truncation the reader can recover rather than a
      // status word with nothing behind it.
      weight: 178,
      cell: (agent) =>
        React.createElement(
          "span",
          // The model id is the widest thing this column will ever hold, and a
          // truncating cell is only titled when its content is a plain string
          // -- a bare `<span>` recovers nothing on its own, so it titles
          // itself the way `Chip` does.
          { className: MONO_VALUE_CLASS, title: agent.primaryModel },
          agent.primaryModel
        )
    },
    {
      id: "providers",
      header: "Providers",
      align: "tokens",
      // Gives the share the two badge columns need. The provider chips still
      // wrap — that is the target state's rule for discrete cell content — and
      // wrapping costs height, not legibility, so this is the cheapest column
      // on the page to narrow.
      weight: 176,
      cell: (agent) =>
        React.createElement(AgentProviderSummary, { agent, providers })
    },
    {
      id: "status",
      header: "Status",
      // "Configured" is 99px of pill plus 32px of cell padding. A weight is a share
      // of the table rather than a width, so it has to clear that at the table's
      // 864px floor instead of at the viewport the badge was measured at — 136
      // left it cut at its last glyph on every row, and measuring against the
      // badge's already-clamped width understated it by a further 8px.
      weight: 171,
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.status })
    },
    {
      id: "convergence",
      header: "Convergence",
      // "Not-observed" is the longest label on this table at 115px of pill, so
      // this column needs more than Status even though it reads less often.
      weight: 191,
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.convergence })
    },
    {
      id: "skillsCount",
      header: "Skills",
      weight: 108,
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "text-xs text-fg-secondary tabular-nums" },
          agent.tools.filter((tool) => tool.type === "skill").length
        )
    },
    {
      id: "mcpsCount",
      header: "MCPs",
      weight: 100,
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "text-xs text-fg-secondary tabular-nums" },
          agent.tools.filter((tool) => tool.type === "mcp").length
        )
    }
  ];

  return React.createElement(
    PageBody,
    { feature: "agents" },
    React.createElement(
      StatGrid,
      { columns: 3 },
      React.createElement(StatCard, {
        title: "Ready Agents",
        value: readinessObserved ? readyAgents : NOT_OBSERVED_LABEL,
        subtitle: readinessObserved
          ? "Runtime health"
          : "No runtime health probe"
      }),
      React.createElement(StatCard, {
        title: "Converged Agents",
        value: convergenceObserved ? convergedAgents : NOT_OBSERVED_LABEL,
        subtitle: convergenceObserved
          ? "Desired vs actual"
          : "No reconciliation observation"
      }),
      React.createElement(StatCard, {
        title: "In-Flight Requests",
        value: inFlightCount,
        subtitle:
          runtime === undefined ? NOT_OBSERVED_LABEL : "Active router turns"
      })
    ),
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "data-section": "configured-agents"
      },
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Configured Agents"
      ),
      React.createElement<DataTableProps<AgentDefinition>>(DataTable, {
        data: agents,
        columns,
        keyExtractor: (agent: AgentDefinition) => agent.id,
        // The Control API answered, and it answered with no rows. That is an
        // observed empty catalog rather than an unreadable one -- a fetch that
        // fails renders the failure shell above instead of reaching here.
        emptyMessage: "No agents are configured."
      })
    ),
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "data-section": "runtime-health"
      },
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Runtime Concurrency & Circuit Health"
      ),
      runtime === undefined
        ? React.createElement(
            "p",
            {
              className: MUTED_META_CLASS,
              "data-status": "not-observed"
            },
            NOT_OBSERVED_LABEL
          )
        : React.createElement(
            DetailGrid,
            { columns: 4 },
            React.createElement(
              DetailValue,
              {
                label: "Router Instance ID",
                // `break-all` would split the UUID mid-segment (`…0b1` / `3`).
                // A router instance id is a discrete identifier, so it wraps
                // between its own hyphen groups rather than inside one.
                valueClassName:
                  "font-mono text-xs text-fg-secondary break-words"
              },
              runtime.routerInstanceId
            ),
            React.createElement(
              DetailValue,
              {
                label: "Lifecycle State",
                valueClassName: null
              },
              React.createElement(StatusBadge, {
                // Draining is a state in its own right, not a flavour of
                // "not ready", and it is already the badge's own word. Handing
                // the badge the raw `lifecycle.state` instead made this the one
                // row on the page that spelled the vocabulary differently from
                // every other badge on it.
                status:
                  runtime.lifecycle.state === "draining" ? "pending" : "ready"
              })
            ),
            // Draining is an operational state of its own: the router stops
            // accepting new work while it finishes what is in flight, and
            // hiding that behind a plain "ready" would read as healthy.
            React.createElement(
              DetailValue,
              { label: "Draining", valueClassName: null },
              React.createElement(StatusBadge, {
                status: runtime.lifecycle.draining ? "pending" : "ready",
                label: runtime.lifecycle.draining ? "Draining" : "Not draining"
              })
            ),
            React.createElement(
              DetailValue,
              { label: "In-Flight Requests" },
              String(runtime.inFlightRequestCount)
            ),
            React.createElement(
              DetailValue,
              { label: "Session Concurrency Limit" },
              observed(runtime.concurrency.effectivePerSessionLimit)
            ),
            React.createElement(
              DetailValue,
              { label: "Active Subagent Threads" },
              observed(runtime.concurrency.activeSubagentThreads)
            ),
            React.createElement(
              DetailValue,
              { label: "Active Sessions" },
              observed(runtime.concurrency.activeSessions)
            ),
            React.createElement(
              DetailValue,
              { label: "Total Denials" },
              observed(runtime.concurrency.denials)
            ),
            React.createElement(
              DetailValue,
              {
                label: "Last Denial Reason",
                valueClassName: "font-mono text-xs text-fg-secondary",
                rowClassName: "sm:col-span-2"
              },
              runtime.concurrency.lastDenial === undefined ||
                runtime.concurrency.lastDenial === null
                ? "None observed"
                : (runtime.concurrency.lastDenial.reason ?? NOT_OBSERVED_LABEL)
            )
          )
    )
  );
}

/**
 * Render one observed counter. An absent counter is not a zero: the Runtime
 * omits a field it has no evidence for, and printing `0` there would claim an
 * observed idle state that was never measured.
 */
function observed(value: number | undefined): string {
  return value === undefined ? NOT_OBSERVED_LABEL : String(value);
}
