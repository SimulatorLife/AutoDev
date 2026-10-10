import type {
  ControlApiPlaytestingResource,
  PlaytestComparison,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import {
  parsePlaytestingScope,
  PLAYTESTING_FILTERS_BY_RESOURCE,
  type PlaytestingFilterKey,
  type PlaytestingScope
} from "../../src/features/playtesting/playtesting-url.ts";
import {
  type PlaytestingHumanValidation,
  type PlaytestingListData,
  type PlaytestingOverviewData,
  PlaytestingView
} from "../../src/features/playtesting/PlaytestingView.ts";
import type { PlaytestingRunSetup } from "../../src/features/playtesting/PlaytestingRunControls.tsx";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  type ControlApiResult,
  fetchWorkspaces
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";
import {
  fetchPlaytestingHumanValidation,
  fetchPlaytestingPage,
  fetchPlaytestingRunCapabilities,
  type PlaytestingPageRequest
} from "./playtesting-server.ts";

export const dynamic = "force-dynamic";

interface PlaytestingPageProps {
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}

const HUMAN_NOT_COLLECTED = "not-collected" as const;
const IMMUTABLE_BUILD_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;

export const metadata: Metadata = {
  title: "Playtesting"
};

interface OverviewLoadSuccess {
  readonly kind: "overview";
  readonly data: PlaytestingOverviewData;
  readonly runSetup: PlaytestingRunSetup;
}

interface ListLoadSuccess {
  readonly kind: "list";
  readonly data: PlaytestingListData;
}

interface ViewLoadFailure {
  readonly kind: "unavailable";
  readonly result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>;
}

type ViewLoadResult = OverviewLoadSuccess | ListLoadSuccess | ViewLoadFailure;

function resourceUnavailable(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): React.JSX.Element {
  return React.createElement(ResourceUnavailable, {
    title: "Playtesting data is unavailable",
    code: controlApiFailureCode(result),
    message: result.message
  });
}

function pageRequest(
  scope: PlaytestingScope,
  resource: ControlApiPlaytestingResource,
  limit = scope.limit
): PlaytestingPageRequest {
  const filters: Partial<Record<PlaytestingFilterKey, string>> = {};
  for (const key of PLAYTESTING_FILTERS_BY_RESOURCE[resource]) {
    const value = scope.filters[key];
    if (value) filters[key] = value;
  }
  return {
    workspaceId: scope.workspaceId!,
    limit,
    ...(scope.cursor === null ? {} : { cursor: scope.cursor }),
    filters
  };
}

function firstFailure(
  results: readonly ControlApiResult<unknown>[]
): ViewLoadFailure | null {
  const result = results.find((item) => item.kind !== "ok");
  if (result === undefined) return null;
  return { kind: "unavailable", result };
}

async function loadOverview(
  scope: PlaytestingScope,
  config: ControlApiConfig
): Promise<ViewLoadResult> {
  const [batches, episodes, findings, comparisons, capabilities] =
    await Promise.all([
      fetchPlaytestingPage("batches", pageRequest(scope, "batches", 5), config),
      fetchPlaytestingPage(
        "episodes",
        pageRequest(scope, "episodes", 5),
        config
      ),
      fetchPlaytestingPage(
        "findings",
        pageRequest(scope, "findings", 1),
        config
      ),
      fetchPlaytestingPage(
        "comparisons",
        pageRequest(scope, "comparisons", 1),
        config
      ),
      fetchPlaytestingRunCapabilities(scope.workspaceId!, config)
    ]);
  const failure = firstFailure([batches, episodes, findings, comparisons]);
  if (failure !== null) return failure;
  if (
    batches.kind !== "ok" ||
    episodes.kind !== "ok" ||
    findings.kind !== "ok" ||
    comparisons.kind !== "ok"
  ) {
    return {
      kind: "unavailable",
      result: {
        kind: "invalid-response",
        code: "autodev_control_playtesting_invalid_response",
        message:
          "The Playtesting overview could not validate all workspace-scoped summaries."
      }
    };
  }
  return {
    kind: "overview",
    data: {
      batches: batches.data.page.rows,
      batchCount: batches.data.page.total,
      episodeCount: episodes.data.page.total,
      findingCount: findings.data.page.total,
      comparisonCount: comparisons.data.page.total,
      latestEpisodes: episodes.data.page.rows
    },
    runSetup:
      capabilities.kind === "ok"
        ? { kind: "available", capabilities: capabilities.data }
        : {
            kind: "unavailable",
            code: controlApiFailureCode(capabilities),
            message: capabilities.message
          }
  };
}

async function loadHumanValidation(
  scope: PlaytestingScope,
  comparisons: readonly PlaytestComparison[],
  config: ControlApiConfig
): Promise<PlaytestingHumanValidation> {
  const comparison = comparisons[0];
  if (!comparison) {
    return {
      kind: HUMAN_NOT_COLLECTED,
      reason:
        "Human validation is available when a comparison selects a candidate build."
    };
  }
  const benchmarkId = scope.filters.benchmarkId ?? comparison.benchmarkId;
  const studies = await fetchPlaytestingPage(
    "human-studies",
    {
      workspaceId: scope.workspaceId!,
      limit: 50,
      filters: { benchmarkId, approved: "true" }
    },
    config
  );
  if (studies.kind !== "ok") {
    return {
      kind: "unavailable",
      code: controlApiFailureCode(studies),
      message: studies.message
    };
  }
  const study = studies.data.page.rows.find(
    (candidate) => candidate.approved && candidate.benchmarkId === benchmarkId
  );
  if (!study) {
    return {
      kind: HUMAN_NOT_COLLECTED,
      reason:
        "No approved, consent-scoped human study is registered for this benchmark."
    };
  }
  if (!IMMUTABLE_BUILD_SHA_PATTERN.test(comparison.candidate.id)) {
    return {
      kind: HUMAN_NOT_COLLECTED,
      reason:
        "The comparison candidate has no immutable build SHA for human-label linkage."
    };
  }
  const result = await fetchPlaytestingHumanValidation(
    scope.workspaceId!,
    study.studyId,
    comparison.candidate.id,
    config
  );
  if (result.kind !== "ok") {
    return {
      kind: "unavailable",
      code: controlApiFailureCode(result),
      message: result.message
    };
  }
  if (result.data.summary === null) {
    return {
      kind: HUMAN_NOT_COLLECTED,
      reason: "No retained responses are available for this build and study."
    };
  }
  return { kind: "available", studyId: study.studyId, data: result.data };
}

async function loadList(
  scope: PlaytestingScope,
  config: ControlApiConfig
): Promise<ViewLoadResult> {
  if (scope.view === "sessions") {
    const result = await fetchPlaytestingPage(
      "episodes",
      pageRequest(scope, "episodes"),
      config
    );
    if (result.kind !== "ok") return { kind: "unavailable", result };
    return {
      kind: "list",
      data: {
        resource: "episodes",
        rows: result.data.page.rows,
        total: result.data.page.total,
        nextCursor: result.data.page.nextCursor
      }
    };
  }
  if (scope.view === "findings") {
    const result = await fetchPlaytestingPage(
      "findings",
      pageRequest(scope, "findings"),
      config
    );
    if (result.kind !== "ok") return { kind: "unavailable", result };
    return {
      kind: "list",
      data: {
        resource: "findings",
        rows: result.data.page.rows,
        total: result.data.page.total,
        nextCursor: result.data.page.nextCursor
      }
    };
  }
  const result = await fetchPlaytestingPage(
    "comparisons",
    pageRequest(scope, "comparisons"),
    config
  );
  if (result.kind !== "ok") return { kind: "unavailable", result };
  const humanValidation = await loadHumanValidation(
    scope,
    result.data.page.rows,
    config
  );
  return {
    kind: "list",
    data: {
      resource: "comparisons",
      rows: result.data.page.rows,
      total: result.data.page.total,
      nextCursor: result.data.page.nextCursor,
      humanValidation
    }
  };
}

function pageResult(
  section: ReturnType<typeof readNodeContext>["section"],
  scope: PlaytestingScope,
  workspaces: readonly WorkspaceEntry[],
  loaded: ViewLoadResult
): React.JSX.Element {
  let content: React.ReactNode;
  if (loaded.kind === "unavailable")
    content = resourceUnavailable(loaded.result);
  else if (loaded.kind === "overview") {
    content = React.createElement(PlaytestingView, {
      scope,
      workspaces,
      overview: loaded.data,
      runSetup: loaded.runSetup
    });
  } else {
    content = React.createElement(PlaytestingView, {
      scope,
      workspaces,
      list: loaded.data
    });
  }
  return React.createElement(ConsolePageShell, { section }, content);
}

export default async function PlaytestingPage({
  searchParams
}: PlaytestingPageProps): Promise<React.JSX.Element> {
  const params = searchParams ? await searchParams : {};
  const scope = parsePlaytestingScope(params);
  const { section, config } = readNodeContext("/playtesting");
  if (config === null) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("Playtesting history")
    );
  }

  if (scope.workspaceId === null) {
    const workspaceResult = await fetchWorkspaces(config);
    if (workspaceResult.kind !== "ok") {
      return React.createElement(
        ConsolePageShell,
        { section },
        resourceUnavailable(workspaceResult)
      );
    }
    if (workspaceResult.data.catalogStatus !== "valid") {
      return React.createElement(
        ConsolePageShell,
        { section },
        React.createElement(ResourceUnavailable, {
          title: "Workspace catalog is unavailable",
          code: "autodev_control_api_workspace_catalog_unavailable",
          message:
            "Playtesting requires a valid canonical workspace catalog before it can query scoped history."
        })
      );
    }
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(PlaytestingView, {
        scope,
        workspaces: workspaceResult.data.workspaces
      })
    );
  }

  const [workspaceResult, loaded] = await Promise.all([
    fetchWorkspaces(config),
    scope.view === "overview"
      ? loadOverview(scope, config)
      : loadList(scope, config)
  ]);

  if (workspaceResult.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      resourceUnavailable(workspaceResult)
    );
  }
  if (workspaceResult.data.catalogStatus !== "valid") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Workspace catalog is unavailable",
        code: "autodev_control_api_workspace_catalog_unavailable",
        message:
          "Playtesting requires a valid canonical workspace catalog before it can query scoped history."
      })
    );
  }

  const workspaces = workspaceResult.data.workspaces;
  if (!workspaces.some((workspace) => workspace.id === scope.workspaceId)) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Workspace not found",
        code: "autodev_control_playtesting_workspace_not_found",
        message:
          "Choose a workspace from the canonical Workspaces catalog. No playtest data was queried."
      })
    );
  }

  return pageResult(section, scope, workspaces, loaded);
}
