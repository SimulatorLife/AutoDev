import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import { providersPath } from "../../src/features/providers/paths.ts";
import {
  ProvidersHeaderActions,
  ProvidersView
} from "../../src/features/providers/ProvidersView.ts";
import {
  isControlFailure,
  readControlRefusal
} from "../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviderModelDiscovery,
  fetchProviders,
  fetchRuntime
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

interface ProvidersPageProps {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}

export const metadata: Metadata = {
  title: "Providers"
};

export default async function ProvidersPage({
  searchParams
}: ProvidersPageProps): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/providers");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("provider configuration")
    );
  }
  const query = (await searchParams) ?? {};
  const tab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  // The reads start here and are not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const providers = fetchProviders(config);
  const models = tab === "models" ? fetchModels(config) : null;
  const discovery = fetchProviderModelDiscovery(config);
  const runtime = fetchRuntime(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(ProvidersContent, {
      section,
      providers,
      models,
      discovery,
      runtime,
      tab,
      control: query.control,
      refusal: query.refusal
    })
  );
}

/**
 * The providers the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while it is on its way.
 */
async function ProvidersContent({
  section,
  providers: providersPromise,
  models: modelsPromise,
  discovery: discoveryPromise,
  runtime: runtimePromise,
  tab,
  control,
  refusal
}: {
  readonly section: CanonicalNavSection;
  readonly providers: Promise<Awaited<ReturnType<typeof fetchProviders>>>;
  readonly models: Promise<Awaited<ReturnType<typeof fetchModels>>> | null;
  readonly discovery: Promise<
    Awaited<ReturnType<typeof fetchProviderModelDiscovery>>
  >;
  readonly runtime: Promise<Awaited<ReturnType<typeof fetchRuntime>>>;
  readonly tab: string | undefined;
  readonly control: string | string[] | undefined;
  readonly refusal: string | string[] | undefined;
}): Promise<React.JSX.Element> {
  const [providersResult, modelsResult, discoveryResult, runtimeResult] =
    await Promise.all([
      providersPromise,
      modelsPromise,
      discoveryPromise,
      runtimePromise
    ]);
  if (providersResult.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Providers could not be loaded",
        code: controlApiFailureCode(providersResult),
        message: providersResult.message
      })
    );
  }
  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The shared shell already renders a purpose statement; this page simply
      // had not passed one, which is why the header named the surface without
      // saying what the surface is for.
      description:
        "Configure which providers to use, which models to use for each role, and agent spawn limits.",
      actions: React.createElement(ProvidersHeaderActions, {
        returnTo: providersPath(tab === "models" ? "models" : "providers")
      }),
      counts: { Providers: providersResult.data.providers.length }
    },
    React.createElement(ProvidersView, {
      providers: providersResult.data,
      models:
        modelsResult?.kind === "ok"
          ? { status: "available", data: modelsResult.data }
          : {
              status: "unavailable",
              message: modelsResult?.message ?? "Model catalog was not queried."
            },
      modelDiscovery:
        discoveryResult.kind === "ok"
          ? { status: "available", data: discoveryResult.data }
          : { status: "unavailable", message: discoveryResult.message },
      runtime: runtimeResult.kind === "ok" ? runtimeResult.data : undefined,
      activeTab: tab,
      controlFailed: isControlFailure(control),
      controlRefusal: readControlRefusal(refusal)
    })
  );
}
