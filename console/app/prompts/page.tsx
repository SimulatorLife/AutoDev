import React from "react";

import { PromptsView } from "../../src/features/prompts/PromptsView.ts";
import {
  controlApiFailureCode,
  fetchPrompts,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { promptsFromControlApi } from "../../src/lib/server/views.ts";
import { ResourceUnavailable } from "../_console.ts";

export const dynamic = "force-dynamic";

export default async function PromptsPage(): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read canonical prompts."
    });
  }
  const result = await fetchPrompts(config);
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Prompts could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }
  const commands = promptsFromControlApi(result.data);
  return React.createElement(PromptsView, {
    commands,
    commandSourceValidity: result.data.valid
  });
}
