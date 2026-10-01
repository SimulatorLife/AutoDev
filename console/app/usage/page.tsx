import type { UsageFilterSelection } from "@simulatorlife/autodev-core";
import React from "react";

import { UsageView } from "../../src/features/usage/UsageView.ts";
import {
  loadOpenLITUsage,
  type UsageSearchParams,
  usageSelectionFromSearchParams
} from "../../src/lib/server/openlit-usage.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

interface UsagePageProps {
  readonly searchParams: Promise<UsageSearchParams>;
}

export default async function UsagePage({
  searchParams
}: UsagePageProps): Promise<React.JSX.Element> {
  const { section } = readNodeContext("/usage");
  const selection: UsageFilterSelection = usageSelectionFromSearchParams(
    await searchParams
  );
  const result = await loadOpenLITUsage(selection);
  if (result.kind === "not-configured") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "OpenLIT Usage credential is not configured",
        code: "autodev_usage_credentials_disabled",
        message:
          "Set AUTODEV_OPENLIT_USAGE_TOKEN in the Next.js server environment to read telemetry.",
        hint: "The Usage token is server-only and is never sent to the browser."
      }),
      React.createElement(UsageView, { selection })
    );
  }

  if (result.kind !== "ok") {
    const code =
      result.kind === "unreachable"
        ? "autodev_openlit_usage_unreachable"
        : result.kind === "unauthorized"
          ? "autodev_openlit_usage_unauthorized"
          : `autodev_openlit_usage_http_${result.status}`;
    const title =
      result.kind === "unreachable"
        ? "OpenLIT Usage could not be reached"
        : result.kind === "unauthorized"
          ? "OpenLIT Usage rejected the server credential"
          : "OpenLIT Usage query failed";
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title,
        code,
        message:
          result.kind === "unreachable"
            ? "The OpenLIT Usage endpoint is unavailable or returned an invalid response."
            : `The OpenLIT Usage endpoint returned HTTP ${result.status}.`,
        hint: "Telemetry values remain not observed until OpenLIT returns validated query data."
      }),
      React.createElement(UsageView, { selection })
    );
  }

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(UsageView, {
      metrics: result.data.metrics,
      filterOptions: result.data.filterOptions,
      selection
    })
  );
}
