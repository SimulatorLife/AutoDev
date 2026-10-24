import type { Metadata } from "next";
import React from "react";

import { readGithubFilters } from "../../src/features/github/github-list-url.ts";
import { GithubView } from "../../src/features/github/GithubView.ts";
import {
  controlApiFailureCode,
  fetchGithubWorkflows
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "GitHub"
};

export default async function GithubPage({
  searchParams
}: {
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/github");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("GitHub workflow definitions")
    );
  }
  const [result, resolvedSearch] = await Promise.all([
    fetchGithubWorkflows(config),
    (searchParams ??
      Promise.resolve(
        {} as Record<string, string | readonly string[] | undefined>
      )) as Promise<Record<string, string | readonly string[] | undefined>>
  ]);
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
  const listFilters = readGithubFilters(resolvedSearch);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      counts: { GitHub: workflows.length }
    },
    React.createElement(GithubView, {
      workflows,
      runtimeFactsAvailable: result.data.runtimeFactsAvailable,
      runtimeStatus: result.data.runtimeStatus,
      runtimeMessage: result.data.runtimeMessage,
      repository: result.data.repository,
      stats: result.data.stats,
      recentRuns: result.data.recentRuns,
      outcome: listFilters.outcome,
      state: listFilters.state
    })
  );
}
