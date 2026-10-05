import type {
  AgentDefinition,
  ControlApiProvidersResponse,
  ProviderRole
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { providerPath } from "../providers/paths.ts";

/**
 * Read-only summary of the providers an agent role may route to, with each
 * provider's enablement for the role kind the agent runs as. Provider controls
 * live on Providers; this summary only links there.
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
      { className: "text-xs text-fg-muted" },
      "None configured"
    );
  }
  const role: ProviderRole =
    agent.kind === "orchestrator" ? "orchestrator" : "subagent";
  return React.createElement(
    "ul",
    {
      className: "flex flex-wrap gap-2 list-none p-0 m-0",
      "data-agent-providers": role
    },
    ...agent.providers.map((provider) => {
      const record = providers?.providers.find(
        (entry) => entry.id === provider
      );
      const enabled = record?.roles[role].enabled;
      return React.createElement(
        "li",
        { key: provider, className: "flex items-center gap-1.5" },
        React.createElement(
          "a",
          {
            href: providerPath(provider),
            className:
              "font-mono text-xs text-fg underline-offset-4 hover:underline",
            "aria-label": `Open provider ${provider}`
          },
          provider
        ),
        React.createElement(StatusBadge, {
          status:
            enabled === undefined
              ? "not-observed"
              : enabled
                ? "valid"
                : "unavailable",
          label:
            enabled === undefined
              ? "Not observed"
              : enabled
                ? "Enabled"
                : "Disabled"
        })
      );
    })
  );
}
