import type { Metadata } from "next";
import React from "react";

import { readPromptsQuery } from "../../src/features/prompts/prompts-list-url.ts";
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
  const catalogue = promptsFromControlApi(result.data);
  // The catalogue is two independent reads -- the RuleSync command catalogue
  // and the canonical role-prompt directory -- and the response says whether
  // the second one happened.
  const rolePromptsObserved = result.data.rolePrompts !== null;
  // The catalogue is fully observed only when both reads were.
  const catalogueObserved = result.data.valid === true && rolePromptsObserved;
  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The navigation counts the resource, not the query that narrowed it:
      // the sidebar answers "how many prompts are there", and the filter bar
      // answers "how many are in view".
      //
      // The count is published only when the catalogue was fully observed.
      // The entries that arrived are the ones the read that succeeded
      // produced, and their number is exactly right for what arrived and
      // incomplete for what the unread source would have contributed.
      ...(catalogueObserved ? { counts: { Prompts: catalogue.length } } : {})
    },
    React.createElement(PromptsView, {
      // The whole catalogue and the query, not the narrowed list: the
      // narrowing is applied in the view, because the stat row above the
      // table is about the catalogue and not about the view of it.
      commands: catalogue,
      query,
      commandSourceValidity: result.data.valid,
      rolePromptsObserved,
      validationIssues: result.data.issues
    })
  );
}
