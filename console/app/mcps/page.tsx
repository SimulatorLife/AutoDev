import type { Metadata } from "next";
import React from "react";

import { McpsView } from "../../src/features/mcps/McpsView.ts";
import {
  controlApiFailureCode,
  fetchMcpRuntime,
  fetchMcps
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MCPs"
};

export default async function McpsPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/mcps");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("MCP server configuration")
    );
  }
  // Two reads, fetched together. The catalog is the configuration read and
  // the runtime read is the observation; the page composes them, and neither
  // read has to carry the other's claim.
  const [result, runtimeResult] = await Promise.all([
    fetchMcps(config),
    fetchMcpRuntime(config)
  ]);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "MCP servers could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  const servers = result.data.servers;
  // An unreadable observation read is not an empty observation. The page
  // reports the evidence as unavailable rather than reporting no servers.
  const runtime = runtimeResult.kind === "ok" ? runtimeResult.data : null;
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Canonical RuleSync MCP server declarations, role assignments, and target overrides.",
      counts: result.data.valid ? { MCPs: servers.length } : {}
    },
    React.createElement(McpsView, {
      servers,
      runtime,
      sourceValidity: result.data.valid,
      validationIssues: result.data.issues
    })
  );
}
