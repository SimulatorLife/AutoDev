import type { Metadata } from "next";
import React from "react";

import { ChatgptTunnelPanel } from "../../src/features/mcps/ChatgptTunnelPanel.ts";
import { McpsView } from "../../src/features/mcps/McpsView.ts";
import {
  controlApiFailureCode,
  fetchChatgptTunnel,
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

export default async function McpsPage({ searchParams }: { searchParams?: Promise<{ tunnel?: string | string[] }> } = {}): Promise<React.JSX.Element> {
  const tunnelOutcome = (await searchParams)?.tunnel;
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
  const [result, runtimeResult, tunnelResult] = await Promise.all([
    fetchMcps(config),
    fetchMcpRuntime(config),
    fetchChatgptTunnel(config)
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
      counts: result.data.valid ? { MCPs: servers.length } : {}
    },
    tunnelOutcome === "ok" || tunnelOutcome === "failed" ? React.createElement("p", { role: "status" }, tunnelOutcome === "ok" ? "ChatGPT tunnel settings updated." : "ChatGPT tunnel update failed; review status and installer diagnostics.") : null,
    React.createElement(ChatgptTunnelPanel, { status: tunnelResult.kind === "ok" ? tunnelResult.data : null }),
    React.createElement(McpsView, {
      servers,
      runtime,
      sourceValidity: result.data.valid,
      validationIssues: result.data.issues
    })
  );
}
