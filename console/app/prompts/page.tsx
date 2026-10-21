import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
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
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Prompts"
};

export default function PromptsPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/prompts");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("canonical prompts")
    );
  }
  // The read starts here and is not awaited.
  const result = fetchPrompts(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(PromptsContent, { section, result })
  );
}

/**
 * The prompts the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, inside the page's own pending boundary. The shell
 * is rendered by the same component that read the data, so the navigation's
 * count arrives with the read instead of being resolved in the browser.
 */
async function PromptsContent({
  section,
  result
}: {
  readonly section: CanonicalNavSection;
  readonly result: Promise<Awaited<ReturnType<typeof fetchPrompts>>>;
}): Promise<React.JSX.Element> {
  const settled = await result;
  if (settled.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Prompts could not be loaded",
        code: controlApiFailureCode(settled),
        message: settled.message
      })
    );
  }
  const commands = promptsFromControlApi(settled.data);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Canonical RuleSync command prompts, validation status, and target projections.",
      // An invalid command source has no count to state.
      ...(settled.data.valid === true
        ? { counts: { Prompts: commands.length } }
        : {})
    },
    React.createElement(PromptsView, {
      commands,
      commandSourceValidity: settled.data.valid,
      validationIssues: settled.data.issues
    })
  );
}
