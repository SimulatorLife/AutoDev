import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
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
  ConsolePendingPage,
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
  const [{ name: rawName }, sp] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as ToolDetailSearchParams)
  ]);
  const decoded = decodeURIComponent(rawName);
  const { section, config } = readNodeContext("/tools");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("tool catalog data")
    );
  }

  // The reads start here and are not awaited.
  const result = fetchTools(config);
  const usageResult = loadOpenLITUsage({
    range: "24H",
    values: {},
    customRange: {
      startDate: first(sp.startDate),
      endDate: first(sp.endDate)
    }
  });
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(ToolDetailContent, {
      section,
      result,
      usageResult,
      decoded
    })
  );
}

/**
 * The tool the Runtime confirmed, or the reason it could not answer.
 *
 * The reads are awaited here, inside the page's own pending boundary, so the
 * shell and the placeholder are one answer rather than two.
 */
async function ToolDetailContent({
  section,
  result,
  usageResult,
  decoded
}: {
  readonly section: CanonicalNavSection;
  readonly result: Promise<Awaited<ReturnType<typeof fetchTools>>>;
  readonly usageResult: Promise<Awaited<ReturnType<typeof loadOpenLITUsage>>>;
  readonly decoded: string;
}): Promise<React.JSX.Element> {
  const [settled, usageSettled] = await Promise.all([result, usageResult]);
  if (settled.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Tool details could not be loaded",
        code: controlApiFailureCode(settled),
        message: settled.message
      })
    );
  }

  const tool = settled.data.tools.find(
    (entry) =>
      entry.name === decoded ||
      `mcp__${entry.server ?? ""}__${entry.name}` === decoded ||
      `${entry.source}:${entry.server ?? ""}:${entry.name}` === decoded
  );
  if (!tool) notFound();

  const usage =
    usageSettled.kind === "ok"
      ? filterToolCatalogUsage(usageSettled.data, tool)
      : { calls: null, errors: null, observed: false };

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(ToolDetailView, {
      tool,
      coverage: settled.data.coverage,
      validity: settled.data.validity,
      usage,
      usageLink: settled.data.usageLink,
      usageUnavailable:
        usageSettled.kind !== "ok" && usageSettled.kind !== "not-configured"
    })
  );
}
