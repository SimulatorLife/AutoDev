import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import { GithubView } from "../../src/features/github/GithubView.ts";
import {
  controlApiFailureCode,
  fetchGithubWorkflows
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "GitHub"
};

export default function GithubPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/github");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("GitHub workflow definitions")
    );
  }
  // The read starts here and is not awaited.
  const result = fetchGithubWorkflows(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(GithubContent, { section, result })
  );
}

/**
 * The workflow catalog the Runtime confirmed, or the reason it could not
 * answer.
 *
 * The read is awaited here, inside the page's own pending boundary. The shell
 * is rendered by the same component that read the data, so the navigation's
 * count arrives with the read instead of being resolved in the browser.
 */
async function GithubContent({
  section,
  result
}: {
  readonly section: CanonicalNavSection;
  readonly result: Promise<Awaited<ReturnType<typeof fetchGithubWorkflows>>>;
}): Promise<React.JSX.Element> {
  const settled = await result;
  if (settled.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "GitHub workflow definitions could not be loaded",
        code: controlApiFailureCode(settled),
        message: settled.message
      })
    );
  }
  if (settled.data.catalogStatus !== "valid") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title:
          settled.data.catalogStatus === "invalid"
            ? "GitHub workflow source is invalid"
            : "GitHub workflow source is unavailable",
        code:
          settled.data.catalogStatus === "invalid"
            ? "autodev_github_catalog_invalid"
            : "autodev_github_catalog_unavailable",
        message:
          settled.data.catalogStatus === "invalid"
            ? "A workflow file under .github/workflows could not be parsed; no workflow count is inferred."
            : ".github/workflows is missing or unreadable; no workflow count is inferred."
      })
    );
  }
  const workflows = settled.data.workflows;
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Repository workflow definitions, cron schedules, and observed GitHub Actions runs.",
      counts: { GitHub: workflows.length }
    },
    React.createElement(GithubView, {
      workflows,
      runtimeFactsAvailable: settled.data.runtimeFactsAvailable,
      runtimeStatus: settled.data.runtimeStatus,
      runtimeMessage: settled.data.runtimeMessage,
      repository: settled.data.repository,
      stats: settled.data.stats,
      recentRuns: settled.data.recentRuns
    })
  );
}
