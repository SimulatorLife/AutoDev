import React from "react";

import { McpsView } from "../../src/features/mcps/McpsView.ts";
import {
  controlApiFailureCode,
  fetchMcps
} from "../../src/lib/server/control-api.ts";
import { mcpsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

export default async function McpsPage(): Promise<React.JSX.Element> {
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
  const servers = mcpsFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    { section, counts: { MCPs: servers.length } },
    React.createElement(McpsView, { servers })
  );
}
