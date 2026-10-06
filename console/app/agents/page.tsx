import React from "react";

import { AgentsView } from "../../src/features/agents/AgentsView.ts";
import {
  controlApiFailureCode,
  fetchAgents,
  fetchProviders,
  fetchRuntime
} from "../../src/lib/server/control-api.ts";
import { agentsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export default async function AgentsPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/agents");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read agent configuration."
      })
    );
  }
  // Runtime state is read from `/control/runtime`, which publishes the same
  // concurrency projection as `/control/routing` alongside lifecycle and drain
  // state. Routing is not fetched here any more: the page composes runtime
  // evidence, so reading a second copy of the same counters would only add a
  // way for the two to disagree.
  const [agentsResult, providersResult, runtimeResult] = await Promise.all([
    fetchAgents(config),
    fetchProviders(config),
    fetchRuntime(config)
  ]);
  if (agentsResult.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Agents could not be loaded",
        code: controlApiFailureCode(agentsResult),
        message: agentsResult.message
      })
    );
  }
  const agents = agentsFromControlApi(agentsResult.data);
  const providers =
    providersResult.kind === "ok" ? providersResult.data : undefined;
  const runtime = runtimeResult.kind === "ok" ? runtimeResult.data : undefined;

  return React.createElement(
    ConsolePageShell,
    { section, counts: { Agents: agents.length } },
    React.createElement(AgentsView, {
      agents,
      providers,
      runtime
    })
  );
}
