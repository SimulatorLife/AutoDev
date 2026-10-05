import React from "react";

import { McpsView } from "../../src/features/mcps/McpsView.ts";
import {
  controlApiFailureCode,
  fetchMcps,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { ResourceUnavailable } from "../_console.tsx";

export const dynamic = "force-dynamic";

export default async function McpsPage(): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read MCP server configuration."
    });
  }
  const result = await fetchMcps(config);
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "MCP servers could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }
  const servers = result.data.servers;
  return React.createElement(McpsView, {
    servers,
    sourceValidity: result.data.valid
  });
}
