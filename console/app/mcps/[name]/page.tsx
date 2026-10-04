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
  readNodeContext,
  ResourceUnavailable
} from "../../_console.tsx";

export const dynamic = "force-dynamic";

function firstSearchParam(
  raw: string | string[] | undefined
): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
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
  const { name } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const activeTab = firstSearchParam(resolvedSearchParams.tab);
  const { section, config } = readNodeContext("/mcps");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read MCP server configuration."
      })
    );
  }

  const [result, toolsResult] = await Promise.all([
    fetchMcps(config),
    fetchTools(config)
  ]);
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
        toolsResult.kind === "ok" && toolsResult.data.coverage === "partial"
          ? toolsResult.data.tools.filter((tool) => tool.server === server.name)
          : null,
      activeTab
    })
  );
}
