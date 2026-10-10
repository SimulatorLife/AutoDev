import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { AgentDetailView } from "../../../src/features/agents/AgentDetailView.ts";
import {
  controlApiFailureCode,
  fetchAgentDetail,
  fetchProviders,
  fetchRouting,
  fetchRuntime
} from "../../../src/lib/server/control-api.ts";
import { agentDetailFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";

export const dynamic = "force-dynamic";

/**
 * The resource's own name, taken from the route parameter rather than from a
 * second fetch of the resource. The page body already reads the same
 * parameter, and a metadata function that fetched would double every
 * detail-page request.
 */
export async function generateMetadata({
  params
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `${id} · Agents` };
}

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
      controlApiCredentialUnavailable("agent configuration")
    );
  }

  const [detailResult, routingResult, providersResult, runtimeResult] =
    await Promise.all([
      fetchAgentDetail(id, config),
      fetchRouting(config),
      fetchProviders(config),
      fetchRuntime(config)
    ]);

  if (detailResult.kind === "http-error" && detailResult.status === 404) {
    notFound();
  }
  if (detailResult.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Agent details could not be loaded",
        code: controlApiFailureCode(detailResult),
        message: detailResult.message
      })
    );
  }

  const routing = routingResult.kind === "ok" ? routingResult.data : undefined;
  const providers =
    providersResult.kind === "ok" ? providersResult.data : undefined;
  const runtime = runtimeResult.kind === "ok" ? runtimeResult.data : undefined;

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(AgentDetailView, {
      agent: agentDetailFromControlApi(detailResult.data),
      reconciliation: detailResult.data.reconciliation,
      routing,
      providers,
      runtime
    })
  );
}
