import React, { useState } from "react";

import type { AgentDefinition } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { type ColumnDef, DataTable } from "../../components/tables/DataTable.ts";

export interface AgentsViewProps {
  readonly agents: readonly AgentDefinition[];
  readonly onUpdateProviderState?: (
    provider: string,
    role: "orchestrator" | "subagent",
    enabled: boolean
  ) => Promise<void>;
}

export function AgentsView({
  agents
}: AgentsViewProps): React.JSX.Element {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    agents[0]?.id ?? null
  );

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  const totalAgents = agents.length;
  const readyAgents = agents.filter((a) => a.status === "ready").length;
  const convergedAgents = agents.filter((a) => a.convergence === "converged").length;

  const columns: ColumnDef<AgentDefinition>[] = [
    {
      id: "role",
      header: "Role / Agent",
      cell: (agent) =>
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: "font-semibold text-slate-100" },
            agent.role
          ),
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
      cell: (agent) => React.createElement(StatusBadge, { status: agent.status })
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
          agent.tools.filter((t) => t.type === "skill").length
        )
    },
    {
      id: "mcpsCount",
      header: "MCPs",
      cell: (agent) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-300" },
          agent.tools.filter((t) => t.type === "mcp").length
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "agents" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, {
        title: "Total Agents",
        value: totalAgents
      }),
      React.createElement(StatCard, {
        title: "Ready Agents",
        value: readyAgents,
        subtitle: "Runtime healthy"
      }),
      React.createElement(StatCard, {
        title: "Converged Agents",
        value: convergedAgents,
        subtitle: "Desired vs actual in sync"
      })
    ),
    React.createElement(
      "div",
      { className: "grid grid-cols-1 lg:grid-cols-3 gap-6" },
      React.createElement(
        "div",
        { className: "lg:col-span-2" },
        React.createElement(
          "h2",
          {
            className:
              "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
          },
          "Configured Agents"
        ),
        DataTable({
          data: agents,
          columns,
          keyExtractor: (a: AgentDefinition) => a.id,
          onRowClick: (a: AgentDefinition) => setSelectedAgentId(a.id)
        })
      ),
      React.createElement(
        "div",
        {
          className:
            "lg:col-span-1 bg-slate-900 border border-slate-800 rounded-lg p-5 shadow"
        },
        selectedAgent
          ? React.createElement(
              "div",
              { className: "flex flex-col gap-4" },
              React.createElement(
                "div",
                { className: "border-b border-slate-800 pb-3" },
                React.createElement(
                  "div",
                  { className: "flex items-center justify-between" },
                  React.createElement(
                    "h3",
                    { className: "text-lg font-bold text-slate-100" },
                    selectedAgent.role
                  ),
                  React.createElement(StatusBadge, {
                    status: selectedAgent.status
                  })
                ),
                React.createElement(
                  "p",
                  { className: "text-xs text-slate-400 mt-1 capitalize" },
                  `Kind: ${selectedAgent.kind} • Read-only: ${
                    selectedAgent.readOnly ? "Yes" : "No"
                  }`
                )
              ),
              React.createElement(
                "div",
                null,
                React.createElement(
                  "h4",
                  {
                    className:
                      "text-xs font-semibold uppercase text-slate-400 mb-2"
                  },
                  "Assigned Skills"
                ),
                React.createElement(
                  "div",
                  { className: "flex flex-wrap gap-1.5" },
                  selectedAgent.tools
                    .filter((t) => t.type === "skill")
                    .map((s) =>
                      React.createElement(
                        "span",
                        {
                          key: s.name,
                          className:
                            "text-xs bg-slate-800 text-slate-200 px-2 py-0.5 rounded border border-slate-700 font-mono"
                        },
                        s.name
                      )
                    )
                )
              ),
              React.createElement(
                "div",
                null,
                React.createElement(
                  "h4",
                  {
                    className:
                      "text-xs font-semibold uppercase text-slate-400 mb-2"
                  },
                  "Assigned MCP Servers"
                ),
                React.createElement(
                  "div",
                  { className: "flex flex-wrap gap-1.5" },
                  selectedAgent.tools
                    .filter((t) => t.type === "mcp")
                    .map((m) =>
                      React.createElement(
                        "span",
                        {
                          key: m.name,
                          className:
                            "text-xs bg-slate-800 text-cyan-300 px-2 py-0.5 rounded border border-slate-700 font-mono"
                        },
                        m.server ?? m.name
                      )
                    )
                )
              ),
              selectedAgent.systemPrompt
                ? React.createElement(
                    "div",
                    null,
                    React.createElement(
                      "h4",
                      {
                        className:
                          "text-xs font-semibold uppercase text-slate-400 mb-2"
                      },
                      "System Prompt"
                    ),
                    React.createElement(
                      "pre",
                      {
                        className:
                          "text-xs font-mono bg-slate-950 p-3 rounded border border-slate-800 text-slate-300 overflow-x-auto max-h-48 whitespace-pre-wrap"
                      },
                      selectedAgent.systemPrompt
                    )
                  )
                : null
            )
          : React.createElement(
              "div",
              { className: "text-center text-slate-500 py-12" },
              "Select an agent to view details"
            )
      )
    )
  );
}
