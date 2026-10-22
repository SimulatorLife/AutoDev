import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { McpDetailView } from "../../../src/features/mcps/McpDetailView.ts";
import {
  controlApiFailureCode,
  fetchMcpApplied,
  fetchMcpRuntime,
  fetchMcps,
  fetchTools
} from "../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
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

  // Three MCP reads, fetched together: the declaration, what the Runtime has
  // reached, and what the Runtime applied. Each answers a different question
  // and the page composes them.
  const [result, runtimeResult, appliedResult, toolsResult] = await Promise.all(
    [
      fetchMcps(config),
      fetchMcpRuntime(config),
      fetchMcpApplied(config),
      activeTab === "tools" ? fetchTools(config) : Promise.resolve(null)
    ]
  );
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
  // The whole observation read is handed to the view, which joins it by name:
  // a server the Runtime has never seen has no record in it, and an
  // unreadable read is a different state again.
  const runtime = runtimeResult.kind === "ok" ? runtimeResult.data : null;
  // An unreadable applied read is not an applied configuration with nothing in
  // it, and the page says which of the two it is.
  const applied = appliedResult.kind === "ok" ? appliedResult.data : null;

  return React.createElement(
    ConsolePageShell,
    { section, counts: { MCPs: result.data.servers.length } },
    React.createElement(McpDetailView, {
      server,
      runtime,
      applied,
      revision: result.data.revision,
      sourceValidity: result.data.valid,
      configuredTools:
        toolsResult?.kind === "ok" && toolsResult.data.coverage === "partial"
          ? toolsResult.data.tools.filter((tool) => tool.server === server.name)
          : null,
      activeTab
    })
  );
}
