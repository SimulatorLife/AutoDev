import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { ProviderDetailView } from "../../../src/features/providers/ProviderDetailView.ts";
import { ProviderUsagePanel } from "../../../src/features/providers/ProviderUsagePanel.ts";
import { isControlFailure } from "../../../src/lib/control-failure.ts";
import { controlApiFailureCode } from "../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";
import { readProvidersSurface } from "../providers-reads.ts";

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
  return { title: `${id} · Providers` };
}

export default async function ProviderDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const { section, config } = readNodeContext("/providers");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("provider configuration")
    );
  }
  const query = (await searchParams) ?? {};
  // There is no telemetry read here at all. The usage panel's seven-day
  // aggregation is the slowest thing this page would otherwise ask for by an
  // order of magnitude, and it answers a question about one panel rather
  // than about the page, so the browser reads it and the panel fills in when
  // it answers. The page itself is about the provider, and the Control API
  // answers that in milliseconds.
  const {
    providers: providersResult,
    models: modelsResult,
    modelDiscovery: discoveryResult,
    providerVersions: versionsResult,
    runtime: runtimeResult
  } = await readProvidersSurface(config, {
    includeModels: true,
    includeProviderVersions: true
  });
  if (providersResult.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Provider details could not be loaded",
        code: controlApiFailureCode(providersResult),
        message: providersResult.message
      })
    );
  }
  const provider = providersResult.data.providers.find(
    (entry) => entry.id === id
  );
  if (!provider) notFound();

  return React.createElement(
    ConsolePageShell,
    {
      section,
      counts: { Providers: providersResult.data.providers.length }
    },
    React.createElement(ProviderDetailView, {
      provider,
      tiers: providersResult.data.tiers,
      orchestratorTier: providersResult.data.orchestratorTier,
      models:
        modelsResult.kind === "ok"
          ? modelsResult.data.models.filter(
              (model) => model.provider === provider.id
            )
          : null,
      modelDiscovery:
        discoveryResult.kind === "ok"
          ? { status: "available", data: discoveryResult.data }
          : { status: "unavailable", message: discoveryResult.message },
      cliVersions:
        versionsResult.kind === "ok"
          ? { status: "available", data: versionsResult.data }
          : { status: "unavailable", message: versionsResult.message },
      usagePanel: React.createElement(ProviderUsagePanel, { provider }),
      runtime: runtimeResult.kind === "ok" ? runtimeResult.data : undefined,
      controlFailed: isControlFailure(query.control)
    })
  );
}
