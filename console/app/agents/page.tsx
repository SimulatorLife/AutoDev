import React from "react";

import { AgentsView } from "../../src/features/agents/AgentsView.ts";
import {
  controlApiFailureCode,
  fetchAgents
} from "../../src/lib/server/control-api.ts";
import { agentsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

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
  const result = await fetchAgents(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Agents could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  const agents = agentsFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Agents: agents.length } },
    React.createElement(AgentsView, { agents })
  );
}
