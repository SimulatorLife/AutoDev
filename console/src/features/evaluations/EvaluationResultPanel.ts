import type {
  ControlApiEvaluationResultResponse,
  EvaluationTraceSpan
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import {
  formatScore,
  InlineAlert,
  NOT_OBSERVED,
  OutcomeBadge,
  SectionHeading,
  subjectLabel
} from "./presentation.ts";

export interface EvaluationResultPanelProps {
  readonly detail: ControlApiEvaluationResultResponse;
  /** Link that closes the panel and returns to the surrounding view. */
  readonly closeHref: string;
}

function spanDepths(
  spans: readonly EvaluationTraceSpan[]
): Map<string, number> {
  const parents = new Map(
    spans.map((span) => [span.spanId, span.parentSpanId])
  );
  const depths = new Map<string, number>();
  for (const span of spans) {
    let depth = 0;
    let parent = span.parentSpanId;
    const seen = new Set<string>();
    while (parent && parents.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = parents.get(parent) ?? null;
    }
    depths.set(span.spanId, depth);
  }
  return depths;
}

function tokens(span: EvaluationTraceSpan): string {
  if (span.inputTokens === null && span.outputTokens === null) return "—";
  return `${span.inputTokens ?? "—"} in / ${span.outputTokens ?? "—"} out`;
}

function field(label: string, value: React.ReactNode): React.JSX.Element {
  return React.createElement(
    "div",
    { key: label, className: "flex flex-col gap-0.5" },
    React.createElement(
      "dt",
      { className: "text-xs uppercase tracking-wider text-slate-500" },
      label
    ),
    React.createElement(
      "dd",
      { className: "font-mono text-xs text-slate-200 break-all" },
      value
    )
  );
}

/**
 * One evaluation result with its judged metrics and the spans of its linked
 * trace (the case span, routed request, and provider attempts).
 */
export function EvaluationResultPanel({
  detail,
  closeHref
}: EvaluationResultPanelProps): React.JSX.Element {
  const { result } = detail;
  const depths = spanDepths(detail.spans);
  const spanColumns: ColumnDef<EvaluationTraceSpan>[] = [
    {
      id: "name",
      header: "Span",
      cell: (span) =>
        React.createElement(
          "span",
          {
            className: "font-mono text-xs text-slate-100",
            style: { paddingLeft: `${(depths.get(span.spanId) ?? 0) * 16}px` }
          },
          span.name
        )
    },
    {
      id: "status",
      header: "Status",
      cell: (span) =>
        React.createElement(StatusBadge, {
          status:
            span.status === "error"
              ? "error"
              : span.status === "ok"
                ? "valid"
                : "not-observed",
          label:
            span.status === "error"
              ? "Error"
              : span.status === "ok"
                ? "OK"
                : "Unset"
        })
    },
    {
      id: "duration",
      header: "Duration",
      cell: (span) =>
        span.durationMs === null ? "—" : `${span.durationMs.toFixed(1)} ms`
    },
    {
      id: "provider",
      header: "Provider / model",
      cell: (span) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          [span.provider, span.responseModel ?? span.requestModel]
            .filter(Boolean)
            .join(" · ") || "—"
        )
    },
    { id: "tokens", header: "Tokens", cell: tokens },
    {
      id: "started",
      header: "Started",
      cell: (span) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-400 font-mono" },
          span.startedAt
        )
    }
  ];

  const usageLinks = [
    result.subject.model
      ? {
          href: `/usage?${new URLSearchParams({ model: result.subject.model }).toString()}`,
          label: `Usage for ${result.subject.model}`
        }
      : null,
    result.subject.agent
      ? {
          href: `/usage?${new URLSearchParams({ agent: result.subject.agent }).toString()}`,
          label: `Usage for agent ${result.subject.agent}`
        }
      : null
  ].filter((link): link is { href: string; label: string } => link !== null);

  return React.createElement(
    "section",
    {
      "data-evaluation-result": result.id,
      "data-trace-status": detail.traceStatus,
      className:
        "rounded-lg border border-slate-700 bg-slate-900/80 p-5 flex flex-col gap-5"
    },
    React.createElement(
      "div",
      { className: "flex items-center justify-between gap-3" },
      React.createElement(
        "div",
        { className: "flex items-center gap-3" },
        React.createElement(
          "h2",
          { className: "text-base font-semibold text-slate-100" },
          "Result detail"
        ),
        React.createElement(OutcomeBadge, { outcome: result.outcome })
      ),
      React.createElement(
        "a",
        {
          href: closeHref,
          className: "text-xs text-slate-400 hover:underline"
        },
        "Close"
      )
    ),
    React.createElement(
      "dl",
      { className: "grid grid-cols-2 md:grid-cols-4 gap-4" },
      field("Result", result.id),
      field("Recorded", result.createdAt),
      field("Source", result.source ?? NOT_OBSERVED),
      field("Definition", result.definitionId ?? "Unattributed"),
      field("Run", result.run?.id ?? NOT_OBSERVED),
      field("Case", result.caseId ?? NOT_OBSERVED),
      field("Target", subjectLabel(result.subject)),
      field("Response model", result.responseModel ?? NOT_OBSERVED),
      field("Judge", result.judgeModel ?? NOT_OBSERVED),
      field("Error", result.error ?? "—"),
      field("Trace", result.traceId ?? NOT_OBSERVED),
      field("Span", result.spanId ?? NOT_OBSERVED)
    ),
    React.createElement(
      "div",
      null,
      React.createElement(SectionHeading, null, "Judged metrics"),
      result.metrics.length === 0
        ? React.createElement(
            "p",
            { className: "text-sm text-slate-400" },
            result.error
              ? `No metrics: the case ended with ${result.error}.`
              : "No metrics were recorded for this result."
          )
        : React.createElement(
            "ul",
            { className: "flex flex-col gap-2" },
            result.metrics.map((metric) =>
              React.createElement(
                "li",
                {
                  key: metric.name,
                  "data-verdict": metric.verdict,
                  className:
                    "rounded border border-slate-800 bg-slate-950/40 p-3 text-sm"
                },
                React.createElement(
                  "div",
                  { className: "flex flex-wrap items-center gap-3" },
                  React.createElement(
                    "span",
                    { className: "font-mono text-slate-100" },
                    metric.name
                  ),
                  React.createElement(StatusBadge, {
                    status:
                      metric.verdict === "pass"
                        ? "valid"
                        : metric.verdict === "fail"
                          ? "invalid"
                          : "not-observed",
                    label:
                      metric.verdict === "pass"
                        ? "Pass"
                        : metric.verdict === "fail"
                          ? "Fail"
                          : "Unknown"
                  }),
                  React.createElement(
                    "span",
                    { className: "font-mono text-xs text-slate-400" },
                    `score ${formatScore(metric.score)} · threshold ${
                      metric.threshold === null
                        ? "not recorded"
                        : metric.threshold
                    }${metric.classification ? ` · ${metric.classification}` : ""}`
                  )
                ),
                metric.explanation
                  ? React.createElement(
                      "p",
                      {
                        className: "mt-2 text-xs text-slate-300 leading-relaxed"
                      },
                      metric.explanation
                    )
                  : null
              )
            )
          )
    ),
    React.createElement(
      "div",
      null,
      React.createElement(SectionHeading, null, "Linked trace"),
      detail.traceStatus === "available"
        ? DataTable({
            data: detail.spans,
            columns: spanColumns,
            keyExtractor: (span: EvaluationTraceSpan) => span.spanId,
            emptyMessage: "No spans."
          })
        : detail.traceStatus === "unavailable"
          ? React.createElement(
              InlineAlert,
              { tone: "warning", title: "Trace could not be read" },
              detail.traceMessage ?? "The telemetry store is unavailable."
            )
          : React.createElement(
              "p",
              {
                className: "text-sm text-slate-400",
                "data-status": "not-observed"
              },
              result.traceId || result.spanId
                ? "Trace not observed: no spans were exported for this result's trace."
                : "Trace not observed: the producer recorded no trace link."
            ),
      usageLinks.length > 0
        ? React.createElement(
            "div",
            { className: "mt-3 flex gap-4" },
            usageLinks.map((link) =>
              React.createElement(
                "a",
                {
                  key: link.href,
                  href: link.href,
                  className: "text-xs text-emerald-400 hover:underline"
                },
                `${link.label} →`
              )
            )
          )
        : null
    )
  );
}
