"use client";

/**
 * Coordinates the run start acknowledgement with the one live status owner.
 *
 * The dashboard owns the single workspace-scoped status reader: the start card
 * and the live-runs panel both render its server-read records, and a batch
 * reaching a terminal status reloads the server-rendered results (latest
 * batch, episodes, coverage) so they include it without a manual reload.
 */
import type {
  ControlApiPlaytestingRunRecord,
  ControlApiPlaytestingRunStartedResponse
} from "@simulatorlife/autodev-core";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo } from "react";

import { isTerminal } from "./playtesting-active-runs.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingLiveRuns } from "./PlaytestingLiveRuns.ts";
import {
  PlaytestingRunControls,
  type PlaytestingRunSetup
} from "./PlaytestingRunControls.tsx";
import { usePlaytestingActiveRuns } from "./use-playtesting-active-runs.ts";

export function PlaytestingRunDashboard({
  setup,
  scope
}: {
  readonly setup: PlaytestingRunSetup;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  const router = useRouter();
  const live = usePlaytestingActiveRuns({
    workspaceId: scope.workspaceId ?? null
  });
  const { refresh } = live;
  const onRunStarted = useCallback(
    (started: ControlApiPlaytestingRunStartedResponse) => {
      const record: ControlApiPlaytestingRunRecord = {
        batchId: started.batchId,
        status: started.status,
        cancellationReason: null,
        result: null,
        error: null
      };
      live.trackRun({
        batchId: started.batchId,
        assignmentCount: started.assignmentCount,
        createdAt: started.createdAt,
        record
      });
    },
    [live.trackRun]
  );
  const liveRecords = useMemo(
    () =>
      new Map<string, ControlApiPlaytestingRunRecord>(
        live.state.runs.map((run) => [run.batchId, run.record])
      ),
    [live.state.runs]
  );
  const terminalBatches = live.state.runs
    .filter((run) => isTerminal(run.record))
    .map((run) => run.batchId)
    .join(",");
  useEffect(() => {
    if (terminalBatches) router.refresh();
  }, [router, terminalBatches]);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(PlaytestingRunControls, {
      setup,
      scope,
      onRunStarted,
      liveRecords,
      onRefreshStatus: refresh
    }),
    scope.workspaceId
      ? React.createElement(PlaytestingLiveRuns, {
          workspaceId: scope.workspaceId,
          scope,
          initialFocusedBatchId: scope.liveBatchId,
          live
        })
      : null
  );
}
