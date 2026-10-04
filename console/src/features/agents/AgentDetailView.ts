import type { AgentDefinition } from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";
import type {
  ControlApiProvidersResponse,
  ControlApiRoutingResponse
} from "../../lib/server/types.ts";

export interface AgentDetailViewProps {
  readonly agent: AgentDefinition;
  readonly routing?: ControlApiRoutingResponse | undefined;
  readonly providers?: ControlApiProvidersResponse | undefined;
}

export function AgentDetailView({
  agent,
  routing,
  providers
}: AgentDetailViewProps): React.JSX.Element {
  const readiness =
    agent.status === "ready" || agent.status === "unavailable"
      ? agent.status
      : "not-observed";
  const validation =
    agent.valid === null ? "not-observed" : agent.valid ? "valid" : "invalid";

  const isOrchestrator = agent.kind === "orchestrator";

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "agent-detail" },
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow"
      },
      React.createElement(
        "div",
        { className: "mb-5 flex flex-wrap items-start justify-between gap-4" },
        React.createElement(
          "div",
          null,
          React.createElement(
            "p",
            {
              className: "mb-1 text-xs uppercase tracking-wider text-slate-400"
            },
            "Agent role"
          ),
          React.createElement(
            "h2",
            { className: "text-2xl font-bold text-slate-100" },
            agent.role
          )
        ),
        React.createElement(StatusBadge, {
          status: "configured",
          label: agent.configured ? "Configured" : "Not configured"
        })
      ),
      React.createElement(
        "dl",
        { className: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" },
        React.createElement(DetailValue, {
          label: "Kind",
          value: agent.kind
        }),
        React.createElement(DetailValue, {
          label: "Read-only",
          value: agent.readOnly ? "Yes" : "No"
        }),
        React.createElement(DetailValue, {
          label: "Primary model",
          value: agent.primaryModel
        }),
        React.createElement(
          "div",
          { className: "flex flex-col gap-2" },
          React.createElement(
            "dt",
            { className: "text-xs uppercase tracking-wider text-slate-400" },
            "Validation"
          ),
          React.createElement(StatusBadge, { status: validation })
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow",
        "aria-labelledby": "agent-runtime-heading"
      },
      React.createElement(
        "h3",
        {
          id: "agent-runtime-heading",
          className:
            "mb-4 text-sm font-semibold uppercase tracking-wider text-slate-300"
        },
        "Runtime observation"
      ),
      React.createElement(
        "div",
        { className: "grid grid-cols-1 gap-4 sm:grid-cols-2" },
        React.createElement(StatusValue, {
          label: "Readiness",
          status: readiness
        }),
        React.createElement(StatusValue, {
          label: "Convergence",
          status: agent.convergence
        })
      )
    ),
    React.createElement(
      "section",
      {
        className:
          "grid grid-cols-1 gap-6 rounded-lg border border-slate-800 bg-slate-900 p-6 shadow lg:grid-cols-3"
      },
      React.createElement(NameList, {
        heading: "Eligible providers",
        names: agent.providers
      }),
      React.createElement(NameList, {
        heading: "Assigned skills",
        names: agent.tools
          .filter((tool) => tool.type === "skill")
          .map((tool) => tool.name)
      }),
      React.createElement(NameList, {
        heading: "Assigned MCP servers",
        names: agent.tools
          .filter((tool) => tool.type === "mcp")
          .map((tool) => tool.server ?? tool.name)
      })
    ),
    agent.providers.length > 0
      ? React.createElement(
          "section",
          {
            className:
              "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow",
            "data-section": "agent-provider-routes"
          },
          React.createElement(
            "h3",
            {
              className:
                "mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300"
            },
            "Provider Routing & Circuit Endpoints"
          ),
          React.createElement(
            "div",
            { className: "grid grid-cols-1 gap-3 md:grid-cols-2" },
            ...agent.providers.map((p) => {
              const route = routing?.routes.find((r) => r.provider === p);
              const pRecord = providers?.providers.find(
                (prov) => prov.id === p
              );
              const isEnabled = isOrchestrator
                ? (pRecord?.roles.orchestrator.enabled ?? true)
                : (pRecord?.roles.subagent.enabled ?? true);

              return React.createElement(
                "div",
                {
                  key: p,
                  className:
                    "rounded border border-slate-800 bg-slate-950 p-4 flex flex-col gap-2"
                },
                React.createElement(
                  "div",
                  { className: "flex items-center justify-between" },
                  React.createElement(
                    "span",
                    { className: "font-mono font-bold text-slate-100" },
                    p
                  ),
                  React.createElement(StatusBadge, {
                    status: isEnabled ? "valid" : "unavailable",
                    label: isEnabled ? "Enabled" : "Disabled"
                  })
                ),
                React.createElement(
                  "div",
                  { className: "text-xs text-slate-400 font-mono" },
                  React.createElement(
                    "span",
                    { className: "text-slate-500 mr-1" },
                    "Base:"
                  ),
                  route?.baseUrl ?? "Not observed"
                ),
                React.createElement(
                  "div",
                  { className: "text-xs text-slate-400 font-mono truncate" },
                  React.createElement(
                    "span",
                    { className: "text-slate-500 mr-1" },
                    "Pattern:"
                  ),
                  route?.pattern ?? "Default"
                )
              );
            })
          )
        )
      : null,
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow",
        "data-section": "agent-concurrency"
      },
      React.createElement(
        "h3",
        {
          className:
            "mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300"
        },
        "Concurrency & Routing Limits"
      ),
      React.createElement(
        "dl",
        { className: "grid grid-cols-1 gap-4 sm:grid-cols-3" },
        React.createElement(DetailValue, {
          label: "Role execution kind",
          value: agent.kind
        }),
        React.createElement(DetailValue, {
          label: "Session concurrency limit",
          value:
            routing?.concurrency?.effectivePerSessionLimit !== undefined
              ? String(routing.concurrency.effectivePerSessionLimit)
              : "Not observed"
        }),
        React.createElement(DetailValue, {
          label: "Active subagent threads",
          value:
            routing?.concurrency?.activeSubagentThreads !== undefined
              ? String(routing.concurrency.activeSubagentThreads)
              : "0"
        })
      )
    ),
    agent.systemPrompt === undefined
      ? React.createElement(
          "section",
          {
            className:
              "rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400",
            "data-prompt-state": "unavailable"
          },
          "Role prompt content is unavailable."
        )
      : React.createElement(
          "section",
          {
            className:
              "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow",
            "aria-labelledby": "agent-prompt-heading"
          },
          React.createElement(
            "h3",
            {
              id: "agent-prompt-heading",
              className:
                "mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300"
            },
            "System prompt"
          ),
          React.createElement(
            "pre",
            {
              className:
                "max-h-[32rem] overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950 p-4 font-mono text-xs text-slate-300"
            },
            agent.systemPrompt
          )
        )
  );
}

function DetailValue({
  label,
  value
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-1" },
    React.createElement(
      "dt",
      { className: "text-xs uppercase tracking-wider text-slate-400" },
      label
    ),
    React.createElement(
      "dd",
      { className: "font-mono text-sm text-slate-200" },
      value
    )
  );
}

function NameList({
  heading,
  names
}: {
  readonly heading: string;
  readonly names: readonly string[];
}): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "h3",
      {
        className:
          "text-xs font-semibold uppercase tracking-wider text-slate-400"
      },
      heading
    ),
    names.length === 0
      ? React.createElement(
          "p",
          { className: "text-sm text-slate-500" },
          "None configured"
        )
      : React.createElement(
          "ul",
          { className: "flex flex-wrap gap-2" },
          ...names.map((name) =>
            React.createElement(
              "li",
              {
                key: name,
                className:
                  "rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200"
              },
              name
            )
          )
        )
  );
}

function StatusValue({
  label,
  status
}: {
  readonly label: string;
  readonly status:
    | "ready"
    | "unavailable"
    | "converged"
    | "pending"
    | "error"
    | "not-observed";
}): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-2" },
    React.createElement(
      "span",
      { className: "text-xs uppercase tracking-wider text-slate-400" },
      label
    ),
    React.createElement(StatusBadge, { status })
  );
}
