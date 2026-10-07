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
  FIELD_CONTROL_CLASS,
  FIELD_GROUP_CLASS
} from "../../components/ui/field-classes.ts";
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
  clampEvaluationsPage,
  evaluationResultHref,
  EVALUATIONS_PAGE_SIZE,
  EVALUATIONS_TABS,
  type EvaluationsFilterOptions,
  type EvaluationsFilters,
  evaluationsListHref,
  evaluationsPageCount,
  evaluationsPageHref,
  evaluationsPageRows,
  evaluationsTabHref,
  type EvaluationsTabId,
  evaluationsUnfilteredHref,
  evaluationTraceHref,
  hasActiveFilters,
  hasExplicitVerdict,
  OUTCOME_FILTER_LABELS,
  reportedPrompt
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

export interface EvaluationsViewProps {
  /** Already narrowed by `filters`; the page owns the read, the view owns the shape. */
  readonly evaluations: readonly EvaluationResult[];
  /** Rows in the fetched window before filtering, for the filter bar's count. */
  readonly availableCount?: number | undefined;
  /**
   * Every result the source holds, which is more than `availableCount` whenever
   * the read was capped.
   *
   * The page states this rather than letting the window describe itself: a
   * filter summary that counts a capped window as the whole history tells an
   * operator a filtered set is everything that exists.
   */
  readonly totalCount?: number | undefined;
  /** Whether the read returned a bounded window rather than the whole table. */
  readonly truncated?: boolean | undefined;
  readonly filters: EvaluationsFilters;
  readonly filterOptions: EvaluationsFilterOptions;
  /** Which section is showing. Defaults to the run history. */
  readonly tab?: EvaluationsTabId | undefined;
  /** Page of the narrowed window the history table shows. Defaults to the first. */
  readonly page?: number | undefined;
  /**
   * Runs a time bound could not place, because their run time is not a readable
   * instant.
   *
   * Stated on the page rather than absorbed into the counts. A row that cannot
   * be placed is excluded from the match, and a denominator that quietly lost it
   * would be a pass rate over a population nobody chose.
   */
  readonly unplaceable?: number | undefined;
  /**
   * Runs that report no prompt and matched a prompt filter anyway.
   *
   * The inclusion is deliberate -- a row that named no prompt is not evidence it
   * ran under another one, so dropping it would under-report the history -- but
   * it used to be silent, which put "No prompt" rows under a bar reading
   * "Prompt: release-notes". Stating the count keeps the rule and removes the
   * contradiction.
   */
  readonly promptless?: number | undefined;
  /**
   * Oldest run the bounded read holds, when the operator's window ends before
   * it -- which means the window was never read, not that it is empty.
   *
   * Epoch milliseconds, straight from `unreadWindow`; the page owns the read and
   * this is a fact about it, so the view takes the answer rather than
   * re-deriving it from rows it was never given.
   */
  readonly oldestReadAt?: number | undefined;
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

/** `YYYY-MM-DD`. */
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** `HH:MM:SS`. */
const UTC_CLOCK = /^\d{2}:\d{2}:\d{2}$/u;
/** `Z`, or a signed offset. */
const UTC_OFFSET = /^(?:Z|[+-]\d{2}:\d{2})$/u;
/** The digits of a fractional second, which the clock reading does not include. */
const FRACTION = /^\d+/u;

/**
 * One instant, split into the parts a cell renders: a date, and where the source
 * wrote them, a clock and an offset.
 *
 * Fixed-width checks in sequence rather than one pattern, for two reasons. The
 * shape here *is* fixed-width, so each piece is a trivial test. And a single
 * nested-quantifier regex for it trips `detect-unsafe-regex`, which is a report
 * worth answering rather than suppressing -- so this is the answer.
 *
 * Anything that is not an ISO instant comes back whole, which is the property
 * that matters: a value that cannot be cut into parts is not cut into parts.
 */
function splitInstant(timestamp: string): {
  readonly date: string;
  readonly clock?: string | undefined;
  readonly offset?: string | undefined;
} {
  const date = timestamp.slice(0, 10);
  if (!UTC_DATE.test(date) || timestamp.length === 10)
    return { date: timestamp };
  if (timestamp[10] !== "T") return { date: timestamp };
  const clock = timestamp.slice(11, 19);
  if (!UTC_CLOCK.test(clock)) return { date: timestamp };

  let offset = timestamp.slice(19);
  // A fractional second belongs to the instant, not to the clock reading, so it
  // is skipped rather than rendered as a third number.
  if (offset.startsWith(".")) {
    const digits = offset.slice(1).match(FRACTION);
    if (digits === null) return { date: timestamp };
    offset = offset.slice(1 + digits[0].length);
  }
  return offset === "" || UTC_OFFSET.test(offset)
    ? { date, clock, offset }
    : { date: timestamp };
}

/**
 * A timestamp, split so it can break between its parts, and never stamped with
 * an offset it did not read.
 *
 * Both tables on this resource render a timestamp, and they did it two ways: the
 * history table matched a regex and the trace table sliced the raw string, and
 * both appended a `Z` the source never had to contain. A span stamped
 * `2026-10-05T09:31:00+02:00` rendered as `09:31:00Z` -- the same clock reading
 * under a zone label it was not in, which is a claim about the data, not about
 * formatting. The wire only requires a timestamp to *parse*: the trace validator
 * checks `Date.parse`, not the shape, and the evaluation validator checks only
 * that it is a string, so a `+02:00` offset, a date-only value, and an
 * unreadable one all reach the view intact.
 *
 * The source's own offset is kept, then: `Z` stays `Z`, `+02:00` stays
 * `+02:00`, a value with no offset shows none, and a value that is not an ISO
 * instant is shown whole.
 *
 * Splitting is what makes it fit. The raw string is 24 characters with no break
 * opportunity, so a column holding one either truncates or pushes every other
 * column out; the date and the clock as two items in a wrapping row give the
 * column a natural 10-character budget and let the row fold at a narrow width
 * instead of losing the seconds. The full value stays on `title`, and the
 * machine-readable form stays in `dateTime`.
 *
 * `min-w-0` on both parts is what keeps a narrow column from overflowing. A flex
 * item defaults to `min-width: auto`, so `2026-10-05` refuses to shrink below
 * its own width and the cell paints straight through the table's right edge --
 * outside the scroll container that was supposed to contain it. The trace table
 * did not have it, which is the other half of why this is one function now.
 */
function timestampCell(timestamp: string): React.JSX.Element {
  const { date, clock, offset } = splitInstant(timestamp);
  return React.createElement(
    "span",
    {
      className: "flex flex-wrap items-baseline gap-x-1.5",
      title: timestamp
    },
    React.createElement(
      "time",
      {
        dateTime: timestamp,
        className: `${MONO_META_CLASS} min-w-0 break-words`
      },
      date
    ),
    clock === undefined
      ? null
      : React.createElement(
          "span",
          { className: `${MONO_META_CLASS} min-w-0 break-words` },
          `${clock}${offset ?? ""}`
        )
  );
}

/** The value a prompt-less run reports instead of naming a prompt. */
const NO_PROMPT_LABEL = "No prompt";

/**
 * Where a link on this page should land.
 *
 * The filters, the open tab, and the open page travel together, so every link
 * built below carries all three. Passing them separately is how a trace link
 * came to preserve the narrowing but drop the tab, landing the operator on the
 * results page after they had opened a comparison -- and how closing a run's
 * drawer would have thrown away the page of the history it was opened from.
 */
interface EvaluationsNav {
  readonly filters: EvaluationsFilters;
  readonly tab: EvaluationsTabId;
  readonly page: number;
}

/** The list for the current state: same filters, same tab, same page. */
function navListHref(nav: EvaluationsNav): string {
  return evaluationsListHref(nav.filters, { tab: nav.tab, page: nav.page });
}

/**
 * What a row's trace reference actually is.
 *
 * Three answers, decided once, because two surfaces render this field and they
 * had drifted into answering different questions: the history table checked
 * whether the value was a span id, and the run drawer did not check at all --
 * so the drawer showed a malformed reference as a real one, on the same run the
 * table beside it labelled "Invalid span". A malformed source must not read as a
 * valid one, and the drawer's title text is not an exception.
 */
type EvaluationTraceReference =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reported: string }
  | { readonly kind: "openable"; readonly spanId: string };

function traceReferenceOf(
  evaluation: EvaluationResult
): EvaluationTraceReference {
  if (!evaluation.spanId) return { kind: "none" };
  if (!isOpenTelemetrySpanId(evaluation.spanId)) {
    return { kind: "invalid", reported: evaluation.spanId };
  }
  return { kind: "openable", spanId: evaluation.spanId };
}

function traceReference(
  evaluation: EvaluationResult,
  nav: EvaluationsNav
): React.ReactNode {
  const reference = traceReferenceOf(evaluation);
  if (reference.kind === "none") {
    return React.createElement(StatusBadge, {
      status: NOT_OBSERVED_STATUS,
      label: NOT_OBSERVED_LABEL,
      title: "This evaluation did not report a trace reference."
    });
  }
  if (reference.kind === "invalid") {
    return React.createElement(StatusBadge, {
      status: "invalid",
      label: "Invalid span",
      title: `The reported trace reference is not a valid OpenTelemetry span id: ${reference.reported}`
    });
  }
  return React.createElement(
    "a",
    {
      href: evaluationTraceHref(nav.filters, reference.spanId, nav.tab),
      className:
        "font-mono text-xs font-medium text-accent underline-offset-4 hover:underline",
      "aria-label": `View trace for evaluation ${evaluation.id}`,
      "data-evaluation-trace-span-id": reference.spanId
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
      // Sized for the longest honest clock reading, which is a `+HH:MM` offset
      // and not the nine characters of a bare `Z`. At 130 this column broke
      // `11:48:00+02:00` across two lines as `+02:0` and `0`, which is a
      // mid-token break of the very value the column exists to show.
      weight: 150,
      align: "tokens",
      cell: (span) => timestampCell(span.timestamp)
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

/**
 * The run a link asked for, and the page could not show.
 *
 * The trace selection above has five named states for every way a lookup can
 * come back empty; the run selection had none, and a `?result=` that resolved to
 * nothing rendered the same page as no selection at all. That is a link silently
 * doing nothing, in a table whose whole job is to say what each row is -- and it
 * has three ordinary causes here, each of which the view can name rather than
 * leave the operator to guess: a filter excluded the run, the bounded read never
 * fetched it, or the retained history holds no such id.
 *
 * The lookup is over the *narrowed* window, so a filter is the commonest cause
 * by far: a bookmarked run plus a filter that excludes it used to render an
 * ordinary-looking list, as if the run had never been asked for. The way out is
 * one click, and the callout offers it.
 */
function renderMissingResult(
  selection: string,
  resultCounts: ResultCounts
): React.JSX.Element {
  const reasons: string[] = [];
  if (resultCounts.narrowed) {
    reasons.push("The filters in this view exclude it.");
  }
  if (resultCounts.truncated) {
    reasons.push(
      `The read holds the most recent ${resultCounts.window} of ${resultCounts.total} retained results, so an older run is not here either.`
    );
  }
  if (reasons.length === 0) {
    reasons.push("The retained history holds no run with that id.");
  }

  return React.createElement(
    "div",
    {
      role: "alert",
      className: CALLOUT_WARNING_CLASS,
      "data-feature": "evaluation-detail",
      "data-detail-state": "not-found",
      "data-evaluation-missing-id": selection
    },
    React.createElement(
      "p",
      null,
      `Run ${selection} is not in this view.`,
      " ",
      reasons.join(" ")
    ),
    resultCounts.narrowed
      ? React.createElement(
          "a",
          {
            href: evaluationsUnfilteredHref(),
            className: "text-xs text-accent underline-offset-4 hover:underline",
            "data-evaluations-clear": "true"
          },
          "Clear the filters and look for it in the whole retained history"
        )
      : null
  );
}

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
          href: navListHref(nav),
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
 * The drawer's trace value, which is the same three answers as the table's --
 * and now the same answers, not merely the same three.
 *
 * It used to be plain text for any reported span, valid or not, while the table
 * beside it linked the valid ones and labelled the malformed ones "Invalid
 * span". So opening a run to read it either offered no way onward to its trace,
 * or presented a value the page had already decided is not a span id as though
 * it were one. The decision belongs to `traceReferenceOf`; only the typography
 * is the drawer's own.
 */
function drawerTraceValue(
  evaluation: EvaluationResult,
  nav: EvaluationsNav
): React.ReactNode {
  const reference = traceReferenceOf(evaluation);
  if (reference.kind === "none") {
    return React.createElement(StatusBadge, {
      status: NOT_OBSERVED_STATUS,
      label: NOT_OBSERVED_LABEL,
      title: "This evaluation did not report a trace reference."
    });
  }
  if (reference.kind === "invalid") {
    return React.createElement(StatusBadge, {
      status: "invalid",
      label: "Invalid span",
      title: `The reported trace reference is not a valid OpenTelemetry span id: ${reference.reported}`
    });
  }
  return React.createElement(
    "a",
    {
      href: evaluationTraceHref(nav.filters, reference.spanId, nav.tab),
      className: `${MONO_VALUE_CLASS} text-accent underline-offset-4 hover:underline`,
      "aria-label": `View trace for evaluation ${evaluation.id}`,
      "data-evaluation-trace-span-id": reference.spanId
    },
    reference.spanId
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
      closeHref: navListHref(nav),
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
        reportedPrompt(evaluation) ?? NO_PROMPT_LABEL
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
        drawerTraceValue(evaluation, nav)
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

/**
 * One run folded into a set of counts.
 *
 * The single place a verdict becomes a number. The stat cards and the comparison
 * tables used to count separately -- the cards with three `.filter()` passes, the
 * tables with this arithmetic -- and the two were free to drift, which is how a
 * page could show a pass rate over one population and a Failed count over
 * another.
 */
function addRun(
  counts: OutcomeTally,
  evaluation: EvaluationResult
): OutcomeTally {
  return {
    runs: counts.runs + 1,
    passed: counts.passed + (evaluation.passed === true ? 1 : 0),
    failed: counts.failed + (evaluation.passed === false ? 1 : 0),
    notObserved: counts.notObserved + (hasExplicitVerdict(evaluation) ? 0 : 1)
  };
}

/** The outcome counts for a set of runs, in one pass. */
function tallyOutcomes(evaluations: readonly EvaluationResult[]): OutcomeTally {
  let counts = EMPTY_TALLY;
  for (const evaluation of evaluations) {
    counts = addRun(counts, evaluation);
  }
  return counts;
}

function tallyBy(
  evaluations: readonly EvaluationResult[],
  key: (evaluation: EvaluationResult) => string
): ReadonlyMap<string, OutcomeTally> {
  const tallies = new Map<string, OutcomeTally>();
  for (const evaluation of evaluations) {
    const name = key(evaluation);
    tallies.set(name, addRun(tallies.get(name) ?? EMPTY_TALLY, evaluation));
  }
  return tallies;
}

/** The runs whose verdict the source actually supplied. */
function observedVerdicts(counts: OutcomeTally): number {
  return counts.passed + counts.failed;
}

/**
 * Pass rate over the runs whose verdict was actually supplied.
 *
 * The denominator is the explicit verdicts and never the row count. A store
 * where most runs report no verdict would otherwise score a single pass as 100%,
 * which is the score-threshold inference the target state rules out.
 */
function passRate(counts: OutcomeTally): string {
  const observed = observedVerdicts(counts);
  return observed === 0
    ? NOT_OBSERVED_LABEL
    : `${Math.round((counts.passed / observed) * 100)}%`;
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
      cell: ([, counts]) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          counts.runs
        )
    },
    {
      id: "passed",
      header: "Passed",
      weight: 100,
      cell: ([, counts]) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          counts.passed
        )
    },
    {
      id: "failed",
      header: "Failed",
      weight: 100,
      cell: ([, counts]) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          counts.failed
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
      cell: ([, counts]) =>
        counts.notObserved === 0
          ? React.createElement("span", { className: MONO_VALUE_CLASS }, "0")
          : React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: String(counts.notObserved)
            })
    },
    {
      id: "pass-rate",
      header: "Pass rate",
      weight: 120,
      cell: ([, counts]) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          passRate(counts)
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
        emptyMessage: `No evaluation targets were observed in this view, so there is nothing to compare by ${label.toLowerCase()}.`
      }
    )
  );
}

/**
 * Which slice of the narrowed window the history table is showing.
 *
 * Rendered only under the history tab, and that is the contract rather than an
 * omission: comparisons fold every row in the window into one line per group, so
 * there are a handful of lines to show and none to page through. The `tab` still
 * travels with every link here because the one bug this resource had twice --
 * a link that preserved the narrowing and dropped the section, or vice versa --
 * is exactly the one a pager that assumed its tab would invite.
 *
 * The page is a plain link, so paging needs no JavaScript and the current page
 * is an address. Previous/next render as disabled-looking spans rather than
 * disappearing so the row does not change width as the operator reaches either
 * end of the window -- a control that appears and disappears is a control that
 * moves the thing you are aiming at.
 */
function renderPager(
  filters: EvaluationsFilters,
  tab: EvaluationsTabId,
  page: number,
  totalRows: number
): React.JSX.Element | null {
  const pageCount = evaluationsPageCount(totalRows);
  const current = clampEvaluationsPage(page, totalRows);
  const firstRow = (current - 1) * EVALUATIONS_PAGE_SIZE + 1;
  const lastRow = Math.min(current * EVALUATIONS_PAGE_SIZE, totalRows);

  const step = (
    target: number,
    label: string,
    enabled: boolean
  ): React.JSX.Element =>
    React.createElement(
      enabled ? "a" : "span",
      {
        // `aria-disabled`, never `aria-hidden`. A hidden step leaves the
        // accessibility tree, so a screen-reader user is offered a Next button
        // that does nothing and no Previous at all, rather than a control they
        // can hear, recognise as unavailable, and skip. The step's own name is
        // its accessible name: the adjacent `Page 2 of 3` already states the
        // position, and repeating it produced "Previous, page 0" at page one.
        "aria-label": label,
        ...(enabled
          ? {
              href: evaluationsPageHref(filters, target, tab),
              className:
                "rounded border border-border px-3 py-1 text-xs text-accent underline-offset-4 hover:underline",
              "data-evaluations-page-step": target
            }
          : {
              className:
                "rounded border border-border px-3 py-1 text-xs text-fg-muted opacity-50",
              "aria-disabled": "true",
              "data-evaluations-page-step": target
            })
      },
      label
    );

  return React.createElement(
    "nav",
    {
      "aria-label": "Evaluation history pages",
      className: "flex flex-wrap items-center justify-between gap-3",
      "data-feature": "evaluations-pager",
      "data-evaluations-page": String(current),
      "data-evaluations-page-count": String(pageCount)
    },
    React.createElement(
      "p",
      {
        className: "text-xs text-fg-muted",
        "data-evaluations-page-range": "true"
      },
      // The range is over the rows the filters selected, which is not the rows
      // on screen and not the rows the store holds. The filter bar's sentence
      // above states how large that window is; this states which part of it the
      // table is on, so neither number has to be inferred from the other.
      //
      // An empty view has no first row, and the arithmetic below is right for a
      // non-empty window while producing "Rows 1-0 of 0" for an empty one --
      // which reads as a broken range rather than as the absence it is. So the
      // empty case is said rather than computed.
      totalRows === 0
        ? "No results in this view"
        : `Rows ${firstRow}–${lastRow} of ${totalRows} in this view`
    ),
    pageCount > 1
      ? React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          step(current - 1, "Previous", current > 1),
          React.createElement(
            "span",
            {
              className: "text-xs text-fg-muted",
              "data-evaluations-page-label": "true"
            },
            `Page ${current} of ${pageCount}`
          ),
          step(current + 1, "Next", current < pageCount)
        )
      : null
  );
}

/**
 * One end of the run-time window.
 *
 * The label says UTC because that is what the bound is: a day is midnight UTC to
 * midnight UTC, and "Friday" here means the UTC Friday, which is not the
 * operator's Friday everywhere. `/usage`'s custom range already phrases it this
 * way, and two surfaces that both narrow time and disagree about the timezone
 * would be worse than one that says so.
 *
 * `min`/`max` cross-link the two controls so a browser rejects an inverted range
 * rather than the operator submitting one and getting an empty table. The
 * server-side parse re-checks regardless: a constraint on an input is a
 * convenience, not a rule.
 */
function runTimeBound(
  name: "from" | "until",
  label: string,
  value: string,
  other: string
): React.JSX.Element {
  return React.createElement(
    "label",
    { className: FIELD_GROUP_CLASS },
    React.createElement("span", null, `${label} (UTC):`),
    React.createElement("input", {
      type: "date",
      name,
      defaultValue: value,
      ...(name === "from"
        ? { max: other || undefined }
        : { min: other || undefined }),
      "aria-label": `Runs ${name === "from" ? "from" : "up to"} this UTC date`,
      className: FIELD_CONTROL_CLASS,
      "data-evaluations-bound": name
    })
  );
}

/** The three things a view can hold back, as one value rather than a tuple. */
interface ViewCaveats {
  readonly unplaceable: number;
  readonly promptless: number;
  /** Oldest run the bounded read holds, when the window ends before it. */
  readonly oldestReadAt?: number | undefined;
  readonly readRows: number;
  readonly storeTotal: number;
}

/**
 * What this view could not include, said next to the controls that decided it.
 *
 * Three ways a filter can fail to show what the operator asked for, and all
 * three are stated rather than absorbed. A run the window cannot place is
 * excluded from every count. A run that reports no prompt matches any prompt
 * filter, because a row that named no prompt is not evidence that it ran under
 * some other one and dropping it would under-report the history -- which used
 * to be invisible, putting rows reading "No prompt" directly under a bar reading
 * "Prompt: release-notes", a contradiction in one viewport. And a window older
 * than the bounded read was never read at all, which used to render as an empty
 * history against a store holding five thousand rows.
 *
 * Grouped immediately under the filter bar rather than beside the counts,
 * because each sentence explains a control the operator just used, and a caveat
 * about a filter belongs where the filter is.
 */
function renderViewCaveats({
  unplaceable,
  promptless,
  oldestReadAt,
  readRows,
  storeTotal
}: ViewCaveats): React.JSX.Element | null {
  const lines: string[] = [];
  if (unplaceable > 0) {
    lines.push(
      `${unplaceable} ${unplaceable === 1 ? "run reports" : "runs report"} no readable run time and cannot be placed in this time window`
    );
  }
  if (promptless > 0) {
    lines.push(
      `${promptless} ${promptless === 1 ? "run reports" : "runs report"} no prompt and therefore match any prompt filter`
    );
  }
  if (oldestReadAt !== undefined) {
    lines.push(
      `runs before ${runTimeText(oldestReadAt)} were never read — the read holds the most recent ${readRows} of ${storeTotal} retained results — so this view is empty because it was not read, not because nothing ran`
    );
  }
  if (lines.length === 0) return null;
  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-1 text-xs text-fg-secondary",
      role: "status",
      "data-evaluations-caveats": "true",
      ...(unplaceable > 0
        ? { "data-evaluations-unplaceable": String(unplaceable) }
        : {}),
      ...(promptless > 0
        ? { "data-evaluations-promptless": String(promptless) }
        : {}),
      ...(oldestReadAt === undefined
        ? {}
        : { "data-evaluations-unread-window": String(oldestReadAt) })
    },
    ...lines.map((line) => React.createElement("p", { key: line }, `${line}.`))
  );
}

/**
 * One instant, in the same shape the Run Time column renders it.
 *
 * A caveat quoting a timestamp in a different format from the column it is
 * explaining is one more thing to translate before the two can be compared, and
 * the comparison is the whole reason the timestamp is there.
 */
function runTimeText(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
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

/**
 * How much of the history is on screen.
 *
 * The read is capped and the filters narrow further, so four numbers can differ:
 * how many rows are shown, how many the window held, how many the source has,
 * and whether either filter or cap is in play. Both the filter bar's sentence and
 * the stat card are built from this one value, because the previous wording --
 * "N retained results" -- used the window and said nothing about the rest, which
 * made a capped read describe itself as the complete history.
 */
interface ResultCounts {
  readonly shown: number;
  readonly window: number;
  readonly total: number;
  readonly narrowed: boolean;
  readonly truncated: boolean;
}

function resultSummary({
  shown,
  window,
  total,
  narrowed,
  truncated
}: ResultCounts): string {
  if (!truncated) {
    return narrowed
      ? `${shown} of ${total} retained results`
      : `${total} retained results`;
  }
  // Narrowing must not drop the size of the store. "3 of 6 in the most recent 6"
  // reads as "3 of everything" to anyone who did not already have the
  // unfiltered line open beside it, which is exactly the moment the number
  // matters -- the filter matched a handful of rows and the operator is deciding
  // whether that is a small problem or a window too small to see the problem.
  return narrowed
    ? `${shown} of the most recent ${window} · ${total} retained`
    : `Most recent ${window} of ${total} retained results`;
}

/**
 * The stat card for the same numbers, as a value rather than a sentence.
 *
 * This card used to read `evaluations.length` under the title "Total
 * Evaluations", which is the lie the filter bar was just rewritten to stop
 * telling: filtered, it reported three as the total; capped, it reported the
 * window as the whole table. The value is now the store's own size and the
 * subtitle states the relationship to what is on screen, so the card and the
 * sentence above it cannot disagree about either number.
 *
 * The subtitle counts rows, never pages. "334 of the most recent 1000 shown"
 * became ambiguous the moment the table started showing 50 rows at a time: 50
 * are on the table, 334 are in the view, and "shown" pointed at both. It now
 * says "in this view", the same phrase the pager uses for its own range, so one
 * word names one population across the page.
 */
function retainedResults({
  shown,
  window,
  total,
  narrowed,
  truncated
}: ResultCounts): {
  readonly value: number;
  readonly subtitle: string | null;
} {
  if (narrowed && truncated) {
    return {
      value: total,
      subtitle: `${shown} of the most recent ${window} in this view`
    };
  }
  if (narrowed) {
    return {
      value: total,
      subtitle: `${shown} of ${total} match these filters`
    };
  }
  return truncated
    ? { value: total, subtitle: `the most recent ${window} in this view` }
    : { value: total, subtitle: null };
}

export function EvaluationsView({
  evaluations,
  availableCount = evaluations.length,
  totalCount,
  truncated = false,
  filters,
  filterOptions,
  tab = "results",
  page = 1,
  unplaceable = 0,
  promptless = 0,
  oldestReadAt,
  selection = null,
  traceLookup = null
}: EvaluationsViewProps): React.JSX.Element {
  const counts = tallyOutcomes(evaluations);
  const observedOutcomes = observedVerdicts(counts);
  const narrowed = hasActiveFilters(filters);
  const resultCounts: ResultCounts = {
    shown: evaluations.length,
    window: availableCount,
    total: totalCount ?? availableCount,
    narrowed,
    truncated
  };
  const retained = retainedResults(resultCounts);
  // Which rows the two comparison tables are talking about, named the same way
  // the pager and the cards name them, so one page cannot describe its own
  // contents two different ways.
  const comparedRuns = narrowed
    ? "Every run in this view"
    : "Every retained run";
  const nav: EvaluationsNav = { filters, tab, page };
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
          reportedPrompt(evaluation) === undefined
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
                reportedPrompt(evaluation)
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
      cell: (evaluation) => timestampCell(evaluation.timestamp)
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
        "data-evaluations-filtered": narrowed ? "true" : "false",
        "data-evaluations-truncated": truncated ? "true" : "false"
      }
    },
    React.createElement(
      FilterBar,
      {
        label: "Evaluation filters",
        action: "/evaluations",
        submitTestId: "evaluations-apply",
        summary: resultSummary(resultCounts)
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
      ),
      runTimeBound("from", "From", filters.from, filters.until),
      runTimeBound("until", "To", filters.until, filters.from)
    ),
    renderViewCaveats({
      unplaceable,
      promptless,
      oldestReadAt,
      readRows: availableCount,
      storeTotal: totalCount ?? availableCount
    }),
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
        title: "Retained results",
        value: retained.value,
        ...(retained.subtitle === null ? {} : { subtitle: retained.subtitle })
      }),
      React.createElement(StatCard, { title: "Passed", value: counts.passed }),
      React.createElement(StatCard, { title: "Failed", value: counts.failed }),
      React.createElement(StatCard, {
        title: NOT_OBSERVED_LABEL,
        value: counts.notObserved
      }),
      React.createElement(StatCard, {
        title: "Pass Rate",
        value: passRate(counts),
        subtitle: `${observedOutcomes} of ${evaluations.length} with explicit verdicts`
      })
    ),
    selectedEvaluation === null
      ? selection === null
        ? null
        : renderMissingResult(selection, resultCounts)
      : renderResultDetail(selectedEvaluation, nav),
    traceLookup ? renderTraceLookup(traceLookup, nav) : null,
    tab === "results"
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-3" },
          React.createElement(
            "h2",
            { className: SECTION_HEADING_CLASS },
            "Evaluation history"
          ),
          React.createElement<DataTableProps<EvaluationResult>>(DataTable, {
            // The slice, not the window. The table renders every row it is
            // given, and handing it a full read window put a thousand rows and
            // 25,913 nodes into one response -- 2.9MiB of markup for a page that
            // lays out in 8ms, so all of that cost was emitting and parsing rows
            // an operator was never going to scroll past. Every row stays
            // reachable through the pager below.
            data: evaluationsPageRows(evaluations, page),
            columns,
            keyExtractor: (evaluation: EvaluationResult) => evaluation.id,
            emptyMessage
          }),
          renderPager(filters, tab, page, evaluations.length)
        )
      : React.createElement(
          "div",
          { className: "flex flex-col gap-6" },
          renderComparison(
            "Outcomes by target role",
            // "Every retained run" was a claim about the whole store, printed
            // beside a table of whatever the filters selected -- so
            // `?prompt=release-notes` described 35 rows as every run the
            // retained history holds. The set is named by the same rule the
            // pager, the summary and the retained card already use: the view,
            // and "retained" only when nothing has narrowed it.
            `${comparedRuns} grouped by the agent role it evaluated. Pass rate is computed over the runs that supplied an explicit verdict.`,
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
