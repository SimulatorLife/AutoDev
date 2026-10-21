import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { AgentDetailView } from "../../../src/features/agents/AgentDetailView.ts";
import {
  isControlFailure,
  readControlRefusal
} from "../../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchAgentDetail,
  fetchProviders,
  fetchRuntime
} from "../../../src/lib/server/control-api.ts";
import { agentDetailFromControlApi } from "../../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
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
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
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
  const query = (await searchParams) ?? {};

  // `/control/runtime` already publishes the validated `concurrency` projection
  // alongside `lifecycle` and `liveAgents`, so fetching `/control/routing` as
  // well was a redundant round-trip that let the two disagree if one failed.
  //
  // The reads start here and are not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const detail = fetchAgentDetail(id, config);
  const providers = fetchProviders(config);
  const runtime = fetchRuntime(config);

  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(AgentDetailContent, {
      section,
      detail,
      providers,
      runtime,
      control: query.control,
      refusal: query.refusal
    })
  );
}

/**
 * The agent the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while it is on its way.
 */
async function AgentDetailContent({
  section,
  detail: detailPromise,
  providers: providersPromise,
  runtime: runtimePromise,
  control,
  refusal
}: {
  readonly section: CanonicalNavSection;
  readonly detail: Promise<Awaited<ReturnType<typeof fetchAgentDetail>>>;
  readonly providers: Promise<Awaited<ReturnType<typeof fetchProviders>>>;
  readonly runtime: Promise<Awaited<ReturnType<typeof fetchRuntime>>>;
  readonly control: string | string[] | undefined;
  readonly refusal: string | string[] | undefined;
}): Promise<React.JSX.Element> {
  const [detailResult, providersResult, runtimeResult] = await Promise.all([
    detailPromise,
    providersPromise,
    runtimePromise
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

  const providers =
    providersResult.kind === "ok" ? providersResult.data : undefined;
  const runtime = runtimeResult.kind === "ok" ? runtimeResult.data : undefined;

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(AgentDetailView, {
      agent: agentDetailFromControlApi(detailResult.data),
      reconciliation: detailResult.data.reconciliation,
      providers,
      runtime,
      controlFailed: isControlFailure(control),
      controlRefusal: readControlRefusal(refusal)
    })
  );
}
