import type {
  MemoryInjectionUseCohortCell,
  MemoryInjectionUseCohortPage,
  MemorySessionOutcomeCohortCell,
  MemorySessionOutcomeCohortPage
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

const MUTED_TEXT_CLASS = "text-slate-400";

export interface MemoryCohortsViewProps {
  readonly sessionCohorts?: MemorySessionOutcomeCohortPage | null | undefined;
  readonly useCohorts?: MemoryInjectionUseCohortPage | null | undefined;
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
      width: "160px",
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs font-semibold text-slate-200" },
          cell.memoryMode
        )
    },
    {
      id: "status",
      header: "Reporting Status",
      width: "160px",
      cell: (cell) => {
        const isReported = cell.outcomeKind !== null;
        return React.createElement(
          "span",
          {
            className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
              isReported
                ? "bg-emerald-950/60 text-emerald-300 border-emerald-800"
                : "bg-slate-800 text-slate-400 border-slate-700"
            }`
          },
          isReported ? "Reported" : "Unreported"
        );
      }
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "140px",
      cell: (cell) =>
        React.createElement(
          "span",
          {
            className: `font-mono text-xs ${
              cell.outcomeKind === "success"
                ? "text-emerald-400"
                : cell.outcomeKind === "failure"
                  ? "text-rose-400"
                  : MUTED_TEXT_CLASS
            }`
          },
          cell.outcomeKind ?? "unreported"
        )
    },
    {
      id: "count",
      header: "Session Count",
      width: "140px",
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-sm font-bold text-slate-100" },
          cell.sessionCount.toLocaleString()
        )
    }
  ];

  const useCellColumns: ColumnDef<MemoryInjectionUseCohortCell>[] = [
    {
      id: "mode",
      header: "Assigned Mode",
      width: "160px",
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs font-semibold text-slate-200" },
          cell.memoryMode
        )
    },
    {
      id: "sessionCardinality",
      header: "Session Cardinality",
      width: "180px",
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          cell.sessionCardinality
        )
    },
    {
      id: "useKind",
      header: "Curator Assessment",
      width: "190px",
      cell: (cell) =>
        React.createElement(
          "span",
          {
            className: `font-mono text-xs ${
              cell.useKind === null ? MUTED_TEXT_CLASS : "text-cyan-300"
            }`
          },
          cell.useKind ?? "Unassessed"
        )
    },
    {
      id: "exposureCount",
      header: "Eligible Exposures",
      width: "180px",
      cell: (cell) =>
        React.createElement(
          "span",
          { className: "font-mono text-sm font-bold text-slate-100" },
          cell.exposureCount.toLocaleString()
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "memory-cohorts" },
    // Time and scope banner
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center justify-between gap-4 p-4 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300"
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
          { className: "font-mono font-semibold text-cyan-300" },
          repositoryId || currentWorkspaceId
        )
      ),
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        React.createElement("span", { className: MUTED_TEXT_CLASS }, "Window:"),
        React.createElement(
          "span",
          { className: "font-mono text-slate-200" },
          `${new Date(occurredFrom).toLocaleDateString()} — ${new Date(occurredUntil).toLocaleDateString()}`
        )
      )
    ),

    // Stat cards summary
    sessionCohorts
      ? React.createElement(
          "div",
          { className: "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4" },
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
          "p-4 rounded-lg bg-slate-900/40 border border-slate-800 text-xs text-slate-400 leading-relaxed"
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
      { className: "flex flex-col gap-3" },
      React.createElement(
        "h3",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-300"
        },
        "Session Outcome Breakdown"
      ),
      React.createElement<DataTableProps<MemorySessionOutcomeCohortCell>>(
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
    ),

    // Section: curator-assessed injection use. These are exposure counts,
    // not task outcomes or causal effectiveness measurements.
    React.createElement(
      "div",
      {
        className: "flex flex-col gap-3",
        "data-memory-use-cohorts-state": useCohorts ? "observed" : "unavailable"
      },
      React.createElement(
        "h3",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-300"
        },
        "Injection-Use Assessments"
      ),
      useCohorts
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "div",
              { className: "grid grid-cols-2 sm:grid-cols-3 gap-4" },
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
              className:
                "rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-400",
              "data-memory-use-cohorts-empty": true
            },
            "Injection-use cohorts were not observed for this request. This is not evidence that no memories were used or assessed."
          ),
      React.createElement(
        "p",
        {
          className:
            "rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-xs leading-relaxed text-slate-400"
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
