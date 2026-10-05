import React from "react";

import { PromptsView } from "../../src/features/prompts/PromptsView.ts";
import {
  controlApiFailureCode,
  fetchPrompts
} from "../../src/lib/server/control-api.ts";
import { promptsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export default async function PromptsPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/prompts");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read canonical prompts."
      })
    );
  }
  const result = await fetchPrompts(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Prompts could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  const commands = promptsFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      ...(result.data.valid === true
        ? { counts: { Prompts: commands.length } }
        : {})
    },
    React.createElement(PromptsView, {
      commands,
      commandSourceValidity: result.data.valid
    })
  );
}
