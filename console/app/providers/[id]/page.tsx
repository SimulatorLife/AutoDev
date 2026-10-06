import { notFound } from "next/navigation";
import React from "react";

import { isControlFailure } from "../../../src/features/providers/paths.ts";
import { ProviderDetailView } from "../../../src/features/providers/ProviderDetailView.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviders,
  readControlApiConfig
} from "../../../src/lib/server/control-api.ts";
import { ResourceUnavailable } from "../../_console.ts";

export const dynamic = "force-dynamic";

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
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read provider configuration."
    });
  }
  const query = (await searchParams) ?? {};
  const [providersResult, modelsResult] = await Promise.all([
    fetchProviders(config),
    fetchModels(config)
  ]);
  if (providersResult.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Provider details could not be loaded",
      code: controlApiFailureCode(providersResult),
      message: providersResult.message
    });
  }
  const provider = providersResult.data.providers.find(
    (entry) => entry.id === id
  );
  if (!provider) notFound();

  return React.createElement(ProviderDetailView, {
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
  });
}
