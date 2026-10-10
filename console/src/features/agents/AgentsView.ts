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
import { LiveCountRefresh } from "../../components/navigation/LiveCountRefresh.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import {
  DetailGrid,
  DetailValue,
  StatGrid
} from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  ENTITY_LINK_CLASS,
  MONO_VALUE_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { liveAgentCount } from "../live-agent-count.ts";
import { AgentProviderSummary } from "./AgentProviderSummary.ts";

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
      // The widest cell on the page: `orchestrator (orchestrator)` measures
      // 179px, which is 211 with the cell's own 32px of padding, and this is
      // the only column here that names a row rather than a property of one.
      //
      // Every weight on this table is sized to the larger of that content
      // budget at the 1440 content column and the column's own header at the
      // table's 864px floor. Sizing them as shares of a total that was never
      // reconciled with either is what had these seven summing to 1125 against
      // a 1076px content column, so every percentage on the page was handing
      // out 96% of the budget its weight described.
      weight: 221,
      cell: (agent) =>
        React.createElement(
          "div",
          {
            className: "flex flex-col items-start gap-1"
          },
          React.createElement(
            NavigationLink,
            {
              href: `/agents/${encodeURIComponent(agent.id)}`,
              className: `block min-h-6 font-semibold text-fg ${ENTITY_LINK_CLASS}`,
              "aria-label": `Open agent ${agent.role}`,
              title: `${agent.role} (${agent.kind})`
            },
            React.createElement("span", null, agent.role),
            React.createElement(
              "span",
              { className: "ml-2 text-xs text-fg-muted capitalize" },
              `(${agent.kind})`
            )
          ),
          React.createElement(
            "span",
            {
              className: "text-xs text-fg-muted tabular-nums",
              "data-live-agent-role": agent.role
            },
            `Active instances: ${liveAgentCount(runtime?.liveAgents, "byRole", agent.role)}`
          )
        )
    },
    {
      id: "primaryModel",
      header: "Primary Model",
      // `autodev/orchestrator` measures 145px, 177 with the cell own 32px of
      // padding. The model id titles itself, so narrowing it costs a truncation
      // the reader can recover rather than a status word with nothing behind it.
      weight: 185,
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
      // The provider chips wrap -- that is the target state's rule for discrete
      // cell content -- and wrapping costs height, not legibility, so this is the
      // cheapest column on the page to narrow.
      weight: 147,
      cell: (agent) =>
        React.createElement(AgentProviderSummary, { agent, providers })
    },
    {
      id: "status",
      header: "Status",
      // "Configured" measures 115px as a badge -- status dot, gap and padding --
      // against 52px of header text. Measuring only the badge label span reads
      // 83px here and calls the column fine while the badge is cut at its last
      // glyph on every row.
      weight: 154,
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.status })
    },
    {
      id: "convergence",
      header: "Convergence",
      // "Not observed" measures 128px as a badge, and its 101px header is the
      // longest on the page, so this column is bounded by its header at the floor
      // even though it reads less often than Status.
      weight: 173,
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.convergence })
    },
    {
      id: "skillsCount",
      header: "Skills",
      weight: 103,
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
      weight: 93,
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
    React.createElement(LiveCountRefresh),
    React.createElement(
      StatGrid,
      { columns: 4 },
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
      }),
      React.createElement(StatCard, {
        title: "Active Agent Instances",
        value:
          runtime?.liveAgents === undefined || runtime.liveAgents === null
            ? NOT_OBSERVED_LABEL
            : runtime.liveAgents.count,
        subtitle:
          runtime?.liveAgents === undefined || runtime.liveAgents === null
            ? "No live activity source"
            : "Runtime live sessions and subagents"
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
              concurrencyLimit(runtime.concurrency.effectivePerSessionLimit)
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
                valueClassName: MONO_VALUE_CLASS,
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

/**
 * A concurrency limit, which has three states rather than two.
 *
 * `undefined` is "not observed" -- the Runtime did not report a limit.
 * `null` is "unlimited", which is the default and an observed fact about this
 * deployment, not an absence of one. Reading it as `Not observed` told an
 * operator running without any limit that the Console could not find out.
 */
function concurrencyLimit(value: number | null | undefined): string {
  if (value === undefined) return NOT_OBSERVED_LABEL;
  return value === null ? "Unlimited" : String(value);
}
