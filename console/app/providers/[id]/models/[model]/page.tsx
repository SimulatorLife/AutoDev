import { notFound } from "next/navigation";
import React from "react";

import { ModelDetailView } from "../../../../../src/features/providers/ModelDetailView.ts";
import { isControlFailure } from "../../../../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviders
} from "../../../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../../../../_console.ts";

export const dynamic = "force-dynamic";

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
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read model configuration."
      })
    );
  }
  const query = (await searchParams) ?? {};
  const [modelsResult, providersResult] = await Promise.all([
    fetchModels(config),
    fetchProviders(config)
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
      counts: providers ? { Providers: providers.length } : undefined
    },
    React.createElement(ModelDetailView, {
      model,
      provider: providers?.find((entry) => entry.id === model.provider) ?? null,
      controlFailed: isControlFailure(query.control)
    })
  );
}
