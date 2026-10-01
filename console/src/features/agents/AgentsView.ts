import type { AgentDefinition } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface AgentsViewProps {
  readonly agents: readonly AgentDefinition[];
}

export function AgentsView({ agents }: AgentsViewProps): React.JSX.Element {
  const readinessObserved =
    agents.length > 0 &&
    agents.every(
      (agent) => agent.status === "ready" || agent.status === "unavailable"
    );
  const convergenceObserved =
    agents.length > 0 &&
    agents.every((agent) => agent.convergence !== "not-observed");
  const readyAgents = agents.filter((agent) => agent.status === "ready").length;
  const convergedAgents = agents.filter(
    (agent) => agent.convergence === "converged"
  ).length;

  const columns: ColumnDef<AgentDefinition>[] = [
    {
      id: "role",
      header: "Role / Agent",
      cell: (agent) =>
        React.createElement(
          "a",
          {
            href: `/agents/${encodeURIComponent(agent.id)}`,
            className:
              "font-semibold text-slate-100 underline-offset-4 hover:underline",
            "aria-label": `Open agent ${agent.role}`
          },
          React.createElement("span", null, agent.role),
          React.createElement(
            "span",
            { className: "ml-2 text-xs text-slate-400 capitalize" },
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
          { className: "font-mono text-xs text-slate-300" },
          agent.primaryModel
        )
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
          { className: "text-xs text-slate-300" },
          agent.tools.filter((tool) => tool.type === "skill").length
        )
    },
    {
      id: "mcpsCount",
      header: "MCPs",
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-300" },
          agent.tools.filter((tool) => tool.type === "mcp").length
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "agents" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 gap-4 md:grid-cols-3" },
      React.createElement(StatCard, {
        title: "Configured Agents",
        value: agents.length
      }),
      React.createElement(StatCard, {
        title: "Ready Agents",
        value: readinessObserved ? readyAgents : "Not observed",
        subtitle: readinessObserved
          ? "Runtime health"
          : "No runtime health probe"
      }),
      React.createElement(StatCard, {
        title: "Converged Agents",
        value: convergenceObserved ? convergedAgents : "Not observed",
        subtitle: convergenceObserved
          ? "Desired vs actual"
          : "No reconciliation observation"
      })
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-5 shadow"
      },
      React.createElement(
        "h2",
        {
          className:
            "mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400"
        },
        "Configured Agents"
      ),
      DataTable({
        data: agents,
        columns,
        keyExtractor: (agent: AgentDefinition) => agent.id
      })
    )
  );
}
