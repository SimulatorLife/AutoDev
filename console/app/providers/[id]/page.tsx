import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { ProviderDetailView } from "../../../src/features/providers/ProviderDetailView.ts";
import { isControlFailure } from "../../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviders
} from "../../../src/lib/server/control-api.ts";
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
  const [providersResult, modelsResult] = await Promise.all([
    fetchProviders(config),
    fetchModels(config)
  ]);
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
      controlFailed: isControlFailure(query.control)
    })
  );
}
