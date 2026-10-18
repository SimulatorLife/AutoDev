import type { Metadata } from "next";
import React from "react";

import {
  defaultEpisodeInspectionStep,
  planEpisodeTraceWindow
} from "../../../../src/features/playtesting/playtesting-episode-presentation.ts";
import { parsePlaytestingScope } from "../../../../src/features/playtesting/playtesting-url.ts";
import { PlaytestingReadiness } from "../../../../src/features/playtesting/PlaytestingReadiness.tsx";
import { activeRunOwnsEpisode } from "../../../../src/features/playtesting/playtesting-active-runs.ts";
import { PlaytestingSessionLiveWatch } from "../../../../src/features/playtesting/PlaytestingSessionLiveWatch.ts";
import { MUTED_BODY_CLASS } from "../../../../src/components/ui/text-classes.ts";
import { PlaytestingSessionView } from "../../../../src/features/playtesting/PlaytestingSessionView.ts";
import {
  controlApiFailureCode,
  fetchWorkspaces
} from "../../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../../_console.ts";
import {
  fetchPlaytestingActiveRuns,
  fetchPlaytestingEpisode,
  fetchPlaytestingWindow,
  playtestingReadinessFailure
} from "../../playtesting-server.ts";

export const dynamic = "force-dynamic";

interface PlaytestingSessionPageProps {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}

export const metadata: Metadata = {
  title: "Playtesting session"
};

export default async function PlaytestingSessionPage({
  params,
  searchParams
}: PlaytestingSessionPageProps): Promise<React.JSX.Element> {
  const [{ id }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({})
  ]);
  const scope = parsePlaytestingScope(query);
  const { section, config } = readNodeContext("/playtesting");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("Playtesting session evidence")
    );
  }
  if (!scope.workspaceId || scope.invalidQuery) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Session workspace or URL state is invalid",
        code: "autodev_control_playtesting_invalid_query",
        message:
          "Open this episode from a workspace-scoped Playtesting list so its source and filters remain explicit."
      })
    );
  }

  const [workspaces, result] = await Promise.all([
    fetchWorkspaces(config),
    fetchPlaytestingEpisode(scope.workspaceId, id, config)
  ]);
  if (workspaces.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Workspace catalog is unavailable",
        code: controlApiFailureCode(workspaces),
        message: workspaces.message
      })
    );
  }
  if (
    workspaces.data.catalogStatus !== "valid" ||
    !workspaces.data.workspaces.some(
      (workspace) => workspace.id === scope.workspaceId
    )
  ) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Workspace is unavailable",
        code: "autodev_control_playtesting_workspace_not_found",
        message:
          "The selected workspace is not present in the canonical Workspaces catalog."
      })
    );
  }

  if (result.kind !== "ok") {
    const activeRuns = await fetchPlaytestingActiveRuns(
      scope.workspaceId,
      config
    );
    const hasActiveRun =
      activeRuns.kind === "ok" &&
      activeRuns.data.runs.some((run) =>
        activeRunOwnsEpisode(
          {
            batchId: run.batchId,
            assignmentCount: run.assignmentCount,
            createdAt: run.createdAt,
            record: run.status
          },
          id
        )
      );
    if (hasActiveRun) {
      return React.createElement(
        ConsolePageShell,
        { section },
        React.createElement(
          "section",
          {
            className:
              "space-y-4 rounded-xl border border-border bg-surface-raised p-6 shadow-sm",
            "data-testid": "session-pending-state"
          },
          React.createElement(
            "div",
            { className: "flex flex-wrap items-center justify-between gap-4" },
            React.createElement(
              "div",
              null,
              React.createElement(
                "h2",
                { className: "text-lg font-semibold text-fg" },
                "Session Initializing"
              ),
              React.createElement(
                "p",
                { className: MUTED_BODY_CLASS },
                "Episode " +
                  id +
                  " is scheduled or starting in an active playtesting run. Waiting for initial frames and telemetry…"
              )
            ),
            React.createElement(PlaytestingSessionLiveWatch, { isLive: true })
          )
        )
      );
    }

    const readinessFailure = playtestingReadinessFailure(result);
    const content = readinessFailure
      ? React.createElement(PlaytestingReadiness, {
          workspaceId: scope.workspaceId,
          initialStatus: readinessFailure.status,
          initialCode: readinessFailure.code,
          initialMessage: readinessFailure.message
        })
      : React.createElement(ResourceUnavailable, {
          title: "Playtesting episode could not be loaded",
          code: controlApiFailureCode(result),
          message: result.message
        });
    return React.createElement(ConsolePageShell, { section }, content);
  }

  const detail = result.data;
  const requestedStep =
    scope.step ?? defaultEpisodeInspectionStep(detail.record) ?? 0;
  const traceWindowPlan = planEpisodeTraceWindow(detail.record, requestedStep);
  let window: Awaited<ReturnType<typeof fetchPlaytestingWindow>> | null = null;
  let windowUnavailable: string | undefined;
  if (traceWindowPlan.kind === "outside-range") {
    windowUnavailable = `Step ${requestedStep} is outside this episode's recorded range.`;
  }
  if (traceWindowPlan.kind === "window") {
    const windowResult = await fetchPlaytestingWindow(
      {
        workspaceId: scope.workspaceId,
        episodeId: id,
        artifactId: traceWindowPlan.artifactId,
        startStep: traceWindowPlan.startStep,
        endStep: traceWindowPlan.endStep
      },
      config
    );
    if (windowResult.kind === "ok") window = windowResult;
    else
      windowUnavailable = `${controlApiFailureCode(windowResult)}: ${windowResult.message}`;
  }

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(PlaytestingSessionView, {
      detail,
      scope,
      window: window?.kind === "ok" ? window.data : null,
      ...(windowUnavailable === undefined ? {} : { windowUnavailable })
    })
  );
}
