import type { Metadata } from "next";
import React from "react";

import { NavigationLink } from "../../../../src/components/navigation/NavigationLink.ts";
import { MUTED_BODY_CLASS } from "../../../../src/components/ui/text-classes.ts";
import { activeRunOwnsEpisode } from "../../../../src/features/playtesting/playtesting-active-runs.ts";
import {
  defaultEpisodeInspectionStep,
  planEpisodeTraceWindow
} from "../../../../src/features/playtesting/playtesting-episode-presentation.ts";
import {
  playtestingSessionFailureHint,
  playtestingSessionFailureTitle
} from "../../../../src/features/playtesting/playtesting-labels.ts";
import {
  parsePlaytestingScope,
  playtestingInspectorBackHref,
  type PlaytestingScope
} from "../../../../src/features/playtesting/playtesting-url.ts";
import { PlaytestingReadiness } from "../../../../src/features/playtesting/PlaytestingReadiness.tsx";
import { PlaytestingSessionLiveWatch } from "../../../../src/features/playtesting/PlaytestingSessionLiveWatch.ts";
import { PlaytestingSessionView } from "../../../../src/features/playtesting/PlaytestingSessionView.ts";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  type ControlApiResult,
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

/**
 * Whether an in-flight run owns the episode this page is asking for.
 *
 * A missing episode is only "pending" when a live run owns it. Any other
 * missing episode is missing for good, and saying "initializing" for it would
 * leave the operator waiting for something that will never arrive.
 */
async function liveRunOwnsSession(
  workspaceId: string,
  episodeId: string,
  config: ControlApiConfig
): Promise<boolean> {
  const activeRuns = await fetchPlaytestingActiveRuns(workspaceId, config);
  if (activeRuns.kind !== "ok") return false;
  return activeRuns.data.runs.some((run) =>
    activeRunOwnsEpisode(
      {
        batchId: run.batchId,
        assignmentCount: run.assignmentCount,
        createdAt: run.createdAt,
        sessions: run.sessions,
        record: run.status
      },
      episodeId
    )
  );
}

/** The page's answer while the episode's first frames are still being written. */
function sessionPendingContent(episodeId: string): React.JSX.Element {
  return React.createElement(
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
            episodeId +
            " is scheduled or starting in an active playtesting run. Waiting for initial frames and telemetry…"
        )
      ),
      React.createElement(PlaytestingSessionLiveWatch, { isLive: true })
    )
  );
}

/**
 * The page's answer when the episode could not be read.
 *
 * A session id this workspace never recorded is not a server fault. The
 * shared failure shell's default hint tells the operator to configure a
 * server-side integration and restart the Console, which sends them to fix
 * something that is not broken. Say what is actually true instead, and give
 * them the way back to the list they came from.
 */
function sessionFailureContent(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>,
  scope: PlaytestingScope,
  workspaceId: string
): React.JSX.Element {
  const readinessFailure = playtestingReadinessFailure(result);
  if (readinessFailure) {
    return React.createElement(PlaytestingReadiness, {
      workspaceId,
      initialStatus: readinessFailure.status,
      initialCode: readinessFailure.code,
      initialMessage: readinessFailure.message
    });
  }
  const failure = {
    code: controlApiFailureCode(result),
    message: result.message,
    notFound: result.kind === "http-error" && result.status === 404
  };
  const hint = playtestingSessionFailureHint(failure);
  return React.createElement(
    "div",
    { className: "grid gap-4" },
    React.createElement(ResourceUnavailable, {
      title: playtestingSessionFailureTitle(failure),
      code: failure.code,
      message: failure.message,
      ...(hint === null ? {} : { hint })
    }),
    React.createElement(
      NavigationLink,
      {
        href: playtestingInspectorBackHref(scope),
        className: "text-sm text-accent hover:underline",
        dataAttributes: { "data-playtesting-back": "true" }
      },
      "← Back to sessions"
    )
  );
}

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
    const hasActiveRun = await liveRunOwnsSession(
      scope.workspaceId,
      id,
      config
    );
    return React.createElement(
      ConsolePageShell,
      { section },
      hasActiveRun
        ? sessionPendingContent(id)
        : sessionFailureContent(result, scope, scope.workspaceId)
    );
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
