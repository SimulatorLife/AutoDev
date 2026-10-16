import type {
  AgentDefinition,
  ControlApiAgentDetailResponse,
  ControlApiProvidersResponse,
  ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { CodeBlock } from "../../components/code/CodeBlock.ts";
import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { LiveCountRefresh } from "../../components/navigation/LiveCountRefresh.ts";
import {
  DetailGrid,
  DetailValue
} from "../../components/panels/DetailGrid.ts";
import {
  ControlFailureNotice,
  type ControlFailureNoticeProps
} from "../../components/status/ControlFailureNotice.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { chipList } from "../../components/tables/Chips.ts";
import {
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { liveAgentCount } from "../live-agent-count.ts";
import { AgentEnablementControl } from "./AgentEnablementControl.ts";
import { AgentProviderSummary } from "./AgentProviderSummary.ts";
import { agentPath } from "./paths.ts";

export interface AgentDetailViewProps {
  readonly agent: AgentDefinition;
  /**
   * Desired-vs-actual state for this agent.
   *
   * The response guard makes this field a precondition of the page: without a
   * well-formed reconciliation bundle the whole detail page fails closed rather
   * than rendering half an agent. It was then dropped by the view mapper, so the
   * page fetched it, validated it, and rendered none of it -- the only trace of
   * a desired-vs-actual contract on the page was the agent's own `convergence`
   * field, which is a different fact. `/prompts/[id]` renders the same panel
   * from the same bundle; two detail pages for two mutable resources answered
   * the same question differently.
   */
  readonly reconciliation: ControlApiAgentDetailResponse["reconciliation"];
  readonly providers?: ControlApiProvidersResponse | undefined;
  readonly runtime?: ControlApiRuntimeResponse | undefined;
  readonly controlFailed?: boolean | undefined;
  readonly controlRefusal?: ControlFailureNoticeProps["refusal"];
}

function concurrencyLimit(limit: number | null | undefined): string {
  if (limit === undefined) return NOT_OBSERVED_LABEL;
  return limit === null ? "Unlimited" : String(limit);
}

export function AgentDetailView({
  agent,
  reconciliation,
  providers,
  runtime,
  controlFailed,
  controlRefusal
}: AgentDetailViewProps): React.JSX.Element {
  const readiness =
    agent.status === "ready" || agent.status === "unavailable"
      ? agent.status
      : "not-observed";
  const validation =
    agent.valid === null ? "not-observed" : agent.valid ? "valid" : "invalid";

  const isOrchestrator = agent.kind === "orchestrator";
  const concurrency = runtime?.concurrency;

  return React.createElement(
    PageBody,
    { feature: "agent-detail" },
    React.createElement(LiveCountRefresh),
    controlFailed
      ? React.createElement(ControlFailureNotice, { refusal: controlRefusal })
      : null,
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS
      },
      React.createElement(
        "div",
        { className: "mb-5 flex flex-wrap items-start justify-between gap-4" },
        React.createElement(
          "div",
          // Shrinkable so the breadcrumb trail and the entity title below it
          // can ellipsize and wrap inside the panel instead of widening it.
          { className: "min-w-0 flex-1" },
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
        DetailGrid,
        { columns: 4, label: "Agent configuration" },
        React.createElement(DetailValue, { label: "Kind" }, agent.kind),
        React.createElement(
          DetailValue,
          { label: "Read-only" },
          agent.readOnly ? "Yes" : "No"
        ),
        React.createElement(
          DetailValue,
          { label: "Primary model" },
          agent.primaryModel
        ),
        React.createElement(
          DetailValue,
          { label: "Validation", valueClassName: null },
          React.createElement(StatusBadge, { status: validation })
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "data-section": "agent-enablement"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Enablement"
      ),
      React.createElement(
        "p",
        { className: `mb-3 ${MUTED_META_CLASS}` },
        "Runtime owns whether this agent role is enabled. The refreshed value is authoritative after a change."
      ),
      React.createElement(AgentEnablementControl, {
        role: agent.role,
        enablement: agent.enablement,
        convergence: agent.convergence,
        returnTo: agentPath(agent.role)
      })
    ),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
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
        DetailGrid,
        { columns: 3 },
        React.createElement(StatusValue, {
          label: "Readiness",
          status: readiness
        }),
        React.createElement(StatusValue, {
          label: "Convergence",
          status: agent.convergence
        }),
        React.createElement(
          "div",
          {
            "data-live-agent-role": agent.role
          },
          React.createElement(
            DetailValue,
            { label: "Active instances" },
            liveAgentCount(runtime?.liveAgents, "byRole", agent.role)
          )
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Reconciliation state",
        "data-section": "agent-reconciliation"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Reconciliation"
      ),
      React.createElement(ReconciliationPanel, {
        status: reconciliation.status,
        history: reconciliation.history
      })
    ),
    React.createElement(
      "section",
      {
        className: `grid grid-cols-1 gap-6 ${DETAIL_PANEL_CLASS} lg:grid-cols-2`
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
        className: DETAIL_PANEL_CLASS,
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
        { className: `mb-3 ${MUTED_META_CLASS}` },
        isOrchestrator
          ? "Orchestrator-role enablement. Provider controls and routing live in Providers."
          : "Subagent-role enablement. Provider controls and routing live in Providers."
      ),
      React.createElement(AgentProviderSummary, { agent, providers })
    ),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
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
        DetailGrid,
        { columns: 3 },
        React.createElement(
          DetailValue,
          { label: "Role execution kind" },
          agent.kind
        ),
        React.createElement(
          DetailValue,
          { label: "Session concurrency limit" },
          // Unobserved is not zero, and null is Unlimited. The fact directly
          // beside this renders "Not observed" for the same missing block, so
          // a reader must never see "null" or a fabricated zero.
          concurrencyLimit(concurrency?.effectivePerSessionLimit)
        ),
        React.createElement(
          DetailValue,
          { label: "Active subagent threads" },
          concurrency?.activeSubagentThreads === undefined
            ? NOT_OBSERVED_LABEL
            : String(concurrency.activeSubagentThreads)
        )
      )
    ),
    agent.systemPrompt === undefined
      ? React.createElement(
          "section",
          {
            className: `${DETAIL_PANEL_CLASS} ${MUTED_TEXT_CLASS}`,
            "data-prompt-state": "unavailable"
          },
          "Role prompt content is unavailable."
        )
      : React.createElement(
          "section",
          {
            className: DETAIL_PANEL_CLASS,
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
          React.createElement(CodeBlock, {
            content: agent.systemPrompt,
            ariaLabel: "Agent system prompt"
          })
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
        className: SECTION_HEADING_CLASS
      },
      heading
    ),
    // The shared chip list rather than a second hand-typed one: this copy
    // carried its own geometry and, with it, no `max-w-full` and no
    // `truncate`, so a long skill or MCP identifier ran out of the panel
    // instead of ellipsing inside it. `className` restyles every chip while
    // keeping the shared chip presentation -- radius, padding, truncation.
    chipList({
      items: names,
      className: "font-mono",
      emptyLabel: "None configured",
      testId: "agent-names"
    })
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
    DetailValue,
    { label, valueClassName: null },
    React.createElement(StatusBadge, { status })
  );
}
