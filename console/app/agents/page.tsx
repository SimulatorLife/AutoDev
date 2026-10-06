import React from "react";

import { AgentsView } from "../../src/features/agents/AgentsView.ts";
import {
  controlApiFailureCode,
  fetchAgents,
  fetchProviders,
  fetchRouting,
  fetchRuntime,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { agentsFromControlApi } from "../../src/lib/server/views.ts";
import { ResourceUnavailable } from "../_console.ts";

export const dynamic = "force-dynamic";

export default async function AgentsPage(): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read agent configuration."
    });
  }
  const [agentsResult, providersResult, routingResult, runtimeResult] =
    await Promise.all([
      fetchAgents(config),
      fetchProviders(config),
      fetchRouting(config),
      fetchRuntime(config)
    ]);
  if (agentsResult.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Agents could not be loaded",
      code: controlApiFailureCode(agentsResult),
      message: agentsResult.message
    });
  }

  return React.createElement(AgentsView, {
    agents: agentsFromControlApi(agentsResult.data),
    providers: providersResult.kind === "ok" ? providersResult.data : undefined,
    routing: routingResult.kind === "ok" ? routingResult.data : undefined,
    runtime: runtimeResult.kind === "ok" ? runtimeResult.data : undefined
  });
}
