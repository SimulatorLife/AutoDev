"use client";

/** Coordinates the same-owner run acknowledgement with the live status reader. */
import React, { useCallback, useState } from "react";

import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingLiveRuns } from "./PlaytestingLiveRuns.ts";
import {
  PlaytestingRunControls,
  type PlaytestingRunSetup
} from "./PlaytestingRunControls.tsx";

export function PlaytestingRunDashboard({
  setup,
  scope
}: {
  readonly setup: PlaytestingRunSetup;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const onRunStarted = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(PlaytestingRunControls, {
      setup,
      scope,
      onRunStarted
    }),
    scope.workspaceId
      ? React.createElement(PlaytestingLiveRuns, {
          workspaceId: scope.workspaceId,
          scope,
          initialFocusedBatchId: scope.liveBatchId,
          refreshGeneration
        })
      : null
  );
}
