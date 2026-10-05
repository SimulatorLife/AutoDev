import { notFound } from "next/navigation";
import React from "react";

import { filterToolCatalogUsage } from "../../../src/features/tools/tool-usage.ts";
import { ToolDetailView } from "../../../src/features/tools/ToolDetailView.ts";
import {
  controlApiFailureCode,
  fetchTools
} from "../../../src/lib/server/control-api.ts";
import { loadOpenLITUsage } from "../../../src/lib/server/openlit-usage.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";

export const dynamic = "force-dynamic";

interface ToolDetailSearchParams {
  readonly range?: string | string[] | undefined;
  readonly startDate?: string | string[] | undefined;
  readonly endDate?: string | string[] | undefined;
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function ToolDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly name: string }>;
  readonly searchParams?: Promise<ToolDetailSearchParams>;
}): Promise<React.JSX.Element> {
  const { name: rawName } = await params;
  const decoded = decodeURIComponent(rawName);
  const { section, config } = readNodeContext("/tools");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read tool catalog data."
      })
    );
  }

  const result = await fetchTools(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Tool details could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  const tool = result.data.tools.find(
    (entry) =>
      entry.name === decoded ||
      `mcp__${entry.server ?? ""}__${entry.name}` === decoded ||
      `${entry.source}:${entry.server ?? ""}:${entry.name}` === decoded
  );
  if (!tool) notFound();

  const sp = (await searchParams) ?? {};
  const usageResult = await loadOpenLITUsage({
    range: "24H",
    values: {},
    customRange: { startDate: first(sp.startDate), endDate: first(sp.endDate) }
  });
  const usage =
    usageResult.kind === "ok"
      ? filterToolCatalogUsage(usageResult.data, tool)
      : { calls: null, errors: null, observed: false };

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(ToolDetailView, {
      tool,
      coverage: result.data.coverage,
      validity: result.data.validity,
      usage,
      usageLink: result.data.usageLink,
      usageUnavailable:
        usageResult.kind !== "ok" && usageResult.kind !== "not-configured"
    })
  );
}
