import React from "react";

import { ToolsView } from "../../src/features/tools/ToolsView.ts";
import {
  controlApiFailureCode,
  fetchTools,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { ResourceUnavailable } from "../_console.ts";

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
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read tool catalog data."
    });
  }

  const [result, resolvedSearch] = await Promise.all([
    fetchTools(config),
    searchParams ?? Promise.resolve<ToolsSearchParams>({})
  ]);
  const sourceFilter = first(resolvedSearch.source);
  const roleFilter = first(resolvedSearch.role);
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Tool catalog could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }

  return React.createElement(ToolsView, {
    tools: result.data.tools,
    coverage: result.data.coverage,
    validity: result.data.validity,
    totalTools: result.data.totalTools,
    usageLink: result.data.usageLink,
    filters: { source: sourceFilter, role: roleFilter }
  });
}
