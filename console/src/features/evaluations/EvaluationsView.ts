import {
  type EvaluationResult,
  isOpenTelemetrySpanId,
  type UsageTraceDetail,
  type UsageTraceSpan
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  MONO_ID_CLASS,
  MONO_META_CLASS,
  MONO_VALUE_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import {
  ERROR_TONE_CLASS,
  NEUTRAL_TONE_CLASS,
  SUCCESS_TONE_CLASS
} from "../../components/ui/tones.ts";

export type EvaluationTraceLookup =
  | { readonly kind: "invalid-span-id" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "observed"; readonly detail: UsageTraceDetail };

export interface EvaluationsViewProps {
  readonly evaluations?: readonly EvaluationResult[] | undefined;
  readonly promptFilter?: string | undefined;
  readonly traceLookup?: EvaluationTraceLookup | null | undefined;
}

function traceHref(spanId: string, promptFilter?: string): string {
  const params = new URLSearchParams();
  if (promptFilter) params.set("prompt", promptFilter);
  params.set("spanId", spanId);
  return "/evaluations?" + params.toString();
}

function traceReference(
  evaluation: EvaluationResult,
  promptFilter?: string
): React.ReactNode {
  if (!evaluation.spanId) {
    return React.createElement(StatusBadge, {
      status: "not-observed",
      label: NOT_OBSERVED_LABEL
    });
  }
  if (!isOpenTelemetrySpanId(evaluation.spanId)) {
    return React.createElement(StatusBadge, {
      status: "invalid",
      label: "Invalid reference"
    });
  }
  return React.createElement(
    "a",
    {
      href: traceHref(evaluation.spanId, promptFilter),
      className:
        "font-mono text-xs font-medium text-accent underline-offset-4 hover:underline ",
      "aria-label": `View trace for evaluation ${evaluation.id}`,
      "data-evaluation-trace-span-id": evaluation.spanId
    },
    "View trace"
  );
}

function traceSpanLink(
  spanId: string,
  label: string,
  promptFilter?: string
): React.JSX.Element {
  return React.createElement(
    "a",
    {
      href: traceHref(spanId, promptFilter),
      className:
        "font-mono text-xs text-accent underline-offset-4 hover:underline ",
      "aria-label": `Open span ${spanId}`,
      "data-trace-span-id": spanId
    },
    label
  );
}

function traceSpanLabel(
  span: UsageTraceSpan,
  promptFilter?: string
): React.ReactNode {
  return traceSpanLink(span.spanId, span.spanId.slice(0, 8), promptFilter);
}

function traceColumns(
  promptFilter?: string
): readonly ColumnDef<UsageTraceSpan>[] {
  return [
    {
      id: "span",
      header: "Span",
      cell: (span) => traceSpanLabel(span, promptFilter)
    },
    {
      id: "parent",
      header: "Parent span",
      cell: (span) =>
        span.parentSpanId
          ? traceSpanLink(
              span.parentSpanId,
              span.parentSpanId.slice(0, 8),
              promptFilter
            )
          : "Root span"
    },
    {
      id: "name",
      header: "Operation",
      cell: (span) => span.spanName || NOT_OBSERVED_LABEL
    },
    {
      id: "service",
      header: "Service",
      cell: (span) => span.serviceName || NOT_OBSERVED_LABEL
    },
    {
      id: "timestamp",
      header: "Start time",
      cell: (span) =>
        React.createElement(
          "span",
          { className: MONO_META_CLASS },
          span.timestamp
        )
    },
    {
      id: "duration",
      header: "Duration",
      cell: (span) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          `${(span.durationNs / 1_000_000).toFixed(1)} ms`
        )
    },
    {
      id: "status",
      header: "Span status",
      cell: (span) => {
        const style =
          span.statusCode === "ERROR"
            ? "text-error"
            : span.statusCode === "OK"
              ? "text-success"
              : MUTED_TEXT_CLASS;
        return React.createElement(
          "span",
          { className: `font-mono text-xs ${style}` },
          span.statusCode === "UNSET" ? NOT_OBSERVED_LABEL : span.statusCode
        );
      }
    }
  ];
}

function renderTraceLookup(
  traceLookup: EvaluationTraceLookup,
  promptFilter?: string
): React.JSX.Element {
  if (traceLookup.kind !== "observed") {
    const messages: Record<
      Exclude<EvaluationTraceLookup["kind"], "observed">,
      string
    > = {
      "invalid-span-id":
        "The selected evaluation does not contain a valid trace reference.",
      "not-configured": "Trace lookup is not configured on the Console server.",
      "not-found":
        "The referenced span was not observed in retained telemetry.",
      unavailable: "Trace details are currently unavailable."
    };
    const status =
      traceLookup.kind === "invalid-span-id"
        ? "invalid"
        : traceLookup.kind === "not-found"
          ? "not-observed"
          : "unavailable";
    return React.createElement(
      "div",
      {
        role: "alert",
        className: CALLOUT_WARNING_CLASS,
        "data-feature": "evaluation-trace-detail",
        "data-trace-state": traceLookup.kind,
        "data-status": status
      },
      messages[traceLookup.kind]
    );
  }

  const { detail } = traceLookup;
  return React.createElement(
    "section",
    {
      className: `flex flex-col gap-4 ${LIST_PANEL_CLASS}`,
      "aria-labelledby": "evaluation-trace-heading",
      "data-feature": "evaluation-trace-detail",
      "data-trace-state": "observed",
      "data-trace-partial": detail.partial ? "true" : "false"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "h2",
        {
          id: "evaluation-trace-heading",
          className: SECTION_HEADING_CLASS
        },
        "Trace detail"
      ),
      React.createElement(
        "a",
        {
          href: promptFilter
            ? "/evaluations?prompt=" + encodeURIComponent(promptFilter)
            : "/evaluations",
          className: "text-xs text-accent underline-offset-4 hover:underline "
        },
        "Back to evaluations"
      )
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap gap-4 text-xs text-fg-secondary" },
      React.createElement(
        "span",
        null,
        "Trace ID: ",
        React.createElement(
          "code",
          { className: "font-mono text-fg" },
          detail.traceId
        )
      ),
      React.createElement("span", null, `${detail.spans.length} spans shown`),
      detail.partial
        ? React.createElement(
            "span",
            { role: "status", className: "text-warning" },
            "Trace is partial; additional spans were omitted by the bounded result limit."
          )
        : null
    ),
    React.createElement<DataTableProps<UsageTraceSpan>>(DataTable, {
      data: detail.spans,
      columns: traceColumns(promptFilter),
      keyExtractor: (span) => span.spanId,
      emptyMessage: "No trace spans were observed."
    })
  );
}

export function EvaluationsView({
  evaluations = [],
  promptFilter,
  traceLookup
}: EvaluationsViewProps): React.JSX.Element {
  const total = evaluations.length;
  const passed = evaluations.filter(
    (evaluation) => evaluation.passed === true
  ).length;
  const failed = evaluations.filter(
    (evaluation) => evaluation.passed === false
  ).length;
  const observedOutcomes = passed + failed;
  const passRate =
    observedOutcomes > 0
      ? `${Math.round((passed / observedOutcomes) * 100)}%`
      : NOT_OBSERVED_LABEL;

  const columns: ColumnDef<EvaluationResult>[] = [
    {
      id: "agentRole",
      header: "Target Role",
      cell: (ev) =>
        React.createElement("span", { className: MONO_ID_CLASS }, ev.agentRole)
    },
    {
      id: "model",
      header: "Model",
      cell: (ev) =>
        React.createElement("span", { className: MONO_VALUE_CLASS }, ev.model)
    },
    {
      id: "metrics",
      header: "Metrics",
      cell: (ev) =>
        React.createElement(
          "div",
          { className: "flex gap-2" },
          ev.metrics.map((m) => {
            const verdict =
              m.pass === null
                ? NOT_OBSERVED_LABEL
                : m.pass
                  ? "Passed"
                  : "Failed";
            return React.createElement(Tag, {
              key: m.name,
              className: `font-mono ${
                m.pass === true
                  ? SUCCESS_TONE_CLASS
                  : m.pass === false
                    ? ERROR_TONE_CLASS
                    : NEUTRAL_TONE_CLASS
              }`,
              children: `${m.name}: ${m.value} · ${verdict}`
            });
          })
        )
    },
    {
      id: "passed",
      header: "Outcome",
      cell: (ev) =>
        React.createElement(StatusBadge, {
          status:
            ev.passed === null
              ? "not-observed"
              : ev.passed
                ? "valid"
                : "invalid",
          label:
            ev.passed === null
              ? NOT_OBSERVED_LABEL
              : ev.passed
                ? "Passed"
                : "Failed"
        })
    },
    {
      id: "trace",
      header: "Trace",
      cell: (ev) => traceReference(ev, promptFilter)
    },
    {
      id: "timestamp",
      header: "Run Time",
      cell: (ev) =>
        React.createElement(
          "span",
          { className: MUTED_META_CLASS },
          ev.timestamp
        )
    }
  ];

  const filteredPromptNotice = promptFilter
    ? React.createElement(
        "p",
        {
          className:
            "rounded border border-border bg-surface/60 px-3 py-2 text-xs text-fg-secondary",
          "data-evaluations-prompt-filter": promptFilter
        },
        "Filtered to prompt ",
        React.createElement(
          "code",
          { className: "font-mono text-fg" },
          promptFilter
        ),
        " · ",
        React.createElement(
          "a",
          { href: "/evaluations", className: "text-accent hover:underline" },
          "Clear filter"
        )
      )
    : null;

  return React.createElement(
    PageBody,
    {
      feature: "evaluations",
      attributes: {
        "data-evaluation-pass-rate-observed":
          observedOutcomes > 0 ? "true" : "false"
      }
    },
    filteredPromptNotice,
    traceLookup ? renderTraceLookup(traceLookup, promptFilter) : null,
    React.createElement(
      StatGrid,
      { columns: 3 },
      React.createElement(StatCard, {
        title: "Total Evaluations",
        value: total
      }),
      React.createElement(StatCard, { title: "Passed", value: passed }),
      React.createElement(StatCard, {
        title: "Pass Rate",
        value: passRate,
        subtitle: `${observedOutcomes} of ${total} with explicit verdicts`
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Evaluation History"
      ),
      React.createElement<DataTableProps<EvaluationResult>>(DataTable, {
        data: evaluations,
        columns,
        keyExtractor: (e: EvaluationResult) => e.id,
        emptyMessage:
          "No evaluation results are present in the available history."
      })
    )
  );
}
