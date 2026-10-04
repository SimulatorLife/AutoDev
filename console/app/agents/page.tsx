import React from "react";

import { AgentsView } from "../../src/features/agents/AgentsView.ts";
import {
  controlApiFailureCode,
  fetchAgents,
  fetchProviders,
  fetchRouting,
  fetchRuntime
} from "../../src/lib/server/control-api.ts";
import { agentsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

interface AgentsPageProps {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}

function hasProviderRoleFailure(raw: string | string[] | undefined): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "failed";
}

export default async function AgentsPage({
  searchParams
}: AgentsPageProps): Promise<React.JSX.Element> {
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
  const resolvedSearchParams = (await searchParams) ?? {};
  const providerRoleFailed = hasProviderRoleFailure(
    resolvedSearchParams.providerRole
  );
  const [agentsResult, providersResult, routingResult, runtimeResult] =
    await Promise.all([
      fetchAgents(config),
      fetchProviders(config),
      fetchRouting(config),
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
  const routing = routingResult.kind === "ok" ? routingResult.data : undefined;
  const runtime = runtimeResult.kind === "ok" ? runtimeResult.data : undefined;

  return React.createElement(
    ConsolePageShell,
    { section, counts: { Agents: agents.length } },
    React.createElement(AgentsView, {
      agents,
      providers,
      routing,
      runtime,
      providerRoleFailed
    })
  );
}
