import type { Metadata } from "next";
import React from "react";

import {
  filterPrompts,
  readPromptsQuery
} from "../../src/features/prompts/prompts-list-url.ts";
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

interface PromptsPageProps {
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}

export default async function PromptsPage({
  searchParams
}: PromptsPageProps): Promise<React.JSX.Element> {
  const params = searchParams ? await searchParams : {};
  const query = readPromptsQuery(params);
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
  // The list is narrowed on the server, so the narrowed list is the one the
  // address describes: the query is in the URL and the rows are what it
  // selects.
  const matching = filterPrompts(commands, query);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Canonical RuleSync command prompts, validation status, and target projections.",
      // The navigation counts the resource, not the query that narrowed it:
      // the sidebar answers "how many prompts are there", and the filter bar
      // answers "how many are in view".
      ...(result.data.valid === true
        ? { counts: { Prompts: commands.length } }
        : {})
    },
    React.createElement(PromptsView, {
      commands: matching,
      totalCommands: commands.length,
      query,
      commandSourceValidity: result.data.valid,
      validationIssues: result.data.issues
    })
  );
}
