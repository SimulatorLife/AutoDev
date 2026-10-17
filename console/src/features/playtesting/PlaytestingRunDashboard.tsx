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
import React, { useCallback, useEffect, useRef, useState } from "react";

import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { workspacePath } from "../workspaces/paths.ts";
import {
  cancellationAvailability,
  isTerminal
} from "./playtesting-active-runs.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingLiveRuns } from "./PlaytestingLiveRuns.ts";
import {
  PlaytestingRunControls,
  type PlaytestingRunSetup,
  playtestingRunSetupBlocker
} from "./PlaytestingRunControls.tsx";
import { usePlaytestingActiveRuns } from "./use-playtesting-active-runs.ts";

function adapterReadinessStatus(
  setup: PlaytestingRunSetup
): "ready" | "check-required" | "unavailable" {
  return setup.kind === "available"
    ? setup.capabilities.modeReadiness["adapter-accelerated"].status
    : "unavailable";
}

function visualModeReadinessCard(
  setup: PlaytestingRunSetup,
  workspaceId: string | null
): React.JSX.Element {
  const readiness =
    setup.kind === "available"
      ? setup.capabilities.modeReadiness["autonomous-visual"]
      : null;
  return React.createElement(
    "section",
    {
      className:
        "rounded-lg border border-border bg-background/50 p-4 opacity-75",
      "aria-label": "Autonomous visual mode readiness",
      "data-playtesting-mode": "autonomous-visual",
      "data-mode-status": readiness?.status ?? "unavailable"
    },
    React.createElement(
      "p",
      { className: "font-semibold" },
      "Autonomous visual"
    ),
    React.createElement(
      "p",
      { className: "mt-1 text-xs font-medium text-fg-muted" },
      readiness?.reasons[0]?.label ?? "Visual readiness unavailable"
    ),
    React.createElement(
      "details",
      { className: "mt-2", "data-testid": "visual-readiness-details" },
      React.createElement(
        "summary",
        { className: "cursor-pointer text-xs text-fg-muted" },
        readiness
          ? "Readiness details (" + String(readiness.reasons.length) + ")"
          : "Readiness details"
      ),
      React.createElement(
        "ul",
        {
          className: "mt-2 grid gap-2 text-xs text-fg-secondary",
          "aria-label": "Autonomous visual readiness reasons"
        },
        ...(readiness?.reasons ?? []).map((reason) =>
          React.createElement(
            "li",
            { key: reason.code },
            React.createElement(
              "span",
              { className: "font-medium" },
              reason.label
            ),
            ": ",
            reason.message
          )
        ),
        readiness === null
          ? React.createElement(
              "li",
              null,
              "Runtime could not read visual mode readiness. This mode will not silently fall back to a headless policy."
            )
          : null
      ),
      readiness && readiness.targets.length > 0
        ? React.createElement(
            "ul",
            {
              className: "mt-3 grid gap-1 text-xs text-fg-muted",
              "aria-label": "Approved visual targets"
            },
            ...readiness.targets.map((target) =>
              React.createElement(
                "li",
                { key: target.targetId },
                target.name +
                  " · " +
                  target.controlTimingClass +
                  " · " +
                  target.entryRequirements +
                  " entry"
              )
            )
          )
        : null
    ),
    workspaceId
      ? React.createElement(
          NavigationLink,
          {
            href: workspacePath(workspaceId),
            className:
              "mt-3 inline-flex text-sm font-medium text-accent hover:underline",
            dataAttributes: {
              "data-playtesting-manage-visual-targets": "true"
            }
          },
          "Manage visual target permissions"
        )
      : null
  );
}

function adapterModeReadinessCard(
  setup: PlaytestingRunSetup
): React.JSX.Element {
  const blocker = playtestingRunSetupBlocker(setup);
  return React.createElement(
    "section",
    {
      className: blocker
        ? "rounded-lg border border-border bg-background/50 p-4"
        : "rounded-lg border border-accent/60 bg-accent/5 p-4",
      "aria-label": "Adapter-accelerated mode",
      "data-playtesting-mode": "adapter-accelerated",
      "data-mode-status": adapterReadinessStatus(setup)
    },
    React.createElement(
      "p",
      { className: "font-semibold" },
      "Adapter-accelerated"
    ),
    React.createElement(
      "p",
      { className: "mt-1 text-xs font-medium text-fg-muted" },
      blocker?.label ?? "Ready to run"
    ),
    React.createElement(
      "p",
      { className: "mt-3 text-sm text-fg-secondary" },
      "Runs the approved game adapter against the latest committed checkout. Results are structured and fast, but do not represent what a player sees."
    )
  );
}

function PlaytestingModeReadinessCards({
  setup,
  workspaceId
}: {
  readonly setup: PlaytestingRunSetup;
  readonly workspaceId: string | null;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "grid gap-3 border-b border-border px-5 py-4 sm:grid-cols-2 sm:px-6"
    },
    visualModeReadinessCard(setup, workspaceId),
    adapterModeReadinessCard(setup)
  );
}

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [playDialogOpen, setPlayDialogOpen] = useState(false);
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
      setPlayDialogOpen(false);
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
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (playDialogOpen && !dialog.open) dialog.showModal();
    else if (!playDialogOpen && dialog.open) dialog.close();
  }, [playDialogOpen]);

  const activeCount = live.state.runs.filter(
    (run) => !isTerminal(run.record)
  ).length;
  return React.createElement(
    React.Fragment,
    null,
    showRunControls
      ? React.createElement(
          "div",
          { className: "flex flex-wrap items-center justify-end gap-3" },
          React.createElement(
            "button",
            {
              type: "button",
              className:
                "inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-fg-inverse shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60",
              onClick: () => setPlayDialogOpen(true),
              disabled: scope.workspaceId === null,
              "aria-label": "Start playtest",
              title:
                scope.workspaceId === null
                  ? "Choose a workspace before starting a playtest"
                  : undefined,
              "data-playtesting-open-dialog": "true"
            },
            React.createElement(
              "span",
              { "aria-hidden": true, className: "text-lg leading-none" },
              "▶"
            ),
            "Play"
          ),
          React.createElement(
            "dialog",
            {
              ref: dialogRef,
              className:
                "m-auto max-h-[calc(100dvh-2rem)] w-[min(52rem,calc(100%-2rem))] overflow-y-auto rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/70",
              "aria-labelledby": "playtesting-new-dialog-title",
              "data-testid": "playtesting-new-dialog",
              onClose: () => setPlayDialogOpen(false)
            },
            React.createElement(
              "div",
              {
                className:
                  "flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6"
              },
              React.createElement(
                "div",
                null,
                React.createElement(
                  "h2",
                  {
                    id: "playtesting-new-dialog-title",
                    className: "text-lg font-semibold tracking-tight"
                  },
                  "New playtest"
                ),
                React.createElement(
                  "p",
                  { className: "mt-1 text-sm text-fg-muted" },
                  "Choose a play mode, set a safe budget, and follow the resulting session."
                )
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className:
                    "rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-raised",
                  onClick: () => setPlayDialogOpen(false),
                  "aria-label": "Close new playtest dialog"
                },
                "Close"
              )
            ),
            React.createElement(PlaytestingModeReadinessCards, {
              setup,
              workspaceId: scope.workspaceId
            }),
            React.createElement(
              "div",
              { className: "p-5 sm:p-6" },
              React.createElement(PlaytestingRunControls, {
                setup,
                workspaceId: scope.workspaceId,
                onRunStarted
              })
            )
          )
        )
      : null,
    scope.workspaceId && scope.view === "overview"
      ? React.createElement(
          "details",
          {
            className: "rounded-lg border border-border bg-surface/70",
            open: live.state.runs.length > 0,
            "data-testid": "playtesting-run-status-disclosure"
          },
          React.createElement(
            "summary",
            {
              className:
                "cursor-pointer list-none px-4 py-3 text-sm font-medium"
            },
            activeCount > 0
              ? `${String(activeCount)} active ${activeCount === 1 ? "run" : "runs"} · view live status`
              : live.state.runs.length > 0
                ? "Most recent run status"
                : "Live run status"
          ),
          React.createElement(
            "div",
            { className: "border-t border-border p-3" },
            React.createElement(PlaytestingLiveRuns, {
              workspaceId: scope.workspaceId,
              scope,
              initialFocusedBatchId: focusedBatchId,
              wallTimeMs:
                setup.kind === "available"
                  ? (setup.capabilities.limits?.wallTimeMs ?? null)
                  : null,
              showEmptyState: true,
              allowCancel: canCancel,
              cancelUnavailableReason,
              live
            })
          )
        )
      : null
  );
}
