import React from "react";

import { isControlFailure } from "../../src/features/providers/paths.ts";
import { ProvidersView } from "../../src/features/providers/ProvidersView.ts";
import {
  controlApiFailureCode,
  fetchModels,
  fetchProviders
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

interface ProvidersPageProps {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}

export default async function ProvidersPage({
  searchParams
}: ProvidersPageProps): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/providers");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read provider configuration."
      })
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
