import type {
  MemoryInjectionUseCohortCell,
  MemoryInjectionUseCohortPage,
  MemorySessionOutcomeCohortCell,
  MemorySessionOutcomeCohortPage
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { TAG_SHAPE } from "../../components/status/Tag.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import {
  MONO_VALUE_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { SUCCESS_TONE_CLASS } from "../../components/ui/tones.ts";

export interface MemoryCohortsViewProps {
  readonly sessionCohorts: MemorySessionOutcomeCohortPage | null;
  readonly useCohorts: MemoryInjectionUseCohortPage | null;
  readonly currentWorkspaceId: string;
  readonly repositoryId: string;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
}

export function MemoryCohortsView({
  sessionCohorts,
  useCohorts,
  currentWorkspaceId,
  repositoryId,
  occurredFrom,
  occurredUntil
}: MemoryCohortsViewProps): React.JSX.Element {
  const hasSessionCohorts = sessionCohorts !== null;
  const sessionCells = sessionCohorts?.cells ?? [];
  const useCells = useCohorts?.cells ?? [];
  const assessedExposureCount = useCells.reduce(
    (count, cell) => count + (cell.useKind === null ? 0 : cell.exposureCount),
    0
  );
  const unassessedExposureCount = useCells.reduce(
    (count, cell) => count + (cell.useKind === null ? cell.exposureCount : 0),
    0
  );

  const cellColumns: ColumnDef<MemorySessionOutcomeCohortCell>[] = [
    {
      id: "mode",
      header: "Assigned Mode",
      weight: 160,
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs font-semibold text-fg" },
          cell.memoryMode
        )
    },
    {
      id: "status",
      header: "Reporting Status",
      weight: 160,
      cell: (cell) => {
        const isReported = cell.outcomeKind !== null;
        return React.createElement(
          "span",
          {
            className: `${TAG_SHAPE} font-medium ${
              isReported
                ? SUCCESS_TONE_CLASS
                : "bg-surface-raised text-fg-muted border-border-strong"
            }`
          },
          isReported ? "Reported" : "Unreported"
        );
      }
    },
    {
      id: "outcome",
      header: "Outcome",
      weight: 140,
      cell: (cell) =>
        React.createElement(
          "span",
          {
            className: `font-mono text-xs ${
              cell.outcomeKind === "success"
                ? "text-success"
                : cell.outcomeKind === "failure"
                  ? "text-error"
                  : MUTED_TEXT_CLASS
            }`
          },
          cell.outcomeKind ?? "unreported"
        )
    },
    {
      id: "count",
      header: "Session Count",
      weight: 140,
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-sm font-bold text-fg" },
          cell.sessionCount.toLocaleString()
        )
    }
  ];

  const useCellColumns: ColumnDef<MemoryInjectionUseCohortCell>[] = [
    {
      id: "mode",
      header: "Assigned Mode",
      weight: 160,
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs font-semibold text-fg" },
          cell.memoryMode
        )
    },
    {
      id: "sessionCardinality",
      header: "Session Cardinality",
      weight: 180,
      cell: (cell) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          cell.sessionCardinality
        )
    },
    {
      id: "useKind",
      header: "Curator Assessment",
      weight: 190,
      cell: (cell) =>
        React.createElement(
          "span",
          {
            className: `font-mono text-xs ${
              cell.useKind === null ? MUTED_TEXT_CLASS : "text-accent"
            }`
          },
          cell.useKind ?? "Unassessed"
        )
    },
    {
      id: "exposureCount",
      header: "Eligible Exposures",
      weight: 180,
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-sm font-bold text-fg" },
          cell.exposureCount.toLocaleString()
        )
    }
  ];

  return React.createElement(
    PageBody,
    { feature: "memory-cohorts" },
    // Time and scope banner
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center justify-between gap-4 p-4 rounded-lg bg-surface border border-border text-xs text-fg-secondary"
      },
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        React.createElement(
          "span",
          { className: MUTED_TEXT_CLASS },
          "Repository Scope:"
        ),
        React.createElement(
          "span",
          { className: "font-mono font-semibold text-accent" },
          repositoryId || currentWorkspaceId
        )
      ),
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        React.createElement("span", { className: MUTED_TEXT_CLASS }, "Window:"),
        React.createElement(
          "span",
          { className: "font-mono text-fg" },
          `${new Date(occurredFrom).toLocaleDateString()} — ${new Date(occurredUntil).toLocaleDateString()}`
        )
      )
    ),

    // Stat cards summary
    sessionCohorts
      ? React.createElement(
          StatGrid,
          { columns: 5 },
          React.createElement(StatCard, {
            title: "Observed Sessions",
            value: sessionCohorts.sessionCount
          }),
          React.createElement(StatCard, {
            title: "Reported Sessions",
            value: sessionCohorts.reportedSessionCount
          }),
          React.createElement(StatCard, {
            title: "Unreported Sessions",
            value: sessionCohorts.unreportedSessionCount,
            subtitle: "Preserved explicit unreported cells"
          }),
          React.createElement(StatCard, {
            title: "Mixed-Mode Sessions",
            value: sessionCohorts.mixedModeSessionCount,
            subtitle: "Excluded from mode-isolated cells"
          }),
          React.createElement(StatCard, {
            title: "Conflicting Reports",
            value: sessionCohorts.conflictingOutcomeSessionCount,
            subtitle: "Per-injection tokens disagree"
          })
        )
      : null,

    // Invariant callout card
    React.createElement(
      "div",
      {
        className:
          "p-4 rounded-lg bg-surface/40 border border-border text-xs text-fg-muted leading-relaxed"
      },
      React.createElement(
        "p",
        null,
        "§10/§14 Non-inferential cohort policy: Session outcome cohorts reflect only explicitly appended reporter-supplied outcomes. Absences remain explicit unreported cells; model packet usage is never inferred from output text or task success."
      )
    ),

    // Section: Session Outcome Cohorts
    React.createElement(
      "div",
      {
        className: "flex flex-col gap-3",
        "data-memory-session-cohorts-state": hasSessionCohorts
          ? "observed"
          : "unavailable"
      },
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Session Outcome Breakdown"
      ),
      hasSessionCohorts
        ? React.createElement<DataTableProps<MemorySessionOutcomeCohortCell>>(
            DataTable,
            {
              data: sessionCells,
              columns: cellColumns,
              keyExtractor: (c: MemorySessionOutcomeCohortCell) =>
                `${c.memoryMode}-${c.outcomeKind ?? "unreported"}-${c.sessionCount}`,
              emptyMessage:
                "No session outcome cohort data found for the specified scope and time window."
            }
          )
        : React.createElement(
            "div",
            {
              role: "alert",
              className: CALLOUT_WARNING_CLASS,
              "data-status": "unavailable"
            },
            "Session outcome cohort data is unavailable; no session count is inferred."
          )
    ),

    // Section: curator-assessed injection use. These are exposure counts,
    // not task outcomes or causal effectiveness measurements.
    React.createElement(
      "div",
      {
        className: "flex flex-col gap-3",
        "data-memory-use-cohorts-state":
          useCohorts === null ? "unavailable" : "observed"
      },
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Injection-Use Assessments"
      ),
      useCohorts
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(
              StatGrid,
              { columns: 3 },
              React.createElement(StatCard, {
                title: "Eligible Exposures",
                value: useCohorts.exposureCount
              }),
              React.createElement(StatCard, {
                title: "Assessed Exposures",
                value: assessedExposureCount
              }),
              React.createElement(StatCard, {
                title: "Unassessed Exposures",
                value: unassessedExposureCount,
                subtitle: "Absence is not a not-used assessment"
              })
            ),
            React.createElement<DataTableProps<MemoryInjectionUseCohortCell>>(
              DataTable,
              {
                data: useCells,
                columns: useCellColumns,
                keyExtractor: (cell: MemoryInjectionUseCohortCell) =>
                  `${cell.memoryMode}-${cell.sessionCardinality}-${cell.useKind ?? "unassessed"}`,
                emptyMessage:
                  "No eligible injected memory exposures were observed for this scope and time window."
              }
            )
          )
        : React.createElement(
            "p",
            {
              role: "alert",
              className: CALLOUT_WARNING_CLASS,
              "data-status": "unavailable",
              "data-memory-use-cohorts-empty": true
            },
            "Injection-use cohorts are unavailable for this request. This is not evidence that no memories were used or assessed."
          ),
      React.createElement(
        "p",
        {
          className:
            "rounded-lg border border-border bg-surface/40 p-4 text-xs leading-relaxed text-fg-muted"
        },
        "Use assessments are separately curator-reported observations about eligible injected packets. They do not report task success, infer use from model output, or establish causal effectiveness."
      )
    )
  );
}

interface DataTableProps<T> {
  readonly data: readonly T[];
  readonly columns: readonly ColumnDef<T>[];
  readonly keyExtractor: (row: T) => string;
  readonly emptyMessage?: string | undefined;
}
