import type { Metadata } from "next";
import React from "react";

import { McpsView } from "../../src/features/mcps/McpsView.ts";
import {
  controlApiFailureCode,
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
  const result = await fetchMcps(config);
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
  return React.createElement(
    ConsolePageShell,
    { section, counts: result.data.valid ? { MCPs: servers.length } : {} },
    React.createElement(McpsView, {
      servers,
      sourceValidity: result.data.valid,
      validationIssues: result.data.issues
    })
  );
}
