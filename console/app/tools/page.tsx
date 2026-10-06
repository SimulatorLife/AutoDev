import React from "react";

import { ToolsView } from "../../src/features/tools/ToolsView.ts";
import {
  controlApiFailureCode,
  fetchTools
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
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
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read tool catalog data."
      })
    );
  }

  const result = await fetchTools(config);
  const resolvedSearch = (await searchParams) ?? {};
  const sourceFilter = first(resolvedSearch.source);
  const roleFilter = first(resolvedSearch.role);
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
      counts: { Tools: result.data.tools.length }
    },
    React.createElement(ToolsView, {
      tools: result.data.tools,
      coverage: result.data.coverage,
      validity: result.data.validity,
      usageLink: result.data.usageLink,
      filters: { source: sourceFilter, role: roleFilter }
    })
  );
}
