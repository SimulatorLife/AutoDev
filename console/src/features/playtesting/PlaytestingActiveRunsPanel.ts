"use client";

/**
 * Workspace-scoped live batch monitoring.
 *
 * Every rendered status came from a read of the typed run owner. An unreadable
 * read is shown as an explicit unavailable state with the last known frames
 * still visible but clearly marked as not current — never as a live reading.
 * Progress is announced politely and never steals focus.
 *
 * Written with `React.createElement` in a `.ts` module so the render suite can
 * exercise it directly, matching the other Playtesting views.
 */
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  assignmentCounts,
  assignmentOutcomes,
  isTerminal,
  type PlaytestingActiveRun,
  type PlaytestingActiveRunsFreshness
} from "./playtesting-active-runs.ts";
import {
  CANCELLATION_REASON_LABELS,
  runStateLabel
} from "./playtesting-run-messages.ts";
import { batchStatusBadge } from "./playtesting-run-presentation.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingAssignmentResults } from "./PlaytestingAssignmentResults.ts";

const FRESHNESS_NOTICE: Readonly<
  Record<PlaytestingActiveRunsFreshness, string | null>
> = {
  live: null,
  idle: null,
  unavailable:
    "The latest batch state could not be read. The batches below are the last values the Console received, not confirmed current state."
};

/**
 * Reads one owner count by its contract key.
 *
 * The key type is the owner's, so a tile cannot be pointed at a field the
 * Runtime never writes — the four this panel originally read did exactly that
 * and every one of them rendered "not observed" for the life of the feature.
 */
function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours)}h ${String(minutes).padStart(2, "0")}m`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function runProgress(
  run: PlaytestingActiveRun,
  scope: PlaytestingScope,
  wallTimeMs: number | null
): React.JSX.Element {
  const outcomes = assignmentOutcomes(run.record);
  const counts = assignmentCounts(run.record);
  const sessionScope = isTerminal(run.record)
    ? scope
    : { ...scope, liveBatchId: run.batchId };
  const createdAtMs = Date.parse(run.createdAt);
  const elapsedMs = Number.isFinite(createdAtMs)
    ? Math.max(0, Date.now() - createdAtMs)
    : null;
  const budgetRemainingMs =
    elapsedMs === null || wallTimeMs === null
      ? null
      : Math.max(0, wallTimeMs - elapsedMs);
  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-3",
      "data-testid": "playtesting-run-progress"
    },
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      outcomes
        ? `${String(outcomes.length)} of ${String(run.assignmentCount)} assignments have a terminal result.`
        : `Runtime accepted ${String(run.assignmentCount)} ${run.assignmentCount === 1 ? "assignment" : "assignments"}. Individual results are recorded when execution finishes.`
    ),
    React.createElement(
      "dl",
      { className: "grid gap-2 sm:grid-cols-2" },
      React.createElement(
        "div",
        null,
        React.createElement("dt", { className: MUTED_META_CLASS }, "Elapsed"),
        React.createElement(
          "dd",
          { className: "mt-1 font-mono text-sm" },
          elapsedMs === null ? NOT_OBSERVED_LABEL : formatElapsed(elapsedMs)
        )
      ),
      React.createElement(
        "div",
        null,
        React.createElement(
          "dt",
          { className: MUTED_META_CLASS },
          "Approved time budget remaining"
        ),
        React.createElement(
          "dd",
          { className: "mt-1 font-mono text-sm" },
          budgetRemainingMs === null
            ? NOT_OBSERVED_LABEL
            : formatElapsed(budgetRemainingMs)
        )
      )
    ),
    counts
      ? React.createElement(
          "details",
          null,
          React.createElement(
            "summary",
            { className: "cursor-pointer text-sm font-medium" },
            "Assignment counts"
          ),
          React.createElement(
            DetailGrid,
            { columns: 3, className: "mt-2" },
            ...(
              [
                ["Assigned", "assigned"],
                ["Started", "started"],
                ["Completed", "completed"],
                ["Crashed", "crashed"],
                ["Infrastructure failures", "infrastructureFailed"],
                ["Cancelled", "cancelled"],
                ["Budget truncated", "budgetTruncated"],
                ["Analyst reviews", "reviewed"],
                ["Review eligible", "eligible"]
              ] as const
            ).map(([label, key]) => {
              const value = counts[key];
              return React.createElement(DetailValue, {
                key,
                label,
                valueClassName: "text-sm text-fg break-words",
                children:
                  typeof value === "number" ? String(value) : NOT_OBSERVED_LABEL
              });
            })
          )
        )
      : null,
    outcomes !== null || !isTerminal(run.record)
      ? React.createElement(
          "details",
          {
            open: !isTerminal(run.record),
            "data-testid": "playtesting-assignment-outcomes-disclosure"
          },
          React.createElement(
            "summary",
            { className: "cursor-pointer text-sm font-medium" },
            outcomes === null
              ? `Watch sessions (${String(run.sessions.length)})`
              : `Assignment outcomes (${String(outcomes.length)})`
          ),
          React.createElement(PlaytestingAssignmentResults, {
            outcomes,
            sessions: run.sessions,
            scope: sessionScope,
            pending: run.record.result === null,
            live: !isTerminal(run.record)
          })
        )
      : null
  );
}

function runRow(
  run: PlaytestingActiveRun,
  scope: PlaytestingScope,
  freshness: PlaytestingActiveRunsFreshness,
  focusedBatchId: string | null,
  wallTimeMs: number | null,
  onFocusBatch: (batchId: string | null) => void,
  onCancel: ((batchId: string) => void) | null,
  cancelUnavailableReason: string | null,
  busyBatchId: string | null
): React.JSX.Element {
  const terminal = isTerminal(run.record);
  const focused = focusedBatchId === run.batchId;
  // While the read is failing, a row must not badge its last-known state as if
  // it were current. It is labelled as last known and carries a stale flag.
  const stale = freshness === "unavailable";
  const buttons: React.JSX.Element[] = [
    React.createElement(
      "button",
      {
        key: "focus",
        type: "button",
        className: FIELD_CONTROL_CLASS,
        "aria-expanded": focused,
        onClick: () => onFocusBatch(focused ? null : run.batchId)
      },
      focused ? "Hide progress" : "Show progress"
    )
  ];
  if (onCancel && !terminal) {
    buttons.push(
      React.createElement(
        "button",
        {
          key: "cancel",
          type: "button",
          className: FIELD_CONTROL_CLASS,
          disabled: busyBatchId === run.batchId,
          onClick: () => onCancel(run.batchId)
        },
        "Cancel batch"
      )
    );
  }
  return React.createElement(
    "li",
    {
      key: run.batchId,
      className: "rounded-lg border border-border p-4",
      "data-testid": "playtesting-active-run",
      "data-batch-id": run.batchId,
      "data-status": run.record.status,
      "data-terminal": terminal ? "true" : "false",
      "data-stale": stale ? "true" : "false",
      "data-focused": focused ? "true" : "false"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-2" },
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        stale
          ? React.createElement(
              "span",
              {
                className: MUTED_META_CLASS,
                "data-testid": "playtesting-active-run-lastknown"
              },
              `Last known: ${runStateLabel(run.record.status)}`
            )
          : batchStatusBadge(run.record.status),
        React.createElement(
          "span",
          { className: MUTED_META_CLASS },
          run.batchId
        )
      ),
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        ...buttons
      )
    ),
    run.record.cancellationReason
      ? React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          `Cancellation: ${CANCELLATION_REASON_LABELS[run.record.cancellationReason]}.`
        )
      : null,
    onCancel === null && !terminal && cancelUnavailableReason !== null
      ? React.createElement(
          "p",
          { className: MUTED_META_CLASS, role: "status" },
          `Cancellation unavailable: ${cancelUnavailableReason}`
        )
      : null,
    run.record.error
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          `Runtime reported: ${run.record.error.message}`
        )
      : null,
    focused
      ? React.createElement(
          "div",
          { className: "mt-3" },
          runProgress(run, scope, wallTimeMs)
        )
      : null
  );
}

export interface PlaytestingActiveRunsPanelProps {
  readonly scope: PlaytestingScope;
  readonly runs: readonly PlaytestingActiveRun[];
  readonly freshness: PlaytestingActiveRunsFreshness;
  readonly lastFailure: string | null;
  readonly watching: boolean;
  readonly onRefresh: () => void;
  /** Focused batch, shared through the URL so refresh and Back survive. */
  readonly focusedBatchId: string | null;
  readonly wallTimeMs?: number | null | undefined;
  readonly showEmptyState?: boolean | undefined;
  readonly onFocusBatch: (batchId: string | null) => void;
  readonly onCancel: ((batchId: string) => void) | null;
  readonly cancelUnavailableReason?: string | null | undefined;
  readonly busyBatchId: string | null;
}

export function PlaytestingActiveRunsPanel({
  scope,
  runs,
  freshness,
  lastFailure,
  watching,
  onRefresh,
  focusedBatchId,
  wallTimeMs = null,
  showEmptyState = true,
  onFocusBatch,
  onCancel,
  cancelUnavailableReason = null,
  busyBatchId
}: PlaytestingActiveRunsPanelProps): React.JSX.Element {
  const workspaceId = scope.workspaceId;
  const notice = FRESHNESS_NOTICE[freshness];
  const nonterminal = runs.filter((run) => !isTerminal(run.record));
  const terminal = runs.filter((run) => isTerminal(run.record));
  const body =
    workspaceId === null
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "Choose a workspace to watch its running batches."
        )
      : runs.length === 0 && freshness !== "unavailable"
        ? React.createElement(
            "p",
            { className: MUTED_BODY_CLASS },
            "No run is in progress. The latest saved result is shown below."
          )
        : React.createElement(
            "ul",
            { className: "flex flex-col gap-3" },
            ...[...nonterminal, ...terminal].map((run) =>
              runRow(
                run,
                scope,
                freshness,
                focusedBatchId,
                wallTimeMs,
                onFocusBatch,
                onCancel,
                cancelUnavailableReason,
                busyBatchId
              )
            )
          );
  if (runs.length === 0 && freshness !== "unavailable" && !showEmptyState) {
    return React.createElement(React.Fragment, null);
  }
  return React.createElement(
    "section",
    {
      "aria-label": "Playtest run status",
      className: LIST_PANEL_CLASS,
      "data-testid": "playtesting-active-runs",
      "data-freshness": freshness
    },
    React.createElement(
      "div",
      {
        className: "flex flex-wrap items-center justify-between gap-3"
      },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Run status"
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: FIELD_CONTROL_CLASS,
          onClick: onRefresh,
          disabled: !workspaceId
        },
        "Refresh"
      )
    ),
    notice
      ? React.createElement(
          "p",
          {
            className: `${MUTED_BODY_CLASS} border-l-2 border-l-amber-500 pl-3`,
            "data-testid": "playtesting-active-runs-notice"
          },
          notice,
          lastFailure ? ` ${lastFailure}` : ""
        )
      : null,
    body,
    React.createElement(
      "p",
      {
        // Polite so the batch is followed without moving the operator's place.
        "aria-live": "polite",
        "aria-atomic": "true",
        className: "sr-only"
      },
      watching
        ? `Watching ${nonterminal.length} running ${nonterminal.length === 1 ? "batch" : "batches"}.`
        : freshness === "unavailable"
          ? "Live batch state is unavailable."
          : "No run is in progress. The latest saved result is shown below."
    )
  );
}
