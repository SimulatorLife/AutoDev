import type {
  AgentDefinition,
  ControlApiProvidersResponse,
  ControlApiRoutingResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { AgentProviderSummary } from "./AgentProviderSummary.ts";

const SECTION_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-6 shadow";

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
        className: SECTION_PANEL_CLASS
      },
      React.createElement(
        "div",
        { className: "mb-5 flex flex-wrap items-start justify-between gap-4" },
        React.createElement(
          "div",
          null,
          React.createElement(Breadcrumbs, {
            items: [{ label: "Agents", href: "/agents" }, { label: agent.role }]
          }),
          React.createElement(
            "p",
            {
              className: ENTITY_EYEBROW_CLASS
            },
            "Agent role"
          ),
          React.createElement(EntityTitle, undefined, agent.role)
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
            { className: "text-xs uppercase tracking-wider text-fg-muted" },
            "Validation"
          ),
          React.createElement(StatusBadge, { status: validation })
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-labelledby": "agent-runtime-heading"
      },
      React.createElement(
        "h3",
        {
          id: "agent-runtime-heading",
          className: SECTION_HEADING_CLASS
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
        className: `grid grid-cols-1 gap-6 ${SECTION_PANEL_CLASS} lg:grid-cols-2`
      },
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
    React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "data-section": "agent-providers"
      },
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "Eligible providers"
      ),
      React.createElement(
        "p",
        { className: "mb-3 text-xs text-fg-muted" },
        isOrchestrator
          ? "Orchestrator-role enablement. Provider controls and routing live in Providers."
          : "Subagent-role enablement. Provider controls and routing live in Providers."
      ),
      React.createElement(AgentProviderSummary, { agent, providers })
    ),
    React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "data-section": "agent-concurrency"
      },
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
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
            routing?.concurrency?.effectivePerSessionLimit === undefined
              ? "Not observed"
              : String(routing.concurrency.effectivePerSessionLimit)
        }),
        React.createElement(DetailValue, {
          label: "Active subagent threads",
          value:
            routing?.concurrency?.activeSubagentThreads === undefined
              ? "0"
              : String(routing.concurrency.activeSubagentThreads)
        })
      )
    ),
    agent.systemPrompt === undefined
      ? React.createElement(
          "section",
          {
            className:
              "rounded-lg border border-border bg-surface p-6 text-sm text-fg-muted",
            "data-prompt-state": "unavailable"
          },
          "Role prompt content is unavailable."
        )
      : React.createElement(
          "section",
          {
            className: SECTION_PANEL_CLASS,
            "aria-labelledby": "agent-prompt-heading"
          },
          React.createElement(
            "h3",
            {
              id: "agent-prompt-heading",
              className: SECTION_HEADING_CLASS
            },
            "System prompt"
          ),
          React.createElement(
            "pre",
            {
              className:
                "max-h-[32rem] overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-4 font-mono text-xs text-fg-secondary"
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
      { className: "text-xs uppercase tracking-wider text-fg-muted" },
      label
    ),
    React.createElement("dd", { className: "font-mono text-sm text-fg" }, value)
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
        className: SECTION_HEADING_CLASS
      },
      heading
    ),
    names.length === 0
      ? React.createElement(
          "p",
          { className: "text-sm text-fg-muted" },
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
                  "rounded border border-border-strong bg-surface-raised px-2 py-1 font-mono text-xs text-fg"
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
      { className: "text-xs uppercase tracking-wider text-fg-muted" },
      label
    ),
    React.createElement(StatusBadge, { status })
  );
}
