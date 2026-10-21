import type {
  CanonicalNavSection,
  ControlApiProviderRecord
} from "@simulatorlife/autodev-core";
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
  // The reads start here and are not awaited: the page renders its shell
  // first, so the operator sees the surface they asked for while the Runtime
  // is asked for its answer.
  const providers = fetchProviders(config);
  const models = fetchModels(config);
  const discovery = fetchProviderModelDiscovery(config);
  const runtime = fetchRuntime(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(ProviderDetailContent, {
      section,
      id,
      providers,
      models,
      discovery,
      runtime,
      control: query.control
    })
  );
}

/**
 * The provider the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * shell and the placeholder are already on screen while it is on its way.
 */
async function ProviderDetailContent({
  section,
  id,
  providers: providersPromise,
  models: modelsPromise,
  discovery: discoveryPromise,
  runtime: runtimePromise,
  control
}: {
  readonly section: CanonicalNavSection;
  readonly id: string;
  readonly providers: Promise<Awaited<ReturnType<typeof fetchProviders>>>;
  readonly models: Promise<Awaited<ReturnType<typeof fetchModels>>>;
  readonly discovery: Promise<
    Awaited<ReturnType<typeof fetchProviderModelDiscovery>>
  >;
  readonly runtime: Promise<Awaited<ReturnType<typeof fetchRuntime>>>;
  readonly control: string | string[] | undefined;
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
      controlFailed: isControlFailure(control)
    })
  );
}
