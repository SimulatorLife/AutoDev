import type { Metadata } from "next";
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
  controlApiCredentialUnavailable,
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

/**
 * The resource's own name, taken from the route parameter rather than from a
 * second fetch of the resource. The page body already reads the same
 * parameter, and a metadata function that fetched would double every
 * detail-page request.
 */
export async function generateMetadata({
  params
}: {
  readonly params: Promise<{ readonly name: string }>;
}): Promise<Metadata> {
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);
  return { title: `${name} · Tools` };
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
      controlApiCredentialUnavailable("tool catalog data")
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
