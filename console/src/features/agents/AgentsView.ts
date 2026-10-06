import type {
  AgentDefinition,
  ControlApiProvidersResponse,
  ControlApiRoutingResponse,
  ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { ConsoleLink } from "../../components/navigation/ConsoleLink.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import { AgentProviderSummary } from "./AgentProviderSummary.ts";

const NOT_OBSERVED_LABEL = "Not observed";
const NOT_OBSERVED_STATUS = "not-observed";

export interface AgentsViewProps {
  readonly agents: readonly AgentDefinition[];
  readonly providers?: ControlApiProvidersResponse | undefined;
  readonly routing?: ControlApiRoutingResponse | undefined;
  readonly runtime?: ControlApiRuntimeResponse | undefined;
}

export function AgentsView({
  agents,
  providers,
  routing,
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
      cell: (agent) =>
        React.createElement(
          ConsoleLink,
          {
            href: `/agents/${encodeURIComponent(agent.id)}`,
            className:
              "font-semibold text-fg underline-offset-4 hover:underline",
            "aria-label": `Open agent ${agent.role}`
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
      wrap: true,
      cell: (agent) =>
        React.createElement(AgentProviderSummary, { agent, providers })
    },
    {
      id: "status",
      header: "Status",
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.status })
    },
    {
      id: "convergence",
      header: "Convergence",
      cell: (agent) =>
        React.createElement(StatusBadge, { status: agent.convergence })
    },
    {
      id: "skillsCount",
      header: "Skills",
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "text-xs text-fg-secondary" },
          agent.tools.filter((tool) => tool.type === "skill").length
        )
    },
    {
      id: "mcpsCount",
      header: "MCPs",
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "text-xs text-fg-secondary" },
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
        className: "rounded-lg border border-border bg-surface p-5 shadow",
        "data-section": "configured-agents"
      },
      React.createElement(
        "h2",
        {
          className:
            "mb-3 text-sm font-semibold uppercase tracking-wider text-fg-muted"
        },
        "Configured Agents"
      ),
      DataTable({
        data: agents,
        columns,
        keyExtractor: (agent: AgentDefinition) => agent.id
      })
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-border bg-surface p-5 shadow",
        "data-section": "runtime-health"
      },
      React.createElement(
        "h2",
        {
          className:
            "mb-3 text-sm font-semibold uppercase tracking-wider text-fg-muted"
        },
        "Runtime Concurrency & Circuit Health"
      ),
      React.createElement(
        "dl",
        { className: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" },
        React.createElement(RuntimeMetric, {
          label: "Router Instance ID",
          value: runtime?.routerInstanceId ?? NOT_OBSERVED_LABEL,
          valueClassName: "font-mono text-xs text-fg-secondary break-all"
        }),
        React.createElement(RuntimeMetric, {
          label: "Lifecycle State",
          value: React.createElement(StatusBadge, {
            status:
              runtime?.lifecycle.state === "ready"
                ? "ready"
                : runtime?.lifecycle.state
                  ? "unavailable"
                  : NOT_OBSERVED_STATUS,
            label: runtime?.lifecycle.state ?? NOT_OBSERVED_LABEL
          }),
          valueClassName: null
        }),
        React.createElement(RuntimeMetric, {
          label: "Session Concurrency Limit",
          value:
            routing?.concurrency?.effectivePerSessionLimit ??
            runtime?.concurrency.limit ??
            NOT_OBSERVED_LABEL
        }),
        React.createElement(RuntimeMetric, {
          label: "Active Subagent Threads",
          value:
            routing?.concurrency?.activeSubagentThreads ??
            runtime?.concurrency.active ??
            0
        }),
        React.createElement(RuntimeMetric, {
          label: "Active Sessions",
          value: routing?.concurrency?.activeSessions ?? 0
        }),
        React.createElement(RuntimeMetric, {
          label: "Total Denials",
          value: routing?.concurrency?.denials ?? 0
        }),
        React.createElement(RuntimeMetric, {
          label: "Last Denial Reason",
          value: routing?.concurrency?.lastDenial
            ? `${routing.concurrency.lastDenial.role} - ${routing.concurrency.lastDenial.reason}`
            : "None observed",
          valueClassName: "font-mono text-xs text-fg-secondary",
          rowClassName: "flex flex-col gap-1 sm:col-span-2"
        })
      )
    )
  );
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
