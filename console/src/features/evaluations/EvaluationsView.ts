import React from "react";

import type { EvaluationResult } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { type ColumnDef, DataTable } from "../../components/tables/DataTable.ts";

export interface EvaluationsViewProps {
  readonly evaluations?: readonly EvaluationResult[] | undefined;
}

export function EvaluationsView({
  evaluations = []
}: EvaluationsViewProps): React.JSX.Element {
  const total = evaluations.length;
  const passed = evaluations.filter((e) => e.passed).length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 100;

  const columns: ColumnDef<EvaluationResult>[] = [
    {
      id: "agentRole",
      header: "Target Role",
      cell: (ev) =>
        React.createElement(
          "span",
          { className: "font-semibold text-slate-100 font-mono" },
          ev.agentRole
        )
    },
    {
      id: "model",
      header: "Model",
      cell: (ev) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          ev.model
        )
    },
    {
      id: "metrics",
      header: "Metrics",
      cell: (ev) =>
        React.createElement(
          "div",
          { className: "flex gap-2" },
          ev.metrics.map((m) =>
            React.createElement(
              "span",
              {
                key: m.name,
                className: `text-xs px-2 py-0.5 rounded font-mono border ${
                  m.pass
                    ? "bg-emerald-950/60 text-emerald-300 border-emerald-800"
                    : "bg-rose-950/60 text-rose-300 border-rose-800"
                }`
              },
              `${m.name}: ${m.value}`
            )
          )
        )
    },
    {
      id: "passed",
      header: "Outcome",
      cell: (ev) =>
        React.createElement(StatusBadge, {
          status: ev.passed ? "valid" : "invalid",
          label: ev.passed ? "Passed" : "Failed"
        })
    },
    {
      id: "timestamp",
      header: "Run Time",
      cell: (ev) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-400" },
          ev.timestamp
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "evaluations" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, { title: "Total Evaluations", value: total }),
      React.createElement(StatCard, { title: "Passed", value: passed }),
      React.createElement(StatCard, {
        title: "Pass Rate",
        value: `${passRate}%`,
        subtitle: "Direct resource evaluation"
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
        },
        "Evaluation History"
      ),
      DataTable({
        data: evaluations,
        columns,
        keyExtractor: (e: EvaluationResult) => e.id,
        emptyMessage:
          "No evaluations run yet. Evaluations run directly against AutoDev agents and prompt traces."
      })
    )
  );
}
