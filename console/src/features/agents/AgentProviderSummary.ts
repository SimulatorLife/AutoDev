import type {
  AgentDefinition,
  ControlApiProvidersResponse,
  ProviderRole
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  NOT_OBSERVED_LABEL,
  type StatusBadgeVariant,
  StatusDot
} from "../../components/status/StatusBadge.ts";
import { Chip } from "../../components/tables/Chips.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import { providerPath } from "../providers/paths.ts";

/**
 * Read-only summary of the providers an agent role may route to, with each
 * provider's enablement for the role kind the agent runs as. Provider controls
 * live on Providers; this summary only links there.
 *
 * Each provider is one chip carrying a status dot rather than a spelled-out
 * badge. A role that can reach five providers would otherwise stack five
 * "claude Enabled" lines and triple the height of every row in the table.
 */
export function AgentProviderSummary({
  agent,
  providers
}: {
  readonly agent: AgentDefinition;
  readonly providers?: ControlApiProvidersResponse | undefined;
}): React.JSX.Element {
  if (agent.providers.length === 0) {
    return React.createElement(
      "span",
      { className: MUTED_META_CLASS },
      "None configured"
    );
  }
  const role: ProviderRole =
    agent.kind === "orchestrator" ? "orchestrator" : "subagent";
  return React.createElement(
    "ul",
    {
      className: "flex flex-wrap list-none items-center gap-1 p-0 m-0",
      "data-agent-providers": role
    },
    ...agent.providers.map((provider) => {
      const record = providers?.providers.find(
        (entry) => entry.id === provider
      );
      const enabled = record?.roles[role].enabled;
      const status: StatusBadgeVariant =
        enabled === undefined
          ? "not-observed"
          : enabled
            ? "valid"
            : "unavailable";
      const state =
        enabled === undefined
          ? NOT_OBSERVED_LABEL
          : enabled
            ? "Enabled"
            : "Disabled";
      return React.createElement(
        "li",
        { key: provider, className: "flex min-w-0 items-center" },
        React.createElement(
          Chip,
          {
            href: providerPath(provider),
            className: "gap-1.5 font-mono"
          },
          React.createElement(StatusDot, { status, label: state }),
          provider
        )
      );
    })
  );
}
