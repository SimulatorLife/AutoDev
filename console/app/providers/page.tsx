import type { Metadata } from "next";
import React from "react";

import { ProvidersView } from "../../src/features/providers/ProvidersView.ts";
import { isControlFailure } from "../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviders
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
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
  const [providersResult, modelsResult] = await Promise.all([
    fetchProviders(config),
    fetchModels(config)
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
  const tab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The shared shell already renders a purpose statement; this page simply
      // had not passed one, which is why the header named the surface without
      // saying what the surface is for.
      description:
        "Configure which providers to use, which models to use for each role, and agent spawn limits.",
      counts: { Providers: providersResult.data.providers.length }
    },
    React.createElement(ProvidersView, {
      providers: providersResult.data,
      models:
        modelsResult.kind === "ok"
          ? { status: "available", data: modelsResult.data }
          : { status: "unavailable", message: modelsResult.message },
      activeTab: tab,
      controlFailed: isControlFailure(query.control)
    })
  );
}
