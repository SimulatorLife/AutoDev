"use client";

/**
 * Coordinates the run start acknowledgement with the one live status owner.
 *
 * The dashboard owns one workspace-scoped status reader. The start form only
 * submits a typed request; the run-status panel is the sole status surface.
 * A terminal transition refreshes the server-rendered evidence and recent result.
 */
import type {
  ControlApiPlaytestingRunRecord,
  ControlApiPlaytestingRunStartedResponse
} from "@simulatorlife/autodev-core";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useState } from "react";

import {
  cancellationAvailability,
  isTerminal
} from "./playtesting-active-runs.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingLiveRuns } from "./PlaytestingLiveRuns.ts";
import {
  PlaytestingRunControls,
  type PlaytestingRunSetup
} from "./PlaytestingRunControls.tsx";
import { usePlaytestingActiveRuns } from "./use-playtesting-active-runs.ts";

export function PlaytestingRunDashboard({
  setup,
  scope,
  showRunControls = true
}: {
  readonly setup: PlaytestingRunSetup;
  readonly scope: PlaytestingScope;
  readonly showRunControls?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const live = usePlaytestingActiveRuns({
    workspaceId: scope.workspaceId ?? null
  });
  const [focusedBatchId, setFocusedBatchId] = useState(scope.liveBatchId);
  const onRunStarted = useCallback(
    (started: ControlApiPlaytestingRunStartedResponse) => {
      const record: ControlApiPlaytestingRunRecord = {
        batchId: started.batchId,
        status: started.status,
        cancellationReason: null,
        result: null,
        error: null
      };
      setFocusedBatchId(started.batchId);
      live.trackRun({
        batchId: started.batchId,
        assignmentCount: started.assignmentCount,
        createdAt: started.createdAt,
        record
      });
      const url = new URL(globalThis.location.href);
      url.searchParams.set("liveBatch", started.batchId);
      globalThis.history.pushState(null, "", url);
    },
    [live.trackRun]
  );
  const operatorActionsAvailable =
    setup.kind === "available"
      ? setup.capabilities.operatorActionsAvailable
      : null;
  const { allowed: canCancel, reason: cancelUnavailableReason } =
    cancellationAvailability(operatorActionsAvailable);
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
    showRunControls && scope.view === "overview"
      ? React.createElement(PlaytestingRunControls, {
          setup,
          onRunStarted
        })
      : null,
    scope.workspaceId
      ? React.createElement(PlaytestingLiveRuns, {
          workspaceId: scope.workspaceId,
          scope,
          initialFocusedBatchId: focusedBatchId,
          wallTimeMs:
            setup.kind === "available" ? setup.capabilities.limits?.wallTimeMs ?? null : null,
          showEmptyState: showRunControls && scope.view === "overview",
          allowCancel: canCancel,
          cancelUnavailableReason,
          live
        })
      : null
  );
}
