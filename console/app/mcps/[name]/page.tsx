import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { McpDetailView } from "../../../src/features/mcps/McpDetailView.ts";
import {
  controlApiFailureCode,
  fetchMcps,
  fetchTools
} from "../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.ts";

export const dynamic = "force-dynamic";

function firstSearchParam(
  raw: string | string[] | undefined
): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
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
  const { name } = await params;
  return { title: `${name} · MCPs` };
}

export default async function McpDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly name: string }>;
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const [{ name }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams ??
      Promise.resolve({} as Record<string, string | string[] | undefined>)
  ]);
  const activeTab = firstSearchParam(resolvedSearchParams.tab);
  const { section, config } = readNodeContext("/mcps");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("MCP server configuration")
    );
  }

  // The reads start here and are not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const mcps = fetchMcps(config);
  const tools = activeTab === "tools" ? fetchTools(config) : null;

  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(McpDetailContent, {
      section,
      mcps,
      tools,
      name,
      activeTab
    })
  );
}

/**
 * The MCP server the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while it is on its way.
 */
async function McpDetailContent({
  section,
  mcps: mcpsPromise,
  tools: toolsPromise,
  name,
  activeTab
}: {
  readonly section: CanonicalNavSection;
  readonly mcps: Promise<Awaited<ReturnType<typeof fetchMcps>>>;
  readonly tools: Promise<Awaited<ReturnType<typeof fetchTools>>> | null;
  readonly name: string;
  readonly activeTab: string | undefined;
}): Promise<React.JSX.Element> {
  const [result, toolsResult] = await Promise.all([mcpsPromise, toolsPromise]);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "MCP server details could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  if (!result.data.valid) notFound();
  const server = result.data.servers.find((entry) => entry.name === name);
  if (!server) notFound();

  return React.createElement(
    ConsolePageShell,
    { section, counts: { MCPs: result.data.servers.length } },
    React.createElement(McpDetailView, {
      server,
      sourceValidity: result.data.valid,
      configuredTools:
        toolsResult?.kind === "ok" && toolsResult.data.coverage === "partial"
          ? toolsResult.data.tools.filter((tool) => tool.server === server.name)
          : null,
      activeTab
    })
  );
}
