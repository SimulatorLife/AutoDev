import type { Metadata } from "next";
import React from "react";

import { readToolsFilters } from "../../src/features/tools/tools-list-url.ts";
import { ToolsView } from "../../src/features/tools/ToolsView.ts";
import {
  controlApiFailureCode,
  fetchTools
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

type ToolsSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export const metadata: Metadata = {
  title: "Tools"
};

export default async function ToolsPage({
  searchParams
}: {
  readonly searchParams?: Promise<ToolsSearchParams>;
}): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/tools");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("tool catalog data")
    );
  }

  const [result, resolvedSearch] = await Promise.all([
    fetchTools(config),
    (searchParams ?? Promise.resolve({})) as Promise<ToolsSearchParams>
  ]);
  const listFilters = readToolsFilters(resolvedSearch);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Tool catalog could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The badge counts the rows the table renders, not the envelope's
      // `totalTools`. Both claimed to be "how many tools there are", and they
      // can disagree: a payload carrying two entries under a `totalTools` of 1
      // put "1" in the sidebar and "Showing 2 of 2 tool entries" on the page it
      // links to. Counting what was observed removes the second authority.
      //
      // It is published only when the catalogue was fully observed. The
      // catalogue is a composite of two independent reads, and the rows that
      // arrived are the ones the read that succeeded produced -- exactly right
      // for what arrived and incomplete for what the unread source would have
      // contributed. A badge with no number says the count is not known; a
      // badge with that number would state a catalogue size nobody established.
      counts:
        result.data.validity === "valid" &&
        result.data.executionContractObserved
          ? { Tools: result.data.tools.length }
          : {}
    },
    React.createElement(ToolsView, {
      tools: result.data.tools,
      coverage: result.data.coverage,
      validity: result.data.validity,
      executionContractObserved: result.data.executionContractObserved,
      usageLink: result.data.usageLink,
      filters: listFilters
    })
  );
}
