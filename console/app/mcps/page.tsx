import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import { McpsView } from "../../src/features/mcps/McpsView.ts";
import {
  controlApiFailureCode,
  fetchMcps
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MCPs"
};

export default function McpsPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/mcps");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("MCP server configuration")
    );
  }
  // The read starts here and is not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const mcps = fetchMcps(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(McpsContent, { section, mcps })
  );
}

/**
 * The MCP servers the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while it is on its way.
 */
async function McpsContent({
  section,
  mcps: mcpsPromise
}: {
  readonly section: CanonicalNavSection;
  readonly mcps: Promise<Awaited<ReturnType<typeof fetchMcps>>>;
}): Promise<React.JSX.Element> {
  const result = await mcpsPromise;
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
    {
      section,
      description:
        "Canonical RuleSync MCP server declarations, role assignments, and target overrides.",
      counts: result.data.valid ? { MCPs: servers.length } : {}
    },
    React.createElement(McpsView, {
      servers,
      sourceValidity: result.data.valid,
      validationIssues: result.data.issues
    })
  );
}
