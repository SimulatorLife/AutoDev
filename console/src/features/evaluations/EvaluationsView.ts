import {
  type ControlApiEvaluationDefinitionRecord,
  type ControlApiEvaluationResultResponse,
  type ControlApiEvaluationsResponse,
  countEvaluationOutcomes,
  evaluationPassRate,
  type EvaluationRunSummary
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import { EvaluationResultPanel } from "./EvaluationResultPanel.ts";
import { EvaluationResultsTable } from "./EvaluationResultsTable.ts";
import {
  formatRate,
  InlineAlert,
  NOT_OBSERVED,
  resultHref,
  RunStatusBadge,
  SectionHeading
} from "./presentation.ts";

export interface EvaluationsViewProps {
  readonly data: ControlApiEvaluationsResponse;
  readonly notice?: string | null;
  readonly selectedResult?: ControlApiEvaluationResultResponse | null;
  readonly resultError?: {
    readonly code: string;
    readonly message: string;
  } | null;
}

const EVALUATIONS_PATH = "/evaluations";

const FILTER_FIELDS = [
  { key: "agent", label: "Agent role" },
  { key: "model", label: "Requested model" },
  { key: "prompt", label: "Prompt" }
] as const;

function filterParams(
  filter: ControlApiEvaluationsResponse["filter"]
): Record<string, string | undefined> {
  return {
    definition: filter.definition,
    run: filter.run,
    agent: filter.agent,
    model: filter.model,
    prompt: filter.prompt
  };
}

function hrefWith(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${EVALUATIONS_PATH}?${query}` : EVALUATIONS_PATH;
}

function definitionColumns(): ColumnDef<ControlApiEvaluationDefinitionRecord>[] {
  return [
    {
      id: "name",
      header: "Definition",
      cell: ({ definition }) =>
        React.createElement(
          "a",
          {
            href: `/evaluations/${encodeURIComponent(definition.id)}`,
            className: "flex flex-col hover:underline"
          },
          React.createElement(
            "span",
            { className: "font-semibold text-slate-100" },
            definition.name
          ),
          React.createElement(
            "span",
            { className: "font-mono text-xs text-slate-400" },
            definition.id
          )
        )
    },
    {
      id: "state",
      header: "State",
      cell: ({ definition, validation }) =>
        React.createElement(
          "span",
          { className: "flex gap-2" },
          React.createElement(StatusBadge, {
            status: definition.enabled ? "configured" : "not-observed",
            label: definition.enabled ? "Enabled" : "Disabled"
          }),
          React.createElement(StatusBadge, {
            status: validation.runnable ? "valid" : "invalid",
            label: validation.runnable ? "Runnable" : "Unresolved"
          })
        )
    },
    {
      id: "targets",
      header: "Targets",
      cell: ({ definition }) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          `${definition.targets.length} · ${definition.cases.length} cases · ${definition.criteria.length} criteria`
        )
    },
    {
      id: "judge",
      header: "Judge",
      cell: ({ definition }) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          definition.judge.model
        )
    },
    {
      id: "latest",
      header: "Latest run",
      cell: ({ latestRun }) =>
        latestRun
          ? React.createElement(
              "span",
              { className: "flex items-center gap-2" },
              React.createElement(RunStatusBadge, { status: latestRun.status }),
              React.createElement(
                "span",
                { className: "text-xs text-slate-300" },
                formatRate(latestRun.passRate)
              )
            )
          : React.createElement(
              "span",
              { className: "text-xs text-slate-500" },
              NOT_OBSERVED
            )
    }
  ];
}

function runColumns(): ColumnDef<EvaluationRunSummary>[] {
  return [
    {
      id: "started",
      header: "Started",
      cell: (run) =>
        React.createElement(
          "a",
          {
            href: `/evaluations/${encodeURIComponent(run.definitionId)}?run=${encodeURIComponent(run.runId)}`,
            className: "font-mono text-xs text-emerald-400 hover:underline"
          },
          run.startedAt ?? run.lastResultAt ?? run.runId
        )
    },
    {
      id: "definition",
      header: "Definition",
      cell: (run) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-200" },
          run.definitionId
        )
    },
    {
      id: "status",
      header: "Status",
      cell: (run) => React.createElement(RunStatusBadge, { status: run.status })
    },
    {
      id: "progress",
      header: "Results",
      cell: (run) => `${run.observedResults} / ${run.expectedResults ?? "?"}`
    },
    {
      id: "outcomes",
      header: "Pass / fail / error",
      cell: (run) => `${run.passed} / ${run.failed} / ${run.errored}`
    },
    {
      id: "rate",
      header: "Pass rate",
      cell: (run) => formatRate(run.passRate)
    }
  ];
}

function filterForm(data: ControlApiEvaluationsResponse): React.JSX.Element {
  return React.createElement(
    "form",
    {
      method: "get",
      action: EVALUATIONS_PATH,
      className: "flex flex-wrap items-end gap-3 mb-3",
      "data-evaluation-filters": "true"
    },
    React.createElement(
      "label",
      { className: "flex flex-col gap-1 text-xs text-slate-400" },
      "Definition",
      React.createElement(
        "select",
        {
          name: "definition",
          defaultValue: data.filter.definition ?? "",
          className:
            "rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        },
        React.createElement("option", { value: "" }, "All"),
        data.definitions.map(({ definition }) =>
          React.createElement(
            "option",
            { key: definition.id, value: definition.id },
            definition.id
          )
        )
      )
    ),
    FILTER_FIELDS.map((field) =>
      React.createElement(
        "label",
        {
          key: field.key,
          className: "flex flex-col gap-1 text-xs text-slate-400"
        },
        field.label,
        React.createElement("input", {
          name: field.key,
          defaultValue: data.filter[field.key] ?? "",
          placeholder: "All",
          className:
            "rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
        })
      )
    ),
    React.createElement(
      "button",
      {
        type: "submit",
        className:
          "rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
      },
      "Apply"
    ),
    Object.values(data.filter).some(Boolean)
      ? React.createElement(
          "a",
          {
            href: EVALUATIONS_PATH,
            className: "text-xs text-slate-400 hover:underline py-2"
          },
          "Clear filters"
        )
      : null
  );
}

export function EvaluationsView({
  data,
  notice = null,
  selectedResult = null,
  resultError = null
}: EvaluationsViewProps): React.JSX.Element {
  const counts = countEvaluationOutcomes(data.results);
  const passRate =
    data.resultsStatus === "available" ? evaluationPassRate(counts) : null;
  const runnable = data.definitions.filter(
    (entry) => entry.validation.runnable
  ).length;
  const params = filterParams(data.filter);

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "evaluations",
      "data-results-status": data.resultsStatus,
      "data-evaluation-pass-rate-observed": passRate === null ? "false" : "true"
    },
    notice
      ? React.createElement(InlineAlert, { tone: "info", title: notice })
      : null,
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-4 gap-4" },
      React.createElement(StatCard, {
        title: "Definitions",
        value:
          data.catalogStatus === "valid"
            ? data.definitions.length
            : data.catalogStatus === "invalid"
              ? "Invalid"
              : "Unavailable",
        subtitle: data.definitionsSource
      }),
      React.createElement(StatCard, {
        title: "Runnable",
        value: data.catalogStatus === "valid" ? runnable : NOT_OBSERVED,
        subtitle: "Targets, prompts, and judge resolve"
      }),
      React.createElement(StatCard, {
        title: "Results shown",
        value:
          data.resultsStatus === "available"
            ? data.results.length
            : "Unavailable",
        subtitle: `${counts.errored} errored · ${counts.unknown} unknown`
      }),
      React.createElement(StatCard, {
        title: "Pass rate",
        value: formatRate(passRate),
        subtitle: "Passed / judged results shown"
      })
    ),
    React.createElement(
      "section",
      null,
      React.createElement(
        "div",
        { className: "flex items-center justify-between" },
        React.createElement(SectionHeading, null, "Definitions"),
        React.createElement(
          "a",
          {
            href: "/evaluations/new",
            className:
              "mb-3 rounded border border-emerald-700 bg-emerald-900/40 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-900/70 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          },
          "New definition"
        )
      ),
      data.catalogStatus === "valid"
        ? DataTable({
            data: data.definitions,
            columns: definitionColumns(),
            keyExtractor: (entry: ControlApiEvaluationDefinitionRecord) =>
              entry.definition.id,
            emptyMessage:
              "No evaluation definitions are configured in config/evaluations.json."
          })
        : React.createElement(
            InlineAlert,
            {
              tone: "error",
              title: `config/evaluations.json is ${data.catalogStatus}`
            },
            React.createElement(
              "ul",
              { className: "list-disc pl-5 text-xs font-mono" },
              data.catalogErrors.map((error) =>
                React.createElement("li", { key: error }, error)
              )
            )
          )
    ),
    data.resultsStatus === "unavailable"
      ? React.createElement(
          InlineAlert,
          { tone: "warning", title: "Evaluation results are unavailable" },
          React.createElement(
            "p",
            { className: "text-xs font-mono" },
            data.resultsMessage ??
              "The OpenLIT evaluation store did not answer."
          ),
          React.createElement(
            "p",
            { className: "text-xs" },
            "Runs and results stay not observed until the store answers; no history is inferred."
          )
        )
      : null,
    React.createElement(
      "section",
      null,
      React.createElement(SectionHeading, null, "Recent runs"),
      DataTable({
        data: data.runs,
        columns: runColumns(),
        keyExtractor: (run: EvaluationRunSummary) => run.runId,
        emptyMessage:
          data.resultsStatus === "available"
            ? "No evaluation runs observed."
            : "Stored runs are unavailable; only runs started by this Runtime are listed."
      })
    ),
    React.createElement(
      "section",
      null,
      React.createElement(SectionHeading, null, "Result history"),
      filterForm(data),
      resultError
        ? React.createElement(
            InlineAlert,
            { tone: "warning", title: "Result detail could not be loaded" },
            React.createElement(
              "span",
              { className: "text-xs font-mono" },
              `${resultError.code}: ${resultError.message}`
            )
          )
        : null,
      selectedResult
        ? React.createElement(
            "div",
            { className: "mb-4" },
            React.createElement(EvaluationResultPanel, {
              detail: selectedResult,
              closeHref: hrefWith(params)
            })
          )
        : null,
      data.resultsStatus === "available"
        ? React.createElement(EvaluationResultsTable, {
            results: data.results,
            resultHref: (result) =>
              resultHref(EVALUATIONS_PATH, params, result),
            emptyMessage: Object.values(data.filter).some(Boolean)
              ? "No evaluation results match these filters."
              : "No evaluation results have been recorded."
          })
        : null
    )
  );
}
