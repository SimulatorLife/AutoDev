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
import type { PlaytestJsonValue } from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { DetailValue } from "../../components/panels/DetailGrid.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";

import {
  assignmentCounts,
  isTerminal,
  type PlaytestingActiveRun,
  type PlaytestingActiveRunsFreshness
} from "./playtesting-active-runs.ts";
import { batchStatusBadge } from "./playtesting-run-presentation.ts";
import { runStateLabel } from "./playtesting-run-messages.ts";

const FRESHNESS_NOTICE: Readonly<
  Record<PlaytestingActiveRunsFreshness, string | null>
> = {
  live: null,
  idle: null,
  unavailable:
    "The latest batch state could not be read. The batches below are the last values the Console received, not confirmed current state."
};

function countLabel(
  counts: Readonly<Record<string, PlaytestJsonValue>> | null,
  key: string
): number | null {
  if (!counts) return null;
  const value = counts[key];
  return typeof value === "number" ? value : null;
}

function stat(label: string, value: number | null): React.JSX.Element {
  return React.createElement(DetailValue, {
    key: label,
    label,
    // Absent evidence is named as absent, never rendered as a zero the
    // operator could read as a measurement, and never reworded.
    children: value === null ? NOT_OBSERVED_LABEL : String(value)
  });
}

/**
 * The independent meanings stay separate while a batch runs: assignment
 * outcomes versus gameplay outcomes, assignment state versus episode outcome,
 * and assignments that became infrastructure loss versus persisted episodes.
 * Values come from the owner's counts; the Console never recomputes them.
 */
function runProgress(run: PlaytestingActiveRun): React.JSX.Element {
  const counts = assignmentCounts(run.record);
  return React.createElement(
    "dl",
    { className: "grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4" },
    stat("Assignments succeeded", countLabel(counts, "succeeded")),
    stat("Assignments failed", countLabel(counts, "failed")),
    stat("Assignments cancelled", countLabel(counts, "cancelled")),
    stat("Assignments quota-blocked", countLabel(counts, "quota-blocked")),
    stat("Assignments in batch", run.assignmentCount),
    stat("Episodes persisted", countLabel(counts, "episodes"))
  );
}

function runRow(
  run: PlaytestingActiveRun,
  freshness: PlaytestingActiveRunsFreshness,
  focusedBatchId: string | null,
  onFocusBatch: (batchId: string | null) => void,
  onCancel: ((batchId: string) => void) | null,
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
          runProgress(run)
        )
      : null
  );
}

export interface PlaytestingActiveRunsPanelProps {
  readonly workspaceId: string | null;
  readonly runs: readonly PlaytestingActiveRun[];
  readonly freshness: PlaytestingActiveRunsFreshness;
  readonly lastFailure: string | null;
  readonly watching: boolean;
  readonly onRefresh: () => void;
  /** Focused batch, shared through the URL so refresh and Back survive. */
  readonly focusedBatchId: string | null;
  readonly onFocusBatch: (batchId: string | null) => void;
  readonly onCancel: ((batchId: string) => void) | null;
  readonly busyBatchId: string | null;
}

export function PlaytestingActiveRunsPanel({
  workspaceId,
  runs,
  freshness,
  lastFailure,
  watching,
  onRefresh,
  focusedBatchId,
  onFocusBatch,
  onCancel,
  busyBatchId
}: PlaytestingActiveRunsPanelProps): React.JSX.Element {
  const notice = FRESHNESS_NOTICE[freshness];
  const nonterminal = runs.filter((run) => !isTerminal(run.record));
  const terminal = runs.filter((run) => isTerminal(run.record));
  const body = !workspaceId
    ? React.createElement(
        "p",
        { className: MUTED_BODY_CLASS },
        "Choose a workspace to watch its running batches."
      )
    : runs.length === 0 && freshness !== "unavailable"
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "No batches are running in this workspace."
        )
      : React.createElement(
          "ul",
          { className: "flex flex-col gap-3" },
          ...[...nonterminal, ...terminal].map((run) =>
            runRow(
              run,
              freshness,
              focusedBatchId,
              onFocusBatch,
              onCancel,
              busyBatchId
            )
          )
        );
  return React.createElement(
    "section",
    {
      "aria-label": "Live batches",
      className: LIST_PANEL_CLASS,
      "data-testid": "playtesting-active-runs",
      "data-freshness": freshness
    },
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center justify-between gap-3"
      },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Live batches"
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
          : "No batches are running."
    )
  );
}