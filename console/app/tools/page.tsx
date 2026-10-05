import React from "react";

import { ToolsView } from "../../src/features/tools/ToolsView.ts";
import {
  controlApiFailureCode,
  fetchTools,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { ResourceUnavailable } from "../_console.ts";

export const dynamic = "force-dynamic";

export default async function ToolsPage(): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read tool catalog data."
    });
  }

  const result = await fetchTools(config);
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Tool catalog could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }

  return React.createElement(ToolsView, {
    tools: result.data.tools,
    coverage: result.data.coverage
  });
}
