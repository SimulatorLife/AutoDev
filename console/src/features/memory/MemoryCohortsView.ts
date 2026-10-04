import type {
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
  useCohorts: _useCohorts,
  currentWorkspaceId,
  repositoryId,
  occurredFrom,
  occurredUntil
}: MemoryCohortsViewProps): React.JSX.Element {
  const sessionCells = sessionCohorts?.cells ?? [];

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
                  : "text-slate-400"
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
          { className: "text-slate-400" },
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
        React.createElement("span", { className: "text-slate-400" }, "Window:"),
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
    )
  );
}

interface DataTableProps<T> {
  readonly data: readonly T[];
  readonly columns: readonly ColumnDef<T>[];
  readonly keyExtractor: (row: T) => string;
  readonly emptyMessage?: string | undefined;
}
