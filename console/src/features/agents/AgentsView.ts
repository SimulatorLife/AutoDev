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

const NOT_OBSERVED_LABEL = "Not observed";
const NOT_OBSERVED_STATUS = "not-observed";
const PROVIDER_COLLATOR = new Intl.Collator();

export interface AgentsViewProps {
  readonly agents: readonly AgentDefinition[];
  readonly providers?: ControlApiProvidersResponse | undefined;
  readonly routing?: ControlApiRoutingResponse | undefined;
  readonly runtime?: ControlApiRuntimeResponse | undefined;
  readonly providerRoleFailed?: boolean | undefined;
}

interface ProviderRoutingRow {
  readonly id: string;
  readonly orchestratorEnabled: boolean | undefined;
  readonly orchestratorMutable: boolean | undefined;
  readonly subagentEnabled: boolean | undefined;
  readonly subagentMutable: boolean | undefined;
  readonly baseUrl: string;
  readonly pattern: string;
}

function providerRoleControlPath(
  providerId: string,
  role: "orchestrator" | "subagent"
): string {
  return "/api/providers/" + encodeURIComponent(providerId) + "/roles/" + role;
}

/**
 * Renders the observed role badge and, only when the Control API reports
 * both a provider record and `mutable === true` for this role, a bounded
 * same-origin form POST that toggles the role to its opposite state. When
 * provider configuration is absent the cell renders Not observed and never
 * renders a control, so there is no false enabled/disabled fallback and no
 * optimistic client-side state.
 */
function renderProviderRoleCell(
  providerId: string,
  role: "orchestrator" | "subagent",
  enabled: boolean | undefined,
  mutable: boolean | undefined
): React.ReactNode {
  const badge = React.createElement(StatusBadge, {
    status:
      enabled === undefined
        ? NOT_OBSERVED_STATUS
        : enabled
          ? "valid"
          : "unavailable",
    label:
      enabled === undefined
        ? NOT_OBSERVED_LABEL
        : enabled
          ? "Enabled"
          : "Disabled"
  });

  if (enabled === undefined || mutable !== true) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      badge
    );
  }

  const nextEnabled = !enabled;
  return React.createElement(
    "div",
    { className: "flex flex-col gap-2" },
    badge,
    React.createElement(
      "form",
      {
        method: "POST",
        action: providerRoleControlPath(providerId, role),
        "data-provider-role-form": role,
        "data-provider-role-provider": providerId
      },
      React.createElement("input", {
        type: "hidden",
        name: "provider",
        value: providerId
      }),
      React.createElement("input", {
        type: "hidden",
        name: "role",
        value: role
      }),
      React.createElement("input", {
        type: "hidden",
        name: "enabled",
        value: String(nextEnabled)
      }),
      React.createElement(
        "button",
        {
          type: "submit",
          className:
            "rounded border border-border-strong bg-surface-raised px-2 py-0.5 text-xs font-medium text-fg hover:bg-hover"
        },
        nextEnabled ? "Enable" : "Disable"
      )
    )
  );
}

function ProviderRoleFeedback(): React.JSX.Element {
  return React.createElement(
    "div",
    {
      role: "status",
      "data-provider-role-outcome": "failed",
      className:
        "mb-3 rounded border border-warning/40 bg-warning/15 px-3 py-2 text-xs font-medium text-warning"
    },
    "Provider role change could not be confirmed. Check the current role state before retrying."
  );
}

export function AgentsView({
  agents,
  providers,
  routing,
  runtime,
  providerRoleFailed
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
      orchestratorEnabled: pRecord?.roles.orchestrator.enabled,
      orchestratorMutable: pRecord?.roles.orchestrator.mutable,
      subagentEnabled: pRecord?.roles.subagent.enabled,
      subagentMutable: pRecord?.roles.subagent.mutable,
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
          { className: "font-mono font-semibold text-fg" },
          row.id
        )
    },
    {
      id: "orchestrator",
      header: "Orchestrator Role",
      cell: (row) =>
        renderProviderRoleCell(
          row.id,
          "orchestrator",
          row.orchestratorEnabled,
          row.orchestratorMutable
        )
    },
    {
      id: "subagent",
      header: "Subagent Role",
      cell: (row) =>
        renderProviderRoleCell(
          row.id,
          "subagent",
          row.subagentEnabled,
          row.subagentMutable
        )
    },
    {
      id: "baseUrl",
      header: "Upstream Base URL",
      cell: (row) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-muted" },
          row.baseUrl
        )
    },
    {
      id: "pattern",
      header: "Route Pattern",
      cell: (row) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-muted" },
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
        "data-section": "providers-routing"
      },
      React.createElement(
        "div",
        { className: "mb-3" },
        React.createElement(
          "h2",
          {
            className:
              "text-sm font-semibold uppercase tracking-wider text-fg-muted"
          },
          "Providers & Routing Policy"
        ),
        React.createElement(
          "p",
          { className: "text-xs text-fg-muted mt-1" },
          "Secondary provider eligibility by role, upstream routing endpoints, and active cooldown circuits"
        )
      ),
      providerRoleFailed ? React.createElement(ProviderRoleFeedback) : null,
      DataTable({
        data: providerRows,
        columns: providerColumns,
        keyExtractor: (row: ProviderRoutingRow) => row.id,
        emptyMessage: "No provider routing configuration observed."
      }),
      React.createElement(
        "div",
        { className: "mt-4 border-t border-border pt-3" },
        React.createElement(
          "h3",
          {
            className:
              "text-xs font-semibold uppercase tracking-wider text-fg-muted mb-2"
          },
          "Active Cooldown Circuits"
        ),
        cooldownEntries.length === 0
          ? React.createElement(
              "p",
              { className: "text-xs text-fg-muted" },
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
                      "rounded border border-warning/40 bg-warning/15 px-2 py-1 font-mono text-xs text-warning"
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
