import type { ControlApiProviderRecord } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import {
  type ProviderUsageSource,
  summarizeProviderUsage
} from "../../../src/features/providers/provider-usage.ts";
import {
  ProviderDetailView,
  ProviderUsagePanel,
  ProviderUsagePendingPanel
} from "../../../src/features/providers/ProviderDetailView.ts";
import { isControlFailure } from "../../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviderModelDiscovery,
  fetchProviders,
  fetchRuntime
} from "../../../src/lib/server/control-api.ts";
import { loadOpenLITUsage } from "../../../src/lib/server/openlit-usage.ts";
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

async function ProviderUsageSummarySection({
  provider
}: {
  readonly provider: ControlApiProviderRecord;
}): Promise<React.JSX.Element> {
  let source: ProviderUsageSource;
  try {
    const result = await loadOpenLITUsage({
      range: "7D",
      values: { provider: [provider.id] }
    });
    source =
      result.kind === "not-configured"
        ? { kind: "not-configured" }
        : result.kind === "ok"
          ? {
              kind: "available",
              attemptsByProvider: result.data.metrics.attemptsByProvider,
              attemptErrorsByProvider:
                result.data.metrics.attemptErrorsByProvider
            }
          : { kind: "unavailable" };
  } catch {
    source = { kind: "unavailable" };
  }
  return React.createElement(ProviderUsagePanel, {
    provider,
    summary: summarizeProviderUsage(source, provider.id)
  });
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
  const [providersResult, modelsResult, discoveryResult, runtimeResult] =
    await Promise.all([
      fetchProviders(config),
      fetchModels(config),
      fetchProviderModelDiscovery(config),
      fetchRuntime(config)
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
      modelDiscovery:
        discoveryResult.kind === "ok"
          ? { status: "available", data: discoveryResult.data }
          : { status: "unavailable", message: discoveryResult.message },
      usagePanel: React.createElement(
        React.Suspense,
        {
          fallback: React.createElement(ProviderUsagePendingPanel, { provider })
        },
        React.createElement(ProviderUsageSummarySection, { provider })
      ),
      runtime: runtimeResult.kind === "ok" ? runtimeResult.data : undefined,
      controlFailed: isControlFailure(query.control)
    })
  );
}
