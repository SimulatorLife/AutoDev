import {
  type EvaluationMetric,
  type EvaluationResult,
  isOpenTelemetrySpanId,
  type UsageTraceDetail,
  type UsageTraceSpan
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { FilterBar } from "../../components/filters/FilterBar.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { DetailDrawer } from "../../components/panels/DetailDrawer.ts";
import {
  DetailGrid,
  DetailValue,
  StatGrid
} from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
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
import {
  evaluationResultHref,
  EVALUATIONS_TABS,
  type EvaluationsFilters,
  evaluationsListHref,
  evaluationsTabHref,
  type EvaluationsTabId,
  evaluationsUnfilteredHref,
  evaluationTraceHref,
  hasActiveFilters,
  hasExplicitVerdict,
  OUTCOME_FILTER_LABELS
} from "./evaluations-url.ts";

/**
 * Evaluations resource view.
 *
 * Two tabs over one bounded read of the evaluation store: the run history and a
 * comparison of outcomes across the targets those runs evaluated. Both describe
 * the same filtered window, so the summary above them and the tables below them
 * cannot disagree about which rows are being counted.
 */

export type EvaluationTraceLookup =
  | { readonly kind: "invalid-span-id" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "observed"; readonly detail: UsageTraceDetail };

/** The distinct values each filter axis can narrow on. */
export interface EvaluationsFilterOptions {
  readonly roles: readonly string[];
  readonly models: readonly string[];
  readonly prompts: readonly string[];
}

export interface EvaluationsViewProps {
  /** Already narrowed by `filters`; the page owns the read, the view owns the shape. */
  readonly evaluations: readonly EvaluationResult[];
  /** Rows in the fetched window before filtering, for the filter bar's count. */
  readonly availableCount?: number | undefined;
  readonly filters: EvaluationsFilters;
  readonly filterOptions: EvaluationsFilterOptions;
  /** Which section is showing. Defaults to the run history. */
  readonly tab?: EvaluationsTabId | undefined;
  /** Result id opened in the detail drawer, or `null`. */
  readonly selection?: string | null | undefined;
  readonly traceLookup?: EvaluationTraceLookup | null | undefined;
}

/**
 * Verdict wording for one evaluation.
 *
 * The three-way mapping is the target state's rule made literal: a run is
 * Passed or Failed only when its source supplied that verdict, and everything
 * else -- no verdict, an unrecognised one, a run with no metrics at all -- is
 * Not observed. The badge variant and the label are derived together so the
 * colour can never disagree with the word beside it.
 */
const PASSED_LABEL = "Passed";
const FAILED_LABEL = "Failed";
const NOT_OBSERVED_STATUS: StatusBadgeVariant = "not-observed";

/**
 * A verdict's status and its word, derived together.
 *
 * Two literal tables were how this read before: one mapping `passed` to a badge
 * status and another mapping it to a word. They agreed today, and nothing tied
 * them -- so adding a verdict meant editing two lists, and the failure mode is a
 * badge whose colour contradicts the sentence next to it. One table cannot.
 */
function verdictOf(passed: boolean | null | undefined): {
  readonly status: StatusBadgeVariant;
  readonly label: string;
} {
  if (passed === true) return { status: "valid", label: PASSED_LABEL };
  if (passed === false) return { status: "invalid", label: FAILED_LABEL };
  return { status: NOT_OBSERVED_STATUS, label: NOT_OBSERVED_LABEL };
}

function outcomeBadge(evaluation: EvaluationResult): React.JSX.Element {
  const { status, label } = verdictOf(evaluation.passed);
  return React.createElement(StatusBadge, { status, label });
}

/** A metric's own verdict, which is not the evaluation's outcome. */
function metricVerdict(metric: EvaluationMetric): {
  readonly label: string;
  readonly tone: string;
} {
  return {
    label: verdictOf(metric.pass).label,
    tone:
      metric.pass === true
        ? SUCCESS_TONE_CLASS
        : metric.pass === false
          ? ERROR_TONE_CLASS
          : NEUTRAL_TONE_CLASS
  };
}

/**
 * One metric as a chip.
 *
 * `wrap` rather than the default truncation, because the chip carries three
 * separate facts -- the measurement's name, its value, and its verdict -- and
 * the verdict is what says whether this particular measurement passed. Cut at
 * `tool_failures: 4 · Fai…`, the chip stops being a reading and becomes a
 * measurement whose result is unknown, which is the one thing the target state
 * forbids inferring. Wrapping keeps all three.
 */
function metricChip(metric: EvaluationMetric): React.JSX.Element {
  const verdict = metricVerdict(metric);
  return React.createElement(Tag, {
    wrap: true,
    className: `font-mono ${verdict.tone}`,
    children: `${metric.name}: ${metric.value} · ${verdict.label}`,
    dataAttributes: { "data-evaluation-metric": metric.name }
  });
}

/**
 * The metric list inside a history row.
 *
 * An evaluation with no metrics renders the same Not observed badge every other
 * unobserved verdict does, rather than an empty cell. The empty cell and the
 * missing measurement are different answers, and a blank box is indistinguishable
 * from a row that failed to render.
 */
function metricCell(evaluation: EvaluationResult): React.JSX.Element {
  if (evaluation.metrics.length === 0) {
    return React.createElement(StatusBadge, {
      status: NOT_OBSERVED_STATUS,
      label: NOT_OBSERVED_LABEL,
      title: "This evaluation reported no metrics, so none were observed."
    });
  }
  return React.createElement(
    "div",
    { className: "flex flex-wrap gap-2" },
    ...evaluation.metrics.map((metric) =>
      // The item needs its own `max-w-full`, not just the chip's. A flex item is
      // sized to max-content, so the chip's `max-w-full` would resolve against a
      // wrapper already as wide as the chip and constrain nothing -- the longest
      // metric would then paint past the cell instead of wrapping in it.
      React.createElement(
        "span",
        { key: metric.name, className: "min-w-0 max-w-full" },
        metricChip(metric)
      )
    )
  );
}

const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/u;

/**
 * Run time, split so it can break between its parts.
 *
 * The raw ISO string is 24 characters and has no break opportunity, so a column
 * holding one either truncates or pushes every other column out. Rendering the
 * date and the clock as two items in a wrapping row gives the column a natural
 * 10-character budget and lets the row fold onto two lines at a narrow width
 * instead of losing the seconds. The full value stays on `title`, and the
 * machine-readable form stays in `dateTime`.
 */
function runTimeCell(evaluation: EvaluationResult): React.JSX.Element {
  const match = UTC_TIMESTAMP.exec(evaluation.timestamp);
  const parts = match
    ? { date: match[1] ?? "", time: `${match[2] ?? ""}Z` }
    : { date: evaluation.timestamp, time: "" };
  // `min-w-0` on both parts is what keeps a narrow column from overflowing.
  // A flex item defaults to `min-width: auto`, so `2026-10-05` refuses to
  // shrink below its own width and the cell paints straight through the table's
  // right edge -- outside the scroll container that was supposed to contain it.
  // Allowing each part to break instead means a narrow column folds the value
  // onto more lines rather than losing it off-screen.
  return React.createElement(
    "span",
    {
      className: "flex flex-wrap items-baseline gap-x-1.5",
      title: evaluation.timestamp
    },
    React.createElement(
      "time",
      {
        dateTime: evaluation.timestamp,
        className: `${MONO_META_CLASS} min-w-0 break-words`
      },
      parts.date
    ),
    parts.time === ""
      ? null
      : React.createElement(
          "span",
          { className: `${MONO_META_CLASS} min-w-0 break-words` },
          parts.time
        )
  );
}

/** The value a prompt-less run reports instead of naming a prompt. */
const NO_PROMPT_LABEL = "No prompt";

/**
 * Where a link on this page should land.
 *
 * The filters and the open tab travel together, so every link built below
 * carries both. Passing them separately is how a trace link came to preserve the
 * narrowing but drop the tab, landing the operator on the results page after they
 * had opened a comparison.
 */
interface EvaluationsNav {
  readonly filters: EvaluationsFilters;
  readonly tab: EvaluationsTabId;
}

function traceReference(
  evaluation: EvaluationResult,
  nav: EvaluationsNav
): React.ReactNode {
  if (!evaluation.spanId) {
    return React.createElement(StatusBadge, {
      status: NOT_OBSERVED_STATUS,
      label: NOT_OBSERVED_LABEL,
      title: "This evaluation did not report a trace reference."
    });
  }
  if (!isOpenTelemetrySpanId(evaluation.spanId)) {
    return React.createElement(StatusBadge, {
      status: "invalid",
      label: "Invalid span",
      title: `The reported trace reference is not a valid OpenTelemetry span id: ${evaluation.spanId}`
    });
  }
  return React.createElement(
    "a",
    {
      href: evaluationTraceHref(nav.filters, evaluation.spanId, nav.tab),
      className:
        "font-mono text-xs font-medium text-accent underline-offset-4 hover:underline",
      "aria-label": `View trace for evaluation ${evaluation.id}`,
      "data-evaluation-trace-span-id": evaluation.spanId
    },
    "View trace"
  );
}

function spanLink(spanId: string, nav: EvaluationsNav): React.JSX.Element {
  return React.createElement(
    "a",
    {
      href: evaluationTraceHref(nav.filters, spanId, nav.tab),
      className:
        "font-mono text-xs text-accent underline-offset-4 hover:underline",
      "aria-label": `Open span ${spanId}`,
      "data-trace-span-id": spanId
    },
    spanId.slice(0, 8)
  );
}

function traceColumns(
  nav: EvaluationsNav
): readonly ColumnDef<UsageTraceSpan>[] {
  return [
    {
      id: "span",
      header: "Span",
      weight: 110,
      cell: (span) => spanLink(span.spanId, nav)
    },
    {
      id: "parent",
      header: "Parent span",
      weight: 110,
      cell: (span) =>
        span.parentSpanId ? spanLink(span.parentSpanId, nav) : "Root span"
    },
    {
      id: "name",
      header: "Operation",
      weight: 200,
      align: "tokens",
      cell: (span) => span.spanName || NOT_OBSERVED_LABEL
    },
    {
      id: "service",
      header: "Service",
      weight: 130,
      align: "tokens",
      cell: (span) => span.serviceName || NOT_OBSERVED_LABEL
    },
    {
      id: "timestamp",
      header: "Start time",
      weight: 130,
      align: "tokens",
      cell: (span) =>
        React.createElement(
          "span",
          {
            className: "flex flex-wrap items-baseline gap-x-1.5",
            title: span.timestamp
          },
          React.createElement(
            "time",
            { dateTime: span.timestamp, className: MONO_META_CLASS },
            span.timestamp.slice(0, 10)
          ),
          React.createElement(
            "span",
            { className: MONO_META_CLASS },
            `${span.timestamp.slice(11, 19)}Z`
          )
        )
    },
    {
      id: "duration",
      header: "Duration",
      weight: 120,
      cell: (span) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          formatDuration(span.durationNs)
        )
    },
    {
      id: "status",
      header: "Span status",
      weight: 120,
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

/**
 * A duration at a unit an operator can read at a glance.
 *
 * Always milliseconds, `1842.0 ms` states a number nobody parses without doing
 * arithmetic, and it grew the column to fit the digits a reader has to convert.
 * The unit steps so the value stays small at every magnitude.
 */
const MINUTE_MS = 60_000;

export function formatDuration(durationNs: number): string {
  const milliseconds = durationNs / 1_000_000;
  if (milliseconds < 1) return `${(durationNs / 1000).toFixed(0)} µs`;
  if (milliseconds < 1000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < MINUTE_MS) return `${(milliseconds / 1000).toFixed(2)} s`;
  const minutes = Math.floor(milliseconds / MINUTE_MS);
  const seconds = Math.round((milliseconds % MINUTE_MS) / 1000);
  return `${minutes}m ${seconds}s`;
}

const TRACE_UNAVAILABLE_MESSAGES: Readonly<
  Record<
    Exclude<EvaluationTraceLookup["kind"], "observed">,
    { readonly status: StatusBadgeVariant; readonly message: string }
  >
> = {
  "invalid-span-id": {
    status: "invalid",
    message:
      "The selected evaluation does not contain a valid OpenTelemetry trace reference."
  },
  "not-configured": {
    status: "unavailable",
    message: "Trace lookup is not configured on the Console server."
  },
  "not-found": {
    status: NOT_OBSERVED_STATUS,
    message: "The referenced span was not observed in retained telemetry."
  },
  unauthorized: {
    status: "unavailable",
    message: "The Console's Usage credential was refused for this trace lookup."
  },
  unavailable: {
    status: "unavailable",
    message: "Trace details are currently unavailable."
  },
  "http-error": {
    status: "unavailable",
    message:
      "The Usage service answered this trace lookup with an error, so the trace is unknown rather than empty."
  }
};

function renderTraceLookup(
  traceLookup: EvaluationTraceLookup,
  nav: EvaluationsNav
): React.JSX.Element {
  if (traceLookup.kind !== "observed") {
    const { status, message } = TRACE_UNAVAILABLE_MESSAGES[traceLookup.kind];
    return React.createElement(
      "div",
      {
        role: "alert",
        className: CALLOUT_WARNING_CLASS,
        "data-feature": "evaluation-trace-detail",
        "data-trace-state": traceLookup.kind,
        "data-status": status
      },
      message
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
        { id: "evaluation-trace-heading", className: SECTION_HEADING_CLASS },
        "Trace detail"
      ),
      React.createElement(
        "a",
        {
          href: evaluationsListHref(nav.filters, { tab: nav.tab }),
          className: "text-xs text-accent underline-offset-4 hover:underline"
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
      columns: traceColumns(nav),
      keyExtractor: (span) => span.spanId,
      emptyMessage: "No trace spans were observed."
    })
  );
}

/**
 * The detail drawer for one evaluation run.
 *
 * The table carries the run's identity and its verdicts; the measurements
 * themselves are too long to also fit there without cutting them, which is the
 * same reason an unselected row shows a metric count rather than a metric list.
 * Opening a run is where the numbers are read.
 */
function renderResultDetail(
  evaluation: EvaluationResult,
  nav: EvaluationsNav
): React.JSX.Element {
  return React.createElement(
    DetailDrawer,
    {
      title: evaluation.id,
      badges: outcomeBadge(evaluation),
      subtitle: evaluation.timestamp,
      closeHref: evaluationsListHref(nav.filters, { tab: nav.tab }),
      closeLabel: "Close evaluation detail",
      dataAttributes: { "data-feature": "evaluation-detail" }
    },
    React.createElement(
      DetailGrid,
      { columns: 4 },
      React.createElement(
        DetailValue,
        { key: "role", label: "Target role" },
        evaluation.agentRole
      ),
      React.createElement(
        DetailValue,
        { key: "model", label: "Model" },
        evaluation.model
      ),
      React.createElement(
        DetailValue,
        { key: "prompt", label: "Prompt" },
        evaluation.promptName ?? NO_PROMPT_LABEL
      ),
      React.createElement(
        DetailValue,
        {
          key: "trace",
          label: "Trace span",
          // The span id is a machine value with no natural break, so it keeps
          // the drawer's own monospace treatment rather than the cell treatment
          // the history table uses.
          valueClassName: null
        },
        evaluation.spanId
          ? React.createElement(
              "span",
              { className: MONO_VALUE_CLASS },
              evaluation.spanId
            )
          : React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: NOT_OBSERVED_LABEL,
              title: "This evaluation did not report a trace reference."
            })
      )
    ),
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "h3",
        { className: "text-xs uppercase tracking-wider text-fg-muted" },
        evaluation.metrics.length === 1 ? "Metric" : "Metrics"
      ),
      evaluation.metrics.length === 0
        ? React.createElement(StatusBadge, {
            status: NOT_OBSERVED_STATUS,
            label: NOT_OBSERVED_LABEL,
            title: "This evaluation reported no metrics, so none were observed."
          })
        : React.createElement<DataTableProps<EvaluationMetric>>(DataTable, {
            data: evaluation.metrics,
            keyExtractor: (metric) => metric.name,
            emptyMessage: "No metrics were observed for this evaluation.",
            columns: [
              {
                id: "metric",
                header: "Metric",
                weight: 260,
                align: "tokens",
                cell: (metric: EvaluationMetric) => metric.name
              },
              {
                id: "value",
                header: "Value",
                weight: 140,
                align: "tokens",
                cell: (metric: EvaluationMetric) => String(metric.value)
              },
              {
                id: "verdict",
                header: "Verdict",
                weight: 150,
                cell: (metric: EvaluationMetric) =>
                  React.createElement(StatusBadge, {
                    ...verdictOf(metric.pass)
                  })
              }
            ]
          })
    )
  );
}

/** Outcome counts for one group of runs, used by both comparison tables. */
interface OutcomeTally {
  readonly runs: number;
  readonly passed: number;
  readonly failed: number;
  readonly notObserved: number;
}

/**
 * One collator for every comparison order.
 *
 * `localeCompare` builds an `Intl.Collator` on every call, and this table sorts
 * once per group per render; hoisting it keeps the ordering identical and the
 * cost off the render path.
 */
const COMPARISON_COLLATOR = new Intl.Collator("en");

const EMPTY_TALLY: OutcomeTally = {
  runs: 0,
  passed: 0,
  failed: 0,
  notObserved: 0
};

function tallyBy(
  evaluations: readonly EvaluationResult[],
  key: (evaluation: EvaluationResult) => string
): ReadonlyMap<string, OutcomeTally> {
  const tallies = new Map<string, OutcomeTally>();
  for (const evaluation of evaluations) {
    const name = key(evaluation);
    const current = tallies.get(name) ?? EMPTY_TALLY;
    tallies.set(name, {
      runs: current.runs + 1,
      passed: current.passed + (evaluation.passed === true ? 1 : 0),
      failed: current.failed + (evaluation.passed === false ? 1 : 0),
      notObserved:
        current.notObserved + (hasExplicitVerdict(evaluation) ? 0 : 1)
    });
  }
  return tallies;
}

/**
 * Pass rate over the runs whose verdict was actually supplied.
 *
 * The denominator is the explicit verdicts and never the row count. A store
 * where most runs report no verdict would otherwise score a single pass as 100%,
 * which is the score-threshold inference the target state rules out.
 */
function passRate(tally: OutcomeTally): string {
  const observed = tally.passed + tally.failed;
  return observed === 0
    ? NOT_OBSERVED_LABEL
    : `${Math.round((tally.passed / observed) * 100)}%`;
}

function comparisonColumns(
  label: string
): readonly ColumnDef<readonly [string, OutcomeTally]>[] {
  return [
    {
      id: "target",
      header: label,
      weight: 260,
      align: "tokens",
      cell: ([name]) =>
        React.createElement("span", { className: MONO_ID_CLASS }, name)
    },
    {
      id: "runs",
      header: "Runs",
      weight: 90,
      cell: ([, tally]) =>
        React.createElement("span", { className: MONO_VALUE_CLASS }, tally.runs)
    },
    {
      id: "passed",
      header: "Passed",
      weight: 100,
      cell: ([, tally]) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          tally.passed
        )
    },
    {
      id: "failed",
      header: "Failed",
      weight: 100,
      cell: ([, tally]) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          tally.failed
        )
    },
    {
      id: "not-observed",
      header: "Not observed",
      weight: 150,
      // A zero here is not an achievement, so it is a plain count rather than a
      // success badge. Colouring `0` green read as "this target is healthy" on a
      // row whose only other reading was a pass rate -- a claim about quality
      // that the source never made. Only a non-zero count gets the badge, and
      // then it is the marker the column exists for.
      cell: ([, tally]) =>
        tally.notObserved === 0
          ? React.createElement("span", { className: MONO_VALUE_CLASS }, "0")
          : React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: String(tally.notObserved)
            })
    },
    {
      id: "pass-rate",
      header: "Pass rate",
      weight: 120,
      cell: ([, tally]) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          passRate(tally)
        )
    }
  ];
}

function renderComparison(
  title: string,
  description: string,
  label: string,
  evaluations: readonly EvaluationResult[],
  key: (evaluation: EvaluationResult) => string
): React.JSX.Element {
  const rows = [...tallyBy(evaluations, key)].sort(([left], [right]) =>
    COMPARISON_COLLATOR.compare(left, right)
  );
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement("h3", { className: SECTION_HEADING_CLASS }, title),
    React.createElement(
      "p",
      { className: "text-xs text-fg-muted" },
      description
    ),
    React.createElement<DataTableProps<readonly [string, OutcomeTally]>>(
      DataTable,
      {
        data: rows,
        columns: comparisonColumns(label),
        keyExtractor: ([name]) => name,
        emptyMessage: `No evaluation targets were observed in this window, so there is nothing to compare by ${label.toLowerCase()}.`
      }
    )
  );
}

function filterSelect(
  name: "outcome" | "role" | "model" | "prompt",
  label: string,
  options: readonly { readonly value: string; readonly label: string }[],
  selected: string
): React.JSX.Element {
  return React.createElement(SelectField, {
    id: `evaluations-filter-${name}`,
    name,
    label,
    defaultValue: selected === "" ? "" : selected,
    options,
    testId: `evaluations-${name}`
  });
}

export function EvaluationsView({
  evaluations,
  availableCount = evaluations.length,
  filters,
  filterOptions,
  tab = "results",
  selection = null,
  traceLookup = null
}: EvaluationsViewProps): React.JSX.Element {
  const passed = evaluations.filter(
    (evaluation) => evaluation.passed === true
  ).length;
  const failed = evaluations.filter(
    (evaluation) => evaluation.passed === false
  ).length;
  const notObserved = evaluations.filter(
    (evaluation) => !hasExplicitVerdict(evaluation)
  ).length;
  const observedOutcomes = passed + failed;
  const narrowed = hasActiveFilters(filters);
  const nav: EvaluationsNav = { filters, tab };
  const selectedEvaluation =
    selection === null
      ? null
      : (evaluations.find((evaluation) => evaluation.id === selection) ?? null);

  const columns: ColumnDef<EvaluationResult>[] = [
    {
      id: "target",
      header: "Target",
      // The role and the prompt are one identity -- what the run evaluated -- so
      // they share a column rather than each taking ~120px of a 864px budget
      // that seven columns cannot divide without crushing a badge. Merging them
      // is what lets Metrics hold a whole metric chip on one line instead of
      // breaking every name mid-token.
      //
      // `tokens`, not `truncate`: a role is an identifier, and cutting
      // `browser-tester` to `browser-…` leaves a prefix that names no role at
      // all. Wrapping breaks it at its own hyphens instead, so every line is a
      // true substring and the whole name is always on screen.
      weight: 132,
      align: "tokens",
      cell: (evaluation) =>
        React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          React.createElement(
            "a",
            {
              href: evaluationResultHref(filters, evaluation.id, tab),
              className:
                "font-mono text-xs font-semibold text-accent underline-offset-4 hover:underline",
              "data-evaluation-result-id": evaluation.id
            },
            evaluation.agentRole
          ),
          // The prompt is the axis the Prompts resource links in on and the axis
          // the filter narrows by, so a history that cannot show it makes both of
          // those links land on a row set the operator cannot reason about.
          evaluation.promptName === undefined
            ? React.createElement(StatusBadge, {
                status: NOT_OBSERVED_STATUS,
                label: NO_PROMPT_LABEL,
                title: "This evaluation did not report a prompt."
              })
            : React.createElement(
                "span",
                {
                  className: `${MUTED_META_CLASS} break-words`,
                  "data-evaluation-prompt": true
                },
                evaluation.promptName
              )
        )
    },
    {
      id: "model",
      header: "Model",
      weight: 130,
      align: "tokens",
      cell: (evaluation) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          evaluation.model
        )
    },
    {
      id: "metrics",
      header: "Metrics",
      // The widest column, and deliberately so. The metric list is the reason
      // the row exists, and every chip carries its own verdict; a budget that
      // fits half a chip reports two halves of one reading rather than one
      // reading. It wraps between chips rather than between characters.
      weight: 200,
      align: "tokens",
      cell: metricCell
    },
    {
      id: "outcome",
      header: "Outcome",
      weight: 144,
      cell: outcomeBadge
    },
    {
      id: "trace",
      header: "Trace",
      weight: 144,
      cell: (evaluation) => traceReference(evaluation, nav)
    },
    {
      id: "timestamp",
      header: "Run Time",
      weight: 104,
      align: "tokens",
      cell: runTimeCell
    }
  ];

  const emptyMessage = narrowed
    ? "No evaluation results match these filters. Clear or widen them to see the rest of the retained history."
    : "No evaluation results are present in the available history.";

  return React.createElement(
    PageBody,
    {
      feature: "evaluations",
      attributes: {
        "data-evaluation-pass-rate-observed":
          observedOutcomes > 0 ? "true" : "false",
        "data-evaluations-filtered": narrowed ? "true" : "false"
      }
    },
    React.createElement(
      FilterBar,
      {
        label: "Evaluation filters",
        action: "/evaluations",
        submitTestId: "evaluations-apply",
        summary: narrowed
          ? `${evaluations.length} of ${availableCount} retained results`
          : `${availableCount} retained results`
      },
      filterSelect(
        "outcome",
        "Outcome:",
        Object.entries(OUTCOME_FILTER_LABELS).map(([value, text]) => ({
          value,
          label: text
        })),
        filters.outcome === "all" ? "" : filters.outcome
      ),
      filterSelect(
        "role",
        "Target role:",
        [
          { value: "", label: "All roles" },
          ...filterOptions.roles.map((role) => ({ value: role, label: role }))
        ],
        filters.role
      ),
      filterSelect(
        "model",
        "Model:",
        [
          { value: "", label: "All models" },
          ...filterOptions.models.map((model) => ({
            value: model,
            label: model
          }))
        ],
        filters.model
      ),
      filterSelect(
        "prompt",
        "Prompt:",
        [
          { value: "", label: "All prompts" },
          ...filterOptions.prompts.map((prompt) => ({
            value: prompt,
            label: prompt
          }))
        ],
        filters.prompt
      )
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(TabNav, {
        navLabel: "Evaluations sections",
        basePath: "/evaluations",
        tabs: EVALUATIONS_TABS,
        activeTabId: tab,
        // Filters travel with the tab, so narrowing the history does not throw
        // the operator out of the comparison they were reading.
        hrefFor: (tabId: string) =>
          evaluationsTabHref(filters, tabId as EvaluationsTabId)
      }),
      narrowed
        ? React.createElement(
            "a",
            {
              href: evaluationsUnfilteredHref(),
              className:
                "text-xs text-accent underline-offset-4 hover:underline",
              "data-evaluations-clear": "true"
            },
            "Clear filters"
          )
        : null
    ),
    React.createElement(
      StatGrid,
      { columns: 5 },
      React.createElement(StatCard, {
        title: "Total Evaluations",
        value: evaluations.length
      }),
      React.createElement(StatCard, { title: "Passed", value: passed }),
      React.createElement(StatCard, { title: "Failed", value: failed }),
      React.createElement(StatCard, {
        title: NOT_OBSERVED_LABEL,
        value: notObserved
      }),
      React.createElement(StatCard, {
        title: "Pass Rate",
        value:
          observedOutcomes > 0
            ? `${Math.round((passed / observedOutcomes) * 100)}%`
            : NOT_OBSERVED_LABEL,
        subtitle: `${observedOutcomes} of ${evaluations.length} with explicit verdicts`
      })
    ),
    selectedEvaluation === null
      ? null
      : renderResultDetail(selectedEvaluation, nav),
    traceLookup ? renderTraceLookup(traceLookup, nav) : null,
    tab === "results"
      ? React.createElement(
          "div",
          null,
          React.createElement(
            "h2",
            { className: SECTION_HEADING_CLASS },
            "Evaluation history"
          ),
          React.createElement<DataTableProps<EvaluationResult>>(DataTable, {
            data: evaluations,
            columns,
            keyExtractor: (evaluation: EvaluationResult) => evaluation.id,
            emptyMessage
          })
        )
      : React.createElement(
          "div",
          { className: "flex flex-col gap-6" },
          renderComparison(
            "Outcomes by target role",
            "Every retained run grouped by the agent role it evaluated. Pass rate is computed over the runs that supplied an explicit verdict.",
            "Target role",
            evaluations,
            (evaluation) => evaluation.agentRole
          ),
          renderComparison(
            "Outcomes by model",
            "The same runs grouped by the model that produced them, for comparing targets rather than roles.",
            "Model",
            evaluations,
            (evaluation) => evaluation.model
          )
        )
  );
}
