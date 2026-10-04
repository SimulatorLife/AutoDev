import React from "react";

import { GithubView } from "../../src/features/github/GithubView.ts";
import {
  controlApiFailureCode,
  fetchGithubWorkflows
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

export default async function GithubPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/github");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read GitHub workflow definitions."
      })
    );
  }
  const result = await fetchGithubWorkflows(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "GitHub workflow definitions could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  if (result.data.catalogStatus !== "valid") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title:
          result.data.catalogStatus === "invalid"
            ? "GitHub workflow source is invalid"
            : "GitHub workflow source is unavailable",
        code:
          result.data.catalogStatus === "invalid"
            ? "autodev_github_catalog_invalid"
            : "autodev_github_catalog_unavailable",
        message:
          result.data.catalogStatus === "invalid"
            ? "A workflow file under .github/workflows could not be parsed; no workflow count is inferred."
            : ".github/workflows is missing or unreadable; no workflow count is inferred."
      })
    );
  }
  const workflows = result.data.workflows;
  return React.createElement(
    ConsolePageShell,
    { section, counts: { GitHub: workflows.length } },
    React.createElement(GithubView, {
      workflows,
      runtimeFactsAvailable: result.data.runtimeFactsAvailable,
      runtimeStatus: result.data.runtimeStatus,
      runtimeMessage: result.data.runtimeMessage,
      repository: result.data.repository,
      stats: result.data.stats,
      recentRuns: result.data.recentRuns
    })
  );
}
