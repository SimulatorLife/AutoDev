import type {
  AgentDefinition,
  ControlApiProvidersResponse,
  ControlApiRoutingResponse,
  ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

const NOT_OBSERVED_LABEL = "Not observed";
const PROVIDER_COLLATOR = new Intl.Collator();

export interface AgentsViewProps {
  readonly agents: readonly AgentDefinition[];
  readonly providers?: ControlApiProvidersResponse | undefined;
  readonly routing?: ControlApiRoutingResponse | undefined;
  readonly runtime?: ControlApiRuntimeResponse | undefined;
}

interface ProviderRoutingRow {
  readonly id: string;
  readonly orchestratorEnabled: boolean;
  readonly subagentEnabled: boolean;
  readonly baseUrl: string;
  readonly pattern: string;
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
    agents.every((agent) => agent.convergence !== "not-observed");
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

  const providerIds = Array.from(
    new Set([
      ...(providers?.providers.map((p) => p.id) ?? []),
      ...(routing?.routes.map((r) => r.provider) ?? [])
    ])
  ).sort((a, b) => PROVIDER_COLLATOR.compare(a, b));

  const providerRows: ProviderRoutingRow[] = providerIds.map((id) => {
    const pRecord = providers?.providers.find((p) => p.id === id);
    const route = routing?.routes.find((r) => r.provider === id);
    return {
      id,
      orchestratorEnabled: pRecord?.roles.orchestrator.enabled ?? false,
      subagentEnabled: pRecord?.roles.subagent.enabled ?? false,
      baseUrl: route?.baseUrl ?? NOT_OBSERVED_LABEL,
      pattern: route?.pattern ?? "Default"
    };
  });

  const providerColumns: ColumnDef<ProviderRoutingRow>[] = [
    {
      id: "provider",
      header: "Provider",
      cell: (row) =>
        React.createElement(
          "span",
          { className: "font-mono font-semibold text-slate-100" },
          row.id
        )
    },
    {
      id: "orchestrator",
      header: "Orchestrator Role",
      cell: (row) =>
        React.createElement(StatusBadge, {
          status: row.orchestratorEnabled ? "valid" : "unavailable",
          label: row.orchestratorEnabled ? "Enabled" : "Disabled"
        })
    },
    {
      id: "subagent",
      header: "Subagent Role",
      cell: (row) =>
        React.createElement(StatusBadge, {
          status: row.subagentEnabled ? "valid" : "unavailable",
          label: row.subagentEnabled ? "Enabled" : "Disabled"
        })
    },
    {
      id: "baseUrl",
      header: "Upstream Base URL",
      cell: (row) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-400" },
          row.baseUrl
        )
    },
    {
      id: "pattern",
      header: "Route Pattern",
      cell: (row) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-400" },
          row.pattern
        )
    }
  ];

  const cooldownEntries = Object.entries(routing?.cooldowns ?? {});

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
        className: "rounded-lg border border-slate-800 bg-slate-900 p-5 shadow",
        "data-section": "configured-agents"
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
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-5 shadow",
        "data-section": "providers-routing"
      },
      React.createElement(
        "div",
        { className: "mb-3" },
        React.createElement(
          "h2",
          {
            className:
              "text-sm font-semibold uppercase tracking-wider text-slate-400"
          },
          "Providers & Routing Policy"
        ),
        React.createElement(
          "p",
          { className: "text-xs text-slate-500 mt-1" },
          "Secondary provider eligibility by role, upstream routing endpoints, and active cooldown circuits"
        )
      ),
      DataTable({
        data: providerRows,
        columns: providerColumns,
        keyExtractor: (row: ProviderRoutingRow) => row.id,
        emptyMessage: "No provider routing configuration observed."
      }),
      React.createElement(
        "div",
        { className: "mt-4 border-t border-slate-800 pt-3" },
        React.createElement(
          "h3",
          {
            className:
              "text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2"
          },
          "Active Cooldown Circuits"
        ),
        cooldownEntries.length === 0
          ? React.createElement(
              "p",
              { className: "text-xs text-slate-500" },
              "No active provider cooldowns."
            )
          : React.createElement(
              "ul",
              { className: "flex flex-wrap gap-2" },
              ...cooldownEntries.map(([key, val]) =>
                React.createElement(
                  "li",
                  {
                    key,
                    className:
                      "rounded border border-amber-800 bg-amber-950/60 px-2 py-1 font-mono text-xs text-amber-300"
                  },
                  `${key}: ${JSON.stringify(val)}`
                )
              )
            )
      )
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-5 shadow",
        "data-section": "runtime-health"
      },
      React.createElement(
        "h2",
        {
          className:
            "mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400"
        },
        "Runtime Concurrency & Circuit Health"
      ),
      React.createElement(
        "dl",
        { className: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" },
        React.createElement(RuntimeMetric, {
          label: "Router Instance ID",
          value: runtime?.routerInstanceId ?? NOT_OBSERVED_LABEL,
          valueClassName: "font-mono text-xs text-slate-300 break-all"
        }),
        React.createElement(RuntimeMetric, {
          label: "Lifecycle State",
          value: React.createElement(StatusBadge, {
            status:
              runtime?.lifecycle.state === "ready"
                ? "ready"
                : runtime?.lifecycle.state
                  ? "unavailable"
                  : "not-observed",
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
          valueClassName: "font-mono text-xs text-slate-300",
          rowClassName: "flex flex-col gap-1 sm:col-span-2"
        })
      )
    )
  );
}

function RuntimeMetric({
  label,
  value,
  valueClassName = "font-mono text-sm text-slate-200",
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
      { className: "text-xs uppercase tracking-wider text-slate-400" },
      label
    ),
    React.createElement(
      "dd",
      valueClassName === null ? null : { className: valueClassName },
      value
    )
  );
}
