import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import { AgentsView } from "../../src/features/agents/AgentsView.ts";
import {
  isControlFailure,
  readControlRefusal
} from "../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchAgents,
  fetchProviders,
  fetchRuntime
} from "../../src/lib/server/control-api.ts";
import { agentsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agents"
};

export default async function AgentsPage({
  searchParams
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/agents");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("agent configuration")
    );
  }
  const query = (await searchParams) ?? {};
  // Runtime state is read from `/control/runtime`, which publishes the same
  // concurrency projection as `/control/routing` alongside lifecycle and drain
  // state. Routing is not fetched here any more: the page composes runtime
  // evidence, so reading a second copy of the same counters would only add a
  // way for the two to disagree.
  //
  // The reads start here and are not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const agents = fetchAgents(config);
  const providers = fetchProviders(config);
  const runtime = fetchRuntime(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(AgentsContent, {
      section,
      agents,
      providers,
      runtime,
      control: query.control,
      refusal: query.refusal
    })
  );
}

/**
 * The agents the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while it is on its way.
 */
async function AgentsContent({
  section,
  agents: agentsPromise,
  providers: providersPromise,
  runtime: runtimePromise,
  control,
  refusal
}: {
  readonly section: CanonicalNavSection;
  readonly agents: Promise<Awaited<ReturnType<typeof fetchAgents>>>;
  readonly providers: Promise<Awaited<ReturnType<typeof fetchProviders>>>;
  readonly runtime: Promise<Awaited<ReturnType<typeof fetchRuntime>>>;
  readonly control: string | string[] | undefined;
  readonly refusal: string | string[] | undefined;
}): Promise<React.JSX.Element> {
  const [agentsResult, providersResult, runtimeResult] = await Promise.all([
    agentsPromise,
    providersPromise,
    runtimePromise
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
    {
      section,
      description:
        "Configured agent roles, runtime enablement, concurrency limits, and effective provider routing.",
      counts: { Agents: agents.length }
    },
    React.createElement(AgentsView, {
      agents,
      providers,
      runtime,
      controlFailed: isControlFailure(control),
      controlRefusal: readControlRefusal(refusal)
    })
  );
}
