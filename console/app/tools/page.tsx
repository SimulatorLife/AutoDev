import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import { ToolsView } from "../../src/features/tools/ToolsView.ts";
import {
  controlApiFailureCode,
  fetchTools
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

interface ToolsSearchParams {
  readonly source?: string | string[] | undefined;
  readonly role?: string | string[] | undefined;
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

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

  // The read starts here and is not awaited.
  const result = fetchTools(config);
  const query = ((await searchParams) ?? {}) as ToolsSearchParams;
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(ToolsContent, { section, result, query })
  );
}

/**
 * The tool catalog the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, inside the page's own pending boundary. The shell
 * is rendered by the same component that read the data, so the navigation's
 * count arrives with the read instead of being resolved in the browser.
 */
async function ToolsContent({
  section,
  result,
  query
}: {
  readonly section: CanonicalNavSection;
  readonly result: Promise<Awaited<ReturnType<typeof fetchTools>>>;
  readonly query: ToolsSearchParams;
}): Promise<React.JSX.Element> {
  const settled = await result;
  if (settled.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Tool catalog could not be loaded",
        code: controlApiFailureCode(settled),
        message: settled.message
      })
    );
  }
  const sourceFilter = first(query.source);
  const roleFilter = first(query.role);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Effective tool catalog across native, MCP, plugin, and app capabilities.",
      // The badge counts the rows the table renders, not the envelope's
      // `totalTools`. Both claimed to be "how many tools there are", and they
      // can disagree: a payload carrying two entries under a `totalTools` of 1
      // put "1" in the sidebar and "Showing 2 of 2 tool entries" on the page it
      // links to. Counting what was observed removes the second authority.
      counts: { Tools: settled.data.tools.length }
    },
    React.createElement(ToolsView, {
      tools: settled.data.tools,
      coverage: settled.data.coverage,
      validity: settled.data.validity,
      usageLink: settled.data.usageLink,
      filters: { source: sourceFilter, role: roleFilter }
    })
  );
}
