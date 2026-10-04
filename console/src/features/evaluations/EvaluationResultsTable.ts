import type { EvaluationResult } from "@simulatorlife/autodev-core";
import React from "react";

import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import {
  MetricChips,
  NOT_OBSERVED,
  OutcomeBadge,
  subjectLabel
} from "./presentation.ts";

export interface EvaluationResultsTableProps {
  readonly results: readonly EvaluationResult[];
  /** Builds the in-page link that opens the result and its linked trace. */
  readonly resultHref: (result: EvaluationResult) => string;
  readonly emptyMessage: string;
  readonly showDefinition?: boolean;
}

export function EvaluationResultsTable({
  results,
  resultHref,
  emptyMessage,
  showDefinition = true
}: EvaluationResultsTableProps): React.JSX.Element {
  const columns: ColumnDef<EvaluationResult>[] = [
    {
      id: "createdAt",
      header: "Time",
      cell: (result) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-400 font-mono" },
          result.createdAt
        )
    },
    ...(showDefinition
      ? [
          {
            id: "definition",
            header: "Definition",
            cell: (result: EvaluationResult) =>
              result.definitionId
                ? React.createElement(
                    "a",
                    {
                      href: `/evaluations/${encodeURIComponent(result.definitionId)}`,
                      className: "font-mono text-emerald-400 hover:underline"
                    },
                    result.definitionId
                  )
                : React.createElement(
                    "span",
                    {
                      className: "text-xs text-slate-500",
                      title: `Recorded by ${result.source ?? "an unknown producer"} without an AutoDev definition.`
                    },
                    "Unattributed"
                  )
          } satisfies ColumnDef<EvaluationResult>
        ]
      : []),
    {
      id: "case",
      header: "Case",
      cell: (result) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          result.caseId ?? NOT_OBSERVED
        )
    },
    {
      id: "target",
      header: "Target",
      cell: (result) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-200" },
          subjectLabel(result.subject)
        )
    },
    {
      id: "outcome",
      header: "Outcome",
      cell: (result) =>
        React.createElement(
          "span",
          { className: "flex items-center gap-2" },
          React.createElement(OutcomeBadge, { outcome: result.outcome }),
          result.error
            ? React.createElement(
                "span",
                { className: "font-mono text-xs text-rose-300" },
                result.error
              )
            : null
        )
    },
    {
      id: "metrics",
      header: "Metrics",
      cell: (result) =>
        React.createElement(MetricChips, { metrics: result.metrics })
    },
    {
      id: "trace",
      header: "Detail / Trace",
      cell: (result) =>
        React.createElement(
          "a",
          {
            href: resultHref(result),
            className: "text-xs text-emerald-400 hover:underline font-mono",
            "data-trace-linked":
              result.traceId || result.spanId ? "true" : "false"
          },
          result.traceId
            ? `trace ${result.traceId.slice(0, 8)}…`
            : result.spanId
              ? `span ${result.spanId.slice(0, 8)}…`
              : "Detail"
        )
    }
  ];
  return DataTable({
    data: results,
    columns,
    keyExtractor: (result: EvaluationResult) => result.id,
    emptyMessage
  });
}
