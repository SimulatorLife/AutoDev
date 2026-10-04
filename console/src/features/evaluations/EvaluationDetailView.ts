import type {
  ControlApiEvaluationDetailResponse,
  ControlApiEvaluationResultResponse,
  EvaluationCaseMatrix,
  EvaluationRunSummary,
  EvaluationTargetComparison,
  EvaluationTargetResolution
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import { EvaluationDefinitionEditor } from "./EvaluationDefinitionEditor.ts";
import { EvaluationResultPanel } from "./EvaluationResultPanel.ts";
import { EvaluationResultsTable } from "./EvaluationResultsTable.ts";
import {
  formatDelta,
  formatRate,
  formatScore,
  InlineAlert,
  NOT_OBSERVED,
  OutcomeBadge,
  ReferenceBadge,
  resultHref,
  RunStatusBadge,
  SectionHeading
} from "./presentation.ts";

/** A server-issued action form: hidden fields plus its signed token. */
export interface EvaluationActionForm {
  readonly action: "save" | "run" | "delete";
  readonly definitionId: string;
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly formToken: string;
}

export interface EvaluationDetailForms {
  /** Null when the definition cannot start a run. */
  readonly run: EvaluationActionForm | null;
  readonly remove: EvaluationActionForm;
  readonly save: EvaluationActionForm;
}

export interface EvaluationDetailViewProps {
  readonly detail: ControlApiEvaluationDetailResponse;
  readonly forms: EvaluationDetailForms;
  readonly criterionTypes: readonly string[];
  readonly editing?: boolean;
  readonly notice?: string | null;
  readonly noticeCode?: string | null;
  readonly selectedResult?: ControlApiEvaluationResultResponse | null;
  readonly resultError?: {
    readonly code: string;
    readonly message: string;
  } | null;
}

const BUTTON =
  "rounded border px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500";

function hiddenInputs(form: EvaluationActionForm): React.JSX.Element[] {
  return Object.entries({
    action: form.action,
    definitionId: form.definitionId,
    formToken: form.formToken,
    ...(form.expectedRevision
      ? { expectedRevision: form.expectedRevision }
      : {}),
    ...(form.idempotencyKey ? { idempotencyKey: form.idempotencyKey } : {})
  }).map(([name, value]) =>
    React.createElement("input", { key: name, type: "hidden", name, value })
  );
}

function runBlocker(detail: ControlApiEvaluationDetailResponse): string | null {
  if (!detail.definition.enabled) return "Disabled definitions cannot run.";
  if (!detail.validation.runnable)
    return "Resolve every target, prompt, and the judge before running.";
  if (detail.runs.some((run) => run.status === "running"))
    return "A run is in progress.";
  return null;
}

function actions(
  detail: ControlApiEvaluationDetailResponse,
  forms: EvaluationDetailForms
): React.JSX.Element {
  const blocker = runBlocker(detail);
  const id = encodeURIComponent(detail.definition.id);
  return React.createElement(
    "div",
    { className: "flex flex-wrap items-center gap-3" },
    forms.run && !blocker
      ? React.createElement(
          "form",
          { method: "post", action: "/api/evaluations" },
          ...hiddenInputs(forms.run),
          React.createElement(
            "button",
            {
              type: "submit",
              className: `${BUTTON} border-emerald-700 bg-emerald-900/50 text-emerald-100 hover:bg-emerald-900/80`
            },
            "Run evaluation"
          )
        )
      : React.createElement(
          "span",
          {
            className: "text-xs text-slate-400",
            "data-run-blocked": "true"
          },
          blocker ?? "Runs are unavailable."
        ),
    React.createElement(
      "a",
      {
        href: `/evaluations/${id}?edit=1`,
        className: `${BUTTON} border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700`
      },
      "Edit definition"
    ),
    React.createElement(
      "form",
      {
        method: "post",
        action: "/api/evaluations",
        className: "flex items-center gap-2"
      },
      ...hiddenInputs(forms.remove),
      React.createElement(
        "label",
        { className: "flex items-center gap-1 text-xs text-slate-400" },
        React.createElement("input", {
          type: "checkbox",
          name: "confirm",
          value: "yes",
          required: true
        }),
        "Confirm"
      ),
      React.createElement(
        "button",
        {
          type: "submit",
          className: `${BUTTON} border-rose-800 bg-rose-950/50 text-rose-200 hover:bg-rose-900/60`
        },
        "Delete"
      )
    )
  );
}

function targetColumns(): ColumnDef<EvaluationTargetResolution>[] {
  return [
    {
      id: "key",
      header: "Target",
      cell: (entry) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-100" },
          entry.key
        )
    },
    {
      id: "kind",
      header: "Kind",
      cell: (entry) => entry.target.kind
    },
    {
      id: "prompt",
      header: "Prompt",
      cell: (entry) =>
        entry.target.prompt
          ? React.createElement(
              "a",
              {
                href: `/prompts/${encodeURIComponent(entry.target.prompt)}`,
                className: "font-mono text-xs text-emerald-400 hover:underline"
              },
              entry.target.prompt
            )
          : "—"
    },
    {
      id: "status",
      header: "Reference",
      cell: (entry) =>
        React.createElement(ReferenceBadge, { status: entry.status })
    }
  ];
}

function runColumns(
  definitionId: string,
  selectedRunId: string | null
): ColumnDef<EvaluationRunSummary>[] {
  return [
    {
      id: "started",
      header: "Started",
      cell: (run) =>
        React.createElement(
          "a",
          {
            href: `/evaluations/${encodeURIComponent(definitionId)}?run=${encodeURIComponent(run.runId)}`,
            "aria-current": run.runId === selectedRunId ? "true" : undefined,
            className: `font-mono text-xs hover:underline ${
              run.runId === selectedRunId
                ? "text-emerald-300 font-semibold"
                : "text-emerald-400"
            }`
          },
          run.startedAt ?? run.lastResultAt ?? run.runId
        )
    },
    {
      id: "status",
      header: "Status",
      cell: (run) =>
        React.createElement(
          "span",
          { className: "flex items-center gap-2" },
          React.createElement(RunStatusBadge, { status: run.status }),
          run.failure
            ? React.createElement(
                "span",
                { className: "font-mono text-xs text-rose-300" },
                run.failure
              )
            : null
        )
    },
    {
      id: "progress",
      header: "Results",
      cell: (run) => `${run.observedResults} / ${run.expectedResults ?? "?"}`
    },
    {
      id: "outcomes",
      header: "Pass / fail / error / unknown",
      cell: (run) =>
        `${run.passed} / ${run.failed} / ${run.errored} / ${run.unknown}`
    },
    {
      id: "rate",
      header: "Pass rate",
      cell: (run) => formatRate(run.passRate)
    }
  ];
}

function comparisonColumns(): ColumnDef<EvaluationTargetComparison>[] {
  return [
    {
      id: "target",
      header: "Target",
      cell: (entry) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-100" },
          entry.targetKey
        )
    },
    {
      id: "outcomes",
      header: "Pass / fail / error",
      cell: (entry) => `${entry.passed} / ${entry.failed} / ${entry.errored}`
    },
    {
      id: "rate",
      header: "Pass rate",
      cell: (entry) => formatRate(entry.passRate)
    },
    {
      id: "previous",
      header: "Previous run",
      cell: (entry) =>
        entry.previous ? formatRate(entry.previous.passRate) : NOT_OBSERVED
    },
    {
      id: "delta",
      header: "Change",
      cell: (entry) =>
        React.createElement(
          "span",
          {
            className:
              entry.passRateDelta === null
                ? "text-slate-500"
                : entry.passRateDelta < 0
                  ? "text-rose-300"
                  : "text-emerald-300"
          },
          formatDelta(entry.passRateDelta)
        )
    },
    {
      id: "criteria",
      header: "Mean score by criterion",
      cell: (entry) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          entry.criteria
            .map(
              (criterion) =>
                `${criterion.name} ${formatScore(criterion.meanScore)} (${criterion.failed}/${criterion.judged} failed)`
            )
            .join(" · ") || NOT_OBSERVED
        )
    }
  ];
}

function caseMatrix(
  matrix: EvaluationCaseMatrix,
  hrefFor: (resultId: string) => string
): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60 shadow",
      "data-case-matrix": matrix.runId
    },
    React.createElement(
      "table",
      { className: "min-w-full divide-y divide-slate-800 text-left text-sm" },
      React.createElement(
        "thead",
        { className: "bg-slate-950/60 text-slate-400" },
        React.createElement(
          "tr",
          null,
          React.createElement(
            "th",
            { scope: "col", className: "px-4 py-3 text-xs uppercase" },
            "Case"
          ),
          matrix.targetKeys.map((key) =>
            React.createElement(
              "th",
              {
                key,
                scope: "col",
                className: "px-4 py-3 text-xs font-mono normal-case"
              },
              key
            )
          )
        )
      ),
      React.createElement(
        "tbody",
        { className: "divide-y divide-slate-800 text-slate-200" },
        matrix.rows.map((row) =>
          React.createElement(
            "tr",
            { key: row.caseId },
            React.createElement(
              "th",
              {
                scope: "row",
                className: "px-4 py-3 font-mono text-xs text-slate-300"
              },
              row.caseId
            ),
            matrix.targetKeys.map((key) => {
              const cell = row.cells[key];
              return React.createElement(
                "td",
                { key, className: "px-4 py-3" },
                cell
                  ? React.createElement(
                      "a",
                      {
                        href: hrefFor(cell.resultId),
                        className: "flex items-center gap-2 hover:underline"
                      },
                      React.createElement(OutcomeBadge, {
                        outcome: cell.outcome
                      }),
                      React.createElement(
                        "span",
                        { className: "font-mono text-xs text-slate-400" },
                        formatScore(cell.worstScore)
                      )
                    )
                  : React.createElement(
                      "span",
                      { className: "text-xs text-slate-500" },
                      NOT_OBSERVED
                    )
              );
            })
          )
        )
      )
    )
  );
}

function definitionSummary(
  detail: ControlApiEvaluationDetailResponse
): React.JSX.Element {
  const { definition } = detail;
  return React.createElement(
    "section",
    { className: "grid grid-cols-1 lg:grid-cols-3 gap-4" },
    React.createElement(
      "div",
      { className: "lg:col-span-2" },
      React.createElement(SectionHeading, null, "Targets"),
      DataTable({
        data: detail.validation.targets,
        columns: targetColumns(),
        keyExtractor: (entry: EvaluationTargetResolution) => entry.key
      })
    ),
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "div",
        null,
        React.createElement(SectionHeading, null, "Judge"),
        React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement(
            "span",
            { className: "font-mono text-xs text-slate-200" },
            definition.judge.model
          ),
          React.createElement(ReferenceBadge, {
            status: detail.validation.judge
          })
        )
      ),
      React.createElement(
        "div",
        null,
        React.createElement(SectionHeading, null, "Criteria"),
        React.createElement(
          "ul",
          { className: "flex flex-col gap-1 text-xs font-mono text-slate-300" },
          definition.criteria.map((criterion) =>
            React.createElement(
              "li",
              { key: criterion.type },
              `${criterion.type} — fails above ${criterion.threshold}`
            )
          )
        )
      ),
      React.createElement(
        "div",
        null,
        React.createElement(
          SectionHeading,
          null,
          `Cases (${definition.cases.length})`
        ),
        React.createElement(
          "ul",
          { className: "flex flex-col gap-1 text-xs text-slate-300" },
          definition.cases.map((entry) =>
            React.createElement(
              "li",
              { key: entry.id, title: entry.input },
              React.createElement(
                "span",
                { className: "font-mono text-slate-100 mr-2" },
                entry.id
              ),
              entry.input.length > 80
                ? `${entry.input.slice(0, 80)}…`
                : entry.input,
              entry.context ? " · with context" : ""
            )
          )
        )
      )
    )
  );
}

function detailHeader(
  detail: ControlApiEvaluationDetailResponse,
  forms: EvaluationDetailForms
): React.JSX.Element {
  const { definition } = detail;
  return React.createElement(
    "header",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "a",
      {
        href: "/evaluations",
        className: "text-xs text-slate-400 hover:underline"
      },
      "← Evaluations"
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-3" },
      React.createElement(
        "h1",
        { className: "text-xl font-semibold text-slate-100" },
        definition.name
      ),
      React.createElement(
        "span",
        { className: "font-mono text-xs text-slate-400" },
        `${definition.id} · revision ${detail.revision}`
      ),
      React.createElement(StatusBadge, {
        status: definition.enabled ? "configured" : "not-observed",
        label: definition.enabled ? "Enabled" : "Disabled"
      }),
      React.createElement(StatusBadge, {
        status: detail.validation.runnable ? "valid" : "invalid",
        label: detail.validation.runnable ? "Runnable" : "Unresolved"
      })
    ),
    definition.description
      ? React.createElement(
          "p",
          { className: "text-sm text-slate-300" },
          definition.description
        )
      : null,
    actions(detail, forms)
  );
}

function noticeAlert(
  notice: string | null,
  noticeCode: string | null
): React.JSX.Element | null {
  if (!notice) return null;
  return React.createElement(
    InlineAlert,
    { tone: noticeCode ? "warning" : "info", title: notice },
    noticeCode
      ? React.createElement(
          "span",
          { className: "font-mono text-xs" },
          noticeCode
        )
      : null
  );
}

function resultDetail(
  selectedResult: ControlApiEvaluationResultResponse | null,
  resultError: { readonly code: string; readonly message: string } | null,
  closeHref: string
): React.JSX.Element | null {
  if (resultError) {
    return React.createElement(
      InlineAlert,
      { tone: "warning", title: "Result detail could not be loaded" },
      React.createElement(
        "span",
        { className: "text-xs font-mono" },
        `${resultError.code}: ${resultError.message}`
      )
    );
  }
  return selectedResult
    ? React.createElement(EvaluationResultPanel, {
        detail: selectedResult,
        closeHref
      })
    : null;
}

export function EvaluationDetailView({
  detail,
  forms,
  criterionTypes,
  editing = false,
  notice = null,
  noticeCode = null,
  selectedResult = null,
  resultError = null
}: EvaluationDetailViewProps): React.JSX.Element {
  const { definition } = detail;
  const basePath = `/evaluations/${encodeURIComponent(definition.id)}`;
  const runParams = { run: detail.selectedRunId };
  const selectedRun =
    detail.runs.find((run) => run.runId === detail.selectedRunId) ?? null;

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "evaluation-detail",
      "data-evaluation-definition": definition.id,
      "data-results-status": detail.resultsStatus
    },
    detailHeader(detail, forms),
    noticeAlert(notice, noticeCode),
    editing
      ? React.createElement(EvaluationDefinitionEditor, {
          initialText: JSON.stringify(definition, null, 2),
          definitionId: forms.save.definitionId,
          expectedRevision: forms.save.expectedRevision,
          formToken: forms.save.formToken,
          criterionTypes,
          cancelHref: basePath
        })
      : definitionSummary(detail),
    detail.resultsStatus === "unavailable"
      ? React.createElement(
          InlineAlert,
          { tone: "warning", title: "Evaluation results are unavailable" },
          React.createElement(
            "p",
            { className: "text-xs font-mono" },
            detail.resultsMessage ??
              "The OpenLIT evaluation store did not answer."
          )
        )
      : null,
    React.createElement(
      "section",
      null,
      React.createElement(SectionHeading, null, "Runs"),
      DataTable({
        data: detail.runs,
        columns: runColumns(definition.id, detail.selectedRunId),
        keyExtractor: (run: EvaluationRunSummary) => run.runId,
        emptyMessage:
          detail.resultsStatus === "available"
            ? "This definition has not been run."
            : "Stored runs are unavailable; only runs started by this Runtime are listed."
      })
    ),
    selectedRun
      ? React.createElement(
          "section",
          { "data-selected-run": selectedRun.runId },
          React.createElement(
            SectionHeading,
            null,
            "Target comparison (selected run vs previous run)"
          ),
          DataTable({
            data: detail.comparisons,
            columns: comparisonColumns(),
            keyExtractor: (entry: EvaluationTargetComparison) =>
              entry.targetKey,
            emptyMessage: "No judged results are stored for this run yet."
          })
        )
      : null,
    detail.caseMatrix && detail.caseMatrix.rows.length > 0
      ? React.createElement(
          "section",
          null,
          React.createElement(SectionHeading, null, "Cases × targets"),
          caseMatrix(detail.caseMatrix, (resultId) =>
            resultHref(basePath, runParams, { id: resultId })
          )
        )
      : null,
    resultDetail(
      selectedResult,
      resultError,
      detail.selectedRunId
        ? `${basePath}?run=${encodeURIComponent(detail.selectedRunId)}`
        : basePath
    ),
    selectedRun && detail.resultsStatus === "available"
      ? React.createElement(
          "section",
          null,
          React.createElement(
            SectionHeading,
            null,
            `Results of run ${selectedRun.runId}`
          ),
          React.createElement(EvaluationResultsTable, {
            results: detail.results,
            showDefinition: false,
            resultHref: (result) => resultHref(basePath, runParams, result),
            emptyMessage: "No results are stored for this run yet."
          })
        )
      : null
  );
}
