import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { ModelDetailView } from "../../../../../src/features/providers/ModelDetailView.ts";
import { isControlFailure } from "../../../../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviderModelDiscovery,
  fetchProviders,
  fetchRuntime
} from "../../../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../../../_console.ts";

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
  readonly params: Promise<{ readonly model: string; readonly id: string }>;
}): Promise<Metadata> {
  const { model } = await params;
  return { title: `${model} · Models` };
}

export default async function ModelDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly id: string; readonly model: string }>;
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const { id, model: modelId } = await params;
  const { section, config } = readNodeContext("/providers");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("model configuration")
    );
  }
  const query = (await searchParams) ?? {};
  // The reads start here and are not awaited: the page renders its shell
  // first, so the operator sees the surface they asked for while the Runtime
  // is asked for its answer.
  const models = fetchModels(config);
  const providers = fetchProviders(config);
  const discovery = fetchProviderModelDiscovery(config);
  const runtime = fetchRuntime(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(ModelDetailContent, {
      section,
      id,
      modelId,
      models,
      providers,
      discovery,
      runtime,
      control: query.control
    })
  );
}

/**
 * The model the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * shell and the placeholder are already on screen while it is on its way.
 */
async function ModelDetailContent({
  section,
  id,
  modelId,
  models: modelsPromise,
  providers: providersPromise,
  discovery: discoveryPromise,
  runtime: runtimePromise,
  control
}: {
  readonly section: CanonicalNavSection;
  readonly id: string;
  readonly modelId: string;
  readonly models: Promise<Awaited<ReturnType<typeof fetchModels>>>;
  readonly providers: Promise<Awaited<ReturnType<typeof fetchProviders>>>;
  readonly discovery: Promise<
    Awaited<ReturnType<typeof fetchProviderModelDiscovery>>
  >;
  readonly runtime: Promise<Awaited<ReturnType<typeof fetchRuntime>>>;
  readonly control: string | string[] | undefined;
}): Promise<React.JSX.Element> {
  const [modelsResult, providersResult, discoveryResult, runtimeResult] =
    await Promise.all([
      modelsPromise,
      providersPromise,
      discoveryPromise,
      runtimePromise
    ]);
  if (modelsResult.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Model details could not be loaded",
        code: controlApiFailureCode(modelsResult),
        message: modelsResult.message
      })
    );
  }
  const model = modelsResult.data.models.find(
    (entry) => entry.id === modelId && entry.provider === id
  );
  if (!model) notFound();
  const providers =
    providersResult.kind === "ok" ? providersResult.data.providers : null;

  return React.createElement(
    ConsolePageShell,
    {
      section,
      counts:
        providersResult.kind === "ok"
          ? { Providers: providersResult.data.providers.length }
          : undefined
    },
    React.createElement(ModelDetailView, {
      model,
      provider: providers?.find((entry) => entry.id === model.provider) ?? null,
      modelDiscovery:
        discoveryResult.kind === "ok"
          ? { status: "available", data: discoveryResult.data }
          : { status: "unavailable", message: discoveryResult.message },
      runtime: runtimeResult.kind === "ok" ? runtimeResult.data : undefined,
      controlFailed: isControlFailure(control)
    })
  );
}
