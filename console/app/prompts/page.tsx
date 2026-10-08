import type { Metadata } from "next";
import React from "react";

import { PromptsView } from "../../src/features/prompts/PromptsView.ts";
import {
  controlApiFailureCode,
  fetchPrompts
} from "../../src/lib/server/control-api.ts";
import { promptsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Prompts"
};

export default async function PromptsPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/prompts");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("canonical prompts")
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
      commandSourceValidity: result.data.valid,
      validationIssues: result.data.issues
    })
  );
}
