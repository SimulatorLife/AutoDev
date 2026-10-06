import type {
  AgentDefinition,
  ControlApiProvidersResponse,
  ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { AgentProviderSummary } from "./AgentProviderSummary.ts";

const NOT_OBSERVED_LABEL = "Not observed";
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
      weight: 215,
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
      weight: 210,
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-secondary" },
          agent.primaryModel
        )
    },
    {
      id: "providers",
      header: "Providers",
      align: "tokens",
      weight: 190,
      cell: (agent) =>
        React.createElement(AgentProviderSummary, { agent, providers })
    },
    {
      id: "status",
      header: "Status",
      weight: 136,
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.status })
    },
    {
      id: "convergence",
      header: "Convergence",
      weight: 152,
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.convergence })
    },
    {
      id: "skillsCount",
      header: "Skills",
      weight: 100,
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
      weight: 84,
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "text-xs text-fg-secondary tabular-nums" },
          agent.tools.filter((tool) => tool.type === "mcp").length
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "agents" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" },
      React.createElement(StatCard, {
        title: "Configured Agents",
        value: agents.length
      }),
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
        keyExtractor: (agent: AgentDefinition) => agent.id
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
              className: "text-xs text-fg-muted",
              "data-status": "not-observed"
            },
            NOT_OBSERVED_LABEL
          )
        : React.createElement(
            "dl",
            {
              className: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
            },
            React.createElement(RuntimeMetric, {
              label: "Router Instance ID",
              value: runtime.routerInstanceId,
              // `break-all` would split the UUID mid-segment (`…0b1` / `3`).
              // A router instance id is a discrete identifier, so it wraps
              // between its own hyphen groups rather than inside one.
              valueClassName: "font-mono text-xs text-fg-secondary break-words"
            }),
            React.createElement(RuntimeMetric, {
              label: "Lifecycle State",
              value: React.createElement(StatusBadge, {
                status:
                  runtime.lifecycle.state === "ready"
                    ? "ready"
                    : runtime.lifecycle.state
                      ? "unavailable"
                      : NOT_OBSERVED_STATUS,
                label: runtime.lifecycle.state ?? NOT_OBSERVED_LABEL
              }),
              valueClassName: null
            }),
            // Draining is an operational state of its own: the router stops
            // accepting new work while it finishes what is in flight, and
            // hiding that behind a plain "ready" would read as healthy.
            React.createElement(RuntimeMetric, {
              label: "Draining",
              value: React.createElement(StatusBadge, {
                status: runtime.lifecycle.draining ? "pending" : "ready",
                label: runtime.lifecycle.draining ? "Draining" : "Not draining"
              }),
              valueClassName: null
            }),
            React.createElement(RuntimeMetric, {
              label: "In-Flight Requests",
              value: String(runtime.inFlightRequestCount)
            }),
            React.createElement(RuntimeMetric, {
              label: "Session Concurrency Limit",
              value: observed(runtime.concurrency.effectivePerSessionLimit)
            }),
            React.createElement(RuntimeMetric, {
              label: "Active Subagent Threads",
              value: observed(runtime.concurrency.activeSubagentThreads)
            }),
            React.createElement(RuntimeMetric, {
              label: "Active Sessions",
              value: observed(runtime.concurrency.activeSessions)
            }),
            React.createElement(RuntimeMetric, {
              label: "Total Denials",
              value: observed(runtime.concurrency.denials)
            }),
            React.createElement(RuntimeMetric, {
              label: "Last Denial Reason",
              value:
                runtime.concurrency.lastDenial === undefined ||
                runtime.concurrency.lastDenial === null
                  ? "None observed"
                  : (runtime.concurrency.lastDenial.reason ??
                    NOT_OBSERVED_LABEL),
              valueClassName: "font-mono text-xs text-fg-secondary",
              rowClassName: "flex flex-col gap-1 sm:col-span-2"
            })
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

function RuntimeMetric({
  label,
  value,
  valueClassName = "font-mono text-sm text-fg",
  rowClassName = "flex flex-col gap-1"
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly valueClassName?: string | null;
  readonly rowClassName?: string;
}): React.JSX.Element {
  return React.createElement(
    "div",
    { className: rowClassName },
    React.createElement(
      "dt",
      { className: "text-xs uppercase tracking-wider text-fg-muted" },
      label
    ),
    React.createElement(
      "dd",
      valueClassName === null ? null : { className: valueClassName },
      value
    )
  );
}
