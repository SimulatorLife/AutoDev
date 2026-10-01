import { notFound } from "next/navigation";
import React from "react";

import { AgentDetailView } from "../../../src/features/agents/AgentDetailView.ts";
import {
  controlApiFailureCode,
  fetchAgentDetail
} from "../../../src/lib/server/control-api.ts";
import { agentDetailFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.tsx";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
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

  const result = await fetchAgentDetail(id, config);
  if (result.kind === "http-error" && result.status === 404) notFound();
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Agent details could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(AgentDetailView, {
      agent: agentDetailFromControlApi(result.data)
    })
  );
}
