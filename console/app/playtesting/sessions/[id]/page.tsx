import type { Metadata } from "next";
import React from "react";

import { parsePlaytestingScope } from "../../../../src/features/playtesting/playtesting-url.ts";
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
  fetchPlaytestingEpisode,
  fetchPlaytestingWindow
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
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Playtesting episode could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  const detail = result.data;
  const requestedStep = scope.step ?? 0;
  let window: Awaited<ReturnType<typeof fetchPlaytestingWindow>> | null = null;
  let windowUnavailable: string | undefined;
  if (detail.record.trace !== null && detail.record.stepCount > 0) {
    if (requestedStep >= detail.record.stepCount) {
      windowUnavailable = `Step ${requestedStep} is outside this episode's recorded range.`;
    } else {
      const startStep = Math.max(0, requestedStep - 5);
      const endStep = Math.min(detail.record.stepCount - 1, requestedStep + 5);
      const windowResult = await fetchPlaytestingWindow(
        {
          workspaceId: scope.workspaceId,
          episodeId: id,
          artifactId: detail.record.trace.id,
          startStep,
          endStep
        },
        config
      );
      if (windowResult.kind === "ok") window = windowResult;
      else
        windowUnavailable = `${controlApiFailureCode(windowResult)}: ${windowResult.message}`;
    }
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
