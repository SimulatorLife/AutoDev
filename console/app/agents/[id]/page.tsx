import { notFound } from "next/navigation";
import React from "react";

import { AgentDetailView } from "../../../src/features/agents/AgentDetailView.ts";
import {
  controlApiFailureCode,
  fetchAgentDetail,
  fetchProviders,
  fetchRouting,
  readControlApiConfig
} from "../../../src/lib/server/control-api.ts";
import { agentDetailFromControlApi } from "../../../src/lib/server/views.ts";
import { ResourceUnavailable } from "../../_console.ts";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read agent configuration."
    });
  }

  const [detailResult, routingResult, providersResult] = await Promise.all([
    fetchAgentDetail(id, config),
    fetchRouting(config),
    fetchProviders(config)
  ]);

  if (detailResult.kind === "http-error" && detailResult.status === 404) {
    notFound();
  }
  if (detailResult.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Agent details could not be loaded",
      code: controlApiFailureCode(detailResult),
      message: detailResult.message
    });
  }

  const routing = routingResult.kind === "ok" ? routingResult.data : undefined;
  const providers =
    providersResult.kind === "ok" ? providersResult.data : undefined;

  return React.createElement(AgentDetailView, {
    agent: agentDetailFromControlApi(detailResult.data),
    routing,
    providers
  });
}
