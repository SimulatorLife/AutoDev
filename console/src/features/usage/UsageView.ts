import {
  USAGE_VARIABLE_IDS,
  type UsageActiveSessions,
  type UsageFilterOptions,
  type UsageFilterSelection,
  type UsageMetricsData,
  type UsageTraceAttempt,
  type UsageTraceDetail,
  type UsageTraceList,
  type UsageTraceSpan
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { BarChart } from "../../components/charts/BarChart.ts";
import { FilterBar } from "../../components/filters/FilterBar.ts";
import { AutoSubmitSelectField } from "../../components/forms/AutoSubmitSelectField.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import {
  PAGE_SECTION_STACK_CLASS,
  PageBody
} from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { gridRowClass, StatGrid } from "../../components/panels/DetailGrid.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { TraceStatus } from "../../components/traces/TraceStatus.ts";
import {
  FIELD_CONTROL_CLASS,
  FIELD_GROUP_CLASS
} from "../../components/ui/field-classes.ts";
import {
  ACTION_LINK_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";

/**
 * Observability Usage view.
 *
 * The Usage dashboard renders only fixed, source-confirmed OpenLIT widgets.
 * Cost is explicitly an estimate from OpenLIT's pricing attribute; missing or
 * malformed observations remain unknown rather than becoming synthetic zeroes.
 *
 * Filter selections are GET form state in the URL. The server page uses that
 * state to query OpenLIT; this component never performs browser-side telemetry
 * requests or infers filter values.
 */

export interface UsageViewProps {
  readonly metrics?: UsageMetricsData | undefined;
  readonly filterOptions?: UsageFilterOptions | undefined;
  readonly traceList?: UsageTraceList | undefined;
  readonly traceLookup?: UsageTraceLookup | undefined;
  readonly selection?: UsageFilterSelection | undefined;
  /**
   * Live Runtime evidence for the `ACTIVE_SESSIONS` scope.
   *
   * `undefined` means the scope could not be read at all — the page renders
   * that as unavailable rather than as an empty scope.
   */
  readonly activeSessions?: UsageActiveSessions | undefined;
}

export type UsageTraceLookup =
  | { readonly kind: "observed"; readonly detail: UsageTraceDetail }
  | {
      readonly kind:
        | "invalid-span-id"
        | "not-found"
        | "unavailable"
        | "not-configured"
        | "unauthorized";
    }
  | { readonly kind: "http-error"; readonly status: number };

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});
const DURATION_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1
});
const COST_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const SUB_DOLLAR_COST_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6
});

export function formatTokenCount(value: number | null): string {
  if (value === null) return NOT_OBSERVED_LABEL;
  return TOKEN_FORMATTER.format(value);
}

export function formatCacheRate(value: number | null): string {
  if (value === null) return NOT_OBSERVED_LABEL;
  return `${value.toFixed(1)}%`;
}

export function formatLatency(value: number | null): string {
  if (value === null) return NOT_OBSERVED_LABEL;
  if (value >= 3_600_000)
    return `${DURATION_FORMATTER.format(value / 3_600_000)} h`;
  if (value >= 60_000)
    return `${DURATION_FORMATTER.format(value / 60_000)} min`;
  if (value >= 1000) return `${DURATION_FORMATTER.format(value / 1000)} s`;
  return `${DURATION_FORMATTER.format(value)} ms`;
}

export function formatCount(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : COUNT_FORMATTER.format(value);
}

export function formatEstimatedCost(value: number | null): string {
  if (value === null) return NOT_OBSERVED_LABEL;
  return (value >= 1 ? COST_FORMATTER : SUB_DOLLAR_COST_FORMATTER).format(
    value
  );
}

function formatLifecycle(
  state: UsageActiveSessions["lifecycle"],
  changedAt: string | null
): string {
  if (state === null) return NOT_OBSERVED_LABEL;
  if (state !== "draining") return "Ready";
  return changedAt === null ? "Draining" : `Draining since ${changedAt}`;
}

/**
 * Render the `ACTIVE_SESSIONS` scope.
 *
 * Every value here comes from the Runtime's live projection. When that read
 * failed, the panel says so and shows no counters at all: rendering the
 * historical widgets instead would leave the previous window's numbers sitting
 * under a heading that promises live sessions, and rendering zeros would report
 * an idle Runtime that was never actually observed.
 */
function renderActiveSessionsScope(
  active: UsageActiveSessions | undefined
): React.JSX.Element {
  if (active === undefined) {
    return React.createElement(
      "div",
      null,
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Active Sessions"
      ),
      React.createElement(
        "div",
        { className: LIST_PANEL_CLASS },
        React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "Live session state is unavailable. The Runtime did not report session evidence, so no count is shown; an unavailable read is not an idle Runtime."
        )
      )
    );
  }

  return React.createElement(
    "div",
    null,
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      "Active Sessions"
    ),
    React.createElement(
      "div",
      { className: PAGE_SECTION_STACK_CLASS },
      React.createElement(
        StatGrid,
        { columns: 4 },
        React.createElement(StatCard, {
          title: "Active Sessions",
          value: formatCount(active.activeSessions),
          subtitle: "Runtime-reported live sessions"
        }),
        React.createElement(StatCard, {
          title: "Active Subagent Threads",
          value: formatCount(active.activeSubagentThreads),
          subtitle: "Runtime-reported live threads"
        }),
        React.createElement(StatCard, {
          title: "In-flight Requests",
          value: formatCount(active.inFlightRequests),
          subtitle: "Runtime-reported provider requests"
        }),
        React.createElement(StatCard, {
          title: "Router Lifecycle",
          value: formatLifecycle(active.lifecycle, active.lifecycleChangedAt),
          subtitle: "Runtime lifecycle state"
        })
      ),
      React.createElement(
        "div",
        { className: LIST_PANEL_CLASS },
        React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          active.perSessionIdentityAvailable
            ? "Per-session detail is reported below."
            : "The Runtime reports a live session count but no per-session identity yet, so no session list is shown. Absence of a list is not an absence of sessions."
        )
      )
    )
  );
}

function formatDimension(value: string): string {
  return value.trim().length === 0 ? "Not attributed" : value;
}

const DEFAULT_SELECTION: UsageFilterSelection = {
  range: "24H",
  values: {}
};

const USAGE_TRACE_DETAIL_FEATURE = "usage-trace-detail";
const USAGE_TRACE_DETAIL_HEADING_ID = "usage-trace-detail-heading";
const USAGE_TRACE_DETAIL_TITLE = "Trace detail";

const UNKNOWN_FILTER_OPTIONS: UsageFilterOptions = {
  workspace: null,
  provider: null,
  model: null,
  agent: null,
  skill: null
};

function renderFilterSelect(
  name: "workspace" | "provider" | "model" | "agent" | "skill",
  label: string,
  options: readonly string[] | null,
  selected: readonly string[]
): React.JSX.Element {
  if (options === null) {
    return React.createElement(
      "div",
      { className: FIELD_GROUP_CLASS },
      React.createElement(SelectField, {
        name: `${name}-unobserved`,
        label: `${label}:`,
        options: [{ value: "", label: NOT_OBSERVED_LABEL }],
        disabled: true,
        // The control is not broken and never will be usable until a telemetry
        // source reports on it, so it says which of the two it is: the filter
        // has no options because the dimension was not observed.
        disabledReason: `No ${label.toLowerCase()} options were observed, so this filter cannot narrow the results. The telemetry source has not reported this dimension.`,
        dataAttributes: { "data-filter-options-observed": "false" }
      }),
      ...selected.map((value) =>
        React.createElement("input", {
          key: value,
          type: "hidden",
          name,
          value
        })
      ),
      React.createElement(
        "span",
        { className: MUTED_META_CLASS },
        selected.length > 0
          ? `Selected: ${selected.join(", ")}`
          : "No selection is active."
      )
    );
  }

  const values = [...new Set([...options, ...selected])];
  const selectedValues = selected.length === 0 ? [""] : selected;
  return React.createElement(
    "div",
    { className: FIELD_GROUP_CLASS },
    React.createElement(SelectField, {
      name,
      label: `${label}:`,
      multiple: true,
      defaultValue: selectedValues,
      options: [
        { value: "", label: "All" },
        ...values.map((value) => ({ value, label: value }))
      ],
      dataAttributes: { "data-filter-options-observed": "true" }
    })
  );
}

/**
 * Render the non-Active-Sessions scope controls: the custom-date disclosure
 * when the scope's own meta line otherwise. Split out of `UsageView` so the
 * scope ternary's internal branching (open state, date bounds) does not add
 * to that function's cognitive complexity.
 */
function renderScopeMeta(
  selection: UsageFilterSelection,
  isActiveSessions: boolean,
  todayUtc: string
): React.JSX.Element {
  if (isActiveSessions) {
    return React.createElement(
      "span",
      { className: MUTED_META_CLASS },
      "Live Runtime state, not a time range."
    );
  }

  return React.createElement(
    "details",
    {
      className:
        "flex min-w-0 flex-wrap items-center gap-2 text-xs text-fg-muted",
      open: selection.range === "CUSTOM"
    },
    React.createElement(
      "summary",
      { className: "cursor-pointer" },
      "Custom dates"
    ),
    React.createElement(
      "label",
      { className: FIELD_GROUP_CLASS },
      React.createElement("span", null, "From (UTC):"),
      React.createElement("input", {
        type: "date",
        name: "startDate",
        defaultValue: selection.customRange?.startDate ?? "",
        max: selection.customRange?.endDate ?? todayUtc,
        "aria-label": "Custom range start date",
        className: FIELD_CONTROL_CLASS
      })
    ),
    React.createElement(
      "label",
      { className: FIELD_GROUP_CLASS },
      React.createElement("span", null, "To (UTC):"),
      React.createElement("input", {
        type: "date",
        name: "endDate",
        defaultValue: selection.customRange?.endDate ?? "",
        min: selection.customRange?.startDate,
        max: todayUtc,
        "aria-label": "Custom range end date",
        className: FIELD_CONTROL_CLASS
      })
    ),
    React.createElement(
      "span",
      null,
      "Custom range accepts up to 90 days; current telemetry retention is about 30 days."
    )
  );
}

/**
 * Render the historical filter controls (workspace/provider/model/agent/skill)
 * or the Active-Sessions explainer in their place. Split out of `UsageView`
 * so the five `renderFilterSelect` call sites do not add to that function's
 * cognitive complexity.
 */
function renderFilterControls(
  isActiveSessions: boolean,
  filterOptions: UsageFilterOptions,
  selectedValues: UsageFilterSelection["values"]
): React.JSX.Element {
  if (isActiveSessions) {
    // These dimensions narrow a historical telemetry query. The Runtime's live
    // projection knows none of them, so offering the controls here would be
    // offering filters that cannot change the reading below them.
    return React.createElement(
      "span",
      { className: MUTED_META_CLASS },
      "Workspace, provider, model, role, and skill filters do not narrow live session state."
    );
  }

  return React.createElement(
    "div",
    { className: "contents" },
    renderFilterSelect(
      "workspace",
      "Workspace",
      filterOptions.workspace,
      selectedValues.workspace ?? []
    ),
    renderFilterSelect(
      "provider",
      "Provider",
      filterOptions.provider,
      selectedValues.provider ?? []
    ),
    renderFilterSelect(
      "model",
      "Requested model",
      filterOptions.model,
      selectedValues.model ?? []
    ),
    renderFilterSelect(
      "agent",
      "Agent / role",
      filterOptions.agent,
      selectedValues.agent ?? []
    ),
    renderFilterSelect(
      "skill",
      "Skill",
      filterOptions.skill,
      selectedValues.skill ?? []
    )
  );
}

function usageHref(selection: UsageFilterSelection, spanId?: string): string {
  const params = new URLSearchParams({ range: selection.range });
  for (const id of USAGE_VARIABLE_IDS) {
    for (const value of selection.values[id] ?? []) params.append(id, value);
  }
  if (selection.customRange) {
    params.set("startDate", selection.customRange.startDate);
    params.set("endDate", selection.customRange.endDate);
  }
  if (spanId) params.set("spanId", spanId);
  return `/usage?${params.toString()}`;
}

function formatTraceTimestamp(timestamp: string): string {
  return new Date(timestamp)
    .toISOString()
    .replace("T", " ")
    .replace("Z", " UTC");
}

function formatTraceDuration(durationNs: number): string {
  return formatLatency(durationNs / 1_000_000);
}

function traceAttemptColumns(
  selection: UsageFilterSelection
): readonly ColumnDef<UsageTraceAttempt>[] {
  return [
    {
      id: "time",
      header: "Time (UTC)",
      weight: 190,
      align: "tokens",
      cell: (attempt) => formatTraceTimestamp(attempt.timestamp)
    },
    {
      id: "provider",
      header: "Provider",
      weight: 120,
      align: "tokens",
      cell: (attempt) => attempt.provider ?? NOT_OBSERVED_LABEL
    },
    {
      id: "model",
      header: "Model",
      weight: 210,
      align: "tokens",
      cell: (attempt) => attempt.model ?? NOT_OBSERVED_LABEL
    },
    {
      id: "role",
      header: "Role",
      weight: 120,
      align: "tokens",
      cell: (attempt) => attempt.role ?? NOT_OBSERVED_LABEL
    },
    {
      id: "duration",
      header: "Duration",
      weight: 100,
      cell: (attempt) => formatTraceDuration(attempt.durationNs)
    },
    {
      id: "status",
      header: "Status",
      weight: 90,
      cell: (attempt) =>
        React.createElement(TraceStatus, { statusCode: attempt.statusCode })
    },
    {
      id: "span",
      header: "Span",
      weight: 150,
      align: "tokens",
      cell: (attempt) =>
        React.createElement(
          "a",
          {
            href: usageHref(selection, attempt.spanId),
            className: `font-mono text-xs ${ACTION_LINK_CLASS}`,
            "aria-label": `Inspect trace for span ${attempt.spanId}`,
            "data-usage-trace-span-id": attempt.spanId
          },
          attempt.spanId
        )
    }
  ];
}

function traceSpanColumns(
  selection: UsageFilterSelection,
  selectedSpanId: string
): readonly ColumnDef<UsageTraceSpan>[] {
  return [
    {
      id: "span",
      header: "Span",
      weight: 150,
      align: "tokens",
      cell: (span) =>
        React.createElement(
          "a",
          {
            href: usageHref(selection, span.spanId),
            className: `font-mono text-xs ${ACTION_LINK_CLASS}`,
            "aria-label": `Inspect span ${span.spanId}${span.spanId === selectedSpanId ? ", selected" : ""}`,
            ...(span.spanId === selectedSpanId
              ? { "aria-current": "true", "data-trace-selected": "true" }
              : {})
          },
          span.spanId
        )
    },
    {
      id: "parent",
      header: "Parent span",
      weight: 150,
      align: "tokens",
      cell: (span) =>
        span.parentSpanId
          ? React.createElement(
              "a",
              {
                href: usageHref(selection, span.parentSpanId),
                className: `font-mono text-xs ${ACTION_LINK_CLASS}`,
                "aria-label": `Inspect parent span ${span.parentSpanId}`
              },
              span.parentSpanId
            )
          : "Root span"
    },
    {
      id: "operation",
      header: "Operation",
      weight: 190,
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
      id: "time",
      header: "Time (UTC)",
      weight: 190,
      align: "tokens",
      cell: (span) => formatTraceTimestamp(span.timestamp)
    },
    {
      id: "duration",
      header: "Duration",
      weight: 100,
      cell: (span) => formatTraceDuration(span.durationNs)
    },
    {
      id: "status",
      header: "Status",
      weight: 90,
      cell: (span) =>
        React.createElement(TraceStatus, { statusCode: span.statusCode })
    }
  ];
}

function renderRecentAttempts(
  traceList: UsageTraceList | undefined,
  selection: UsageFilterSelection
): React.JSX.Element | null {
  if (traceList === undefined) return null;
  let content: React.ReactNode;
  if (traceList.kind === "unavailable") {
    content = React.createElement(
      "p",
      { className: MUTED_BODY_CLASS, role: "status" },
      "Recent provider attempts were not observed. Aggregate Usage metrics may still be available."
    );
  } else if (traceList.kind === "not-applicable") {
    content = React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      traceList.reason === "skill-filter"
        ? "Recent provider attempts are not shown with a Skill filter because the source cannot safely attribute provider attempts to a skill."
        : "Recent provider attempts are not available for this filter combination."
    );
  } else {
    content = React.createElement(
      React.Fragment,
      null,
      traceList.partial
        ? React.createElement(
            "p",
            { className: MUTED_META_CLASS, role: "status" },
            "This list is partial; older matching attempts are outside the bounded recent read."
          )
        : null,
      React.createElement<DataTableProps<UsageTraceAttempt>>(DataTable, {
        data: traceList.attempts,
        columns: traceAttemptColumns(selection),
        keyExtractor: (attempt) => attempt.spanId,
        emptyMessage: "No provider attempts were observed in this scope."
      })
    );
  }

  return React.createElement(
    "section",
    {
      className: `flex flex-col gap-3 ${LIST_PANEL_CLASS}`,
      "aria-labelledby": "usage-recent-attempts-heading",
      "data-feature": "usage-recent-attempts",
      "data-trace-list-state": traceList.kind
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "h3",
        {
          id: "usage-recent-attempts-heading",
          className: SECTION_HEADING_CLASS
        },
        "Recent provider attempts"
      ),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "Newest 25 matching attempts. Select a span to inspect its trace."
      )
    ),
    content
  );
}

function renderTraceLookup(
  traceLookup: UsageTraceLookup,
  selection: UsageFilterSelection
): React.JSX.Element {
  if (traceLookup.kind !== "observed") {
    const message: Record<
      Exclude<UsageTraceLookup["kind"], "observed" | "http-error">,
      string
    > = {
      "invalid-span-id":
        "The selected value is not a valid OpenTelemetry span id.",
      "not-found":
        "OpenLIT no longer has this span in the retained trace data.",
      unavailable: "The selected trace could not be read from OpenLIT.",
      "not-configured": "The Usage telemetry credential is not configured.",
      unauthorized: "OpenLIT rejected the server-side Usage credential."
    };
    const errorMessage =
      traceLookup.kind === "http-error"
        ? `The trace query returned HTTP ${traceLookup.status}.`
        : message[traceLookup.kind];
    return React.createElement(
      "section",
      {
        className: `flex flex-col gap-3 ${LIST_PANEL_CLASS}`,
        role: "alert",
        "aria-labelledby": USAGE_TRACE_DETAIL_HEADING_ID,
        "data-feature": USAGE_TRACE_DETAIL_FEATURE,
        "data-trace-state": traceLookup.kind
      },
      React.createElement(
        "h3",
        { id: USAGE_TRACE_DETAIL_HEADING_ID, className: SECTION_HEADING_CLASS },
        USAGE_TRACE_DETAIL_TITLE
      ),
      React.createElement("p", { className: MUTED_BODY_CLASS }, errorMessage),
      React.createElement(
        "a",
        {
          href: usageHref(selection),
          className: `w-fit text-xs ${ACTION_LINK_CLASS}`
        },
        "Back to recent attempts"
      )
    );
  }

  const { detail } = traceLookup;
  return React.createElement(
    "section",
    {
      className: `flex flex-col gap-3 ${LIST_PANEL_CLASS}`,
      "aria-labelledby": USAGE_TRACE_DETAIL_HEADING_ID,
      "data-feature": USAGE_TRACE_DETAIL_FEATURE,
      "data-trace-state": "observed",
      "data-trace-partial": detail.partial ? "true" : "false"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "h3",
        { id: USAGE_TRACE_DETAIL_HEADING_ID, className: SECTION_HEADING_CLASS },
        USAGE_TRACE_DETAIL_TITLE
      ),
      React.createElement(
        "a",
        {
          href: usageHref(selection),
          className: `text-xs ${ACTION_LINK_CLASS}`
        },
        "Close trace detail"
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
      React.createElement(
        "span",
        null,
        "Selected span: ",
        React.createElement(
          "code",
          { className: "font-mono text-fg" },
          detail.selectedSpanId
        )
      ),
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
      columns: traceSpanColumns(selection, detail.selectedSpanId),
      keyExtractor: (span) => span.spanId,
      emptyMessage: "No trace spans were observed."
    })
  );
}

/**
 * Render the historical (non-Active-Sessions) metrics widgets. Split out of
 * `UsageView` so this scope's `null`/`undefined` BarChart-data checks do not
 * add to that function's cognitive complexity; `UsageView` only decides
 * *whether* to call this, never *what* it renders.
 */
function renderHistoricalMetrics(metrics: UsageMetricsData): React.JSX.Element {
  const requestsByRole = metrics.requestsByRole;
  const attemptsByProvider = metrics.attemptsByProvider;
  const attemptErrorsByProvider = metrics.attemptErrorsByProvider;
  const callsByTool = metrics.callsByTool;
  const skillEventsByEvent = metrics.skillEventsByEvent;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "div",
      null,
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "Requests & model usage"
      ),
      React.createElement(
        StatGrid,
        { columns: 5 },
        React.createElement(StatCard, {
          title: "Logical Routed Requests",
          value: formatCount(metrics.logicalRequests),
          subtitle: "autodev.routed_request"
        }),
        React.createElement(StatCard, {
          title: "Input / Output Tokens",
          value: `${formatTokenCount(metrics.totalInputTokens)} / ${formatTokenCount(metrics.totalOutputTokens)}`,
          subtitle: "Physical attempt totals"
        }),
        React.createElement(StatCard, {
          title: "Cache-read Rate",
          value: formatCacheRate(metrics.cacheReadRate),
          subtitle: "Cached / Input tokens"
        }),
        React.createElement(StatCard, {
          title: "P95 Latency",
          value: formatLatency(metrics.p95LatencyMs),
          subtitle: "Physical attempt duration"
        }),
        React.createElement(StatCard, {
          title: "Estimated Cost",
          value: formatEstimatedCost(metrics.estimatedCostUsd),
          subtitle: "OpenLIT pricing estimate; not billed cost"
        })
      )
    ),
    React.createElement(
      "div",
      { className: gridRowClass(2, "gap-6") },
      React.createElement(
        "div",
        {
          className: LIST_PANEL_CLASS
        },
        React.createElement(
          "h4",
          {
            className: SECTION_HEADING_CLASS
          },
          "Requests by Agent Role"
        ),
        React.createElement(BarChart, {
          data:
            requestsByRole === null || requestsByRole === undefined
              ? null
              : requestsByRole.map((item) => ({
                  label: formatDimension(item.role),
                  value: item.count,
                  valueText: formatCount(item.count)
                })),
          label: "Logical routed requests by agent role",
          notObservedMessage: "Role telemetry not observed.",
          emptyMessage: "No logical requests were observed in this time range.",
          barClass: "bg-chart-1",
          valueClass: "text-chart-1"
        })
      ),
      React.createElement(
        "div",
        {
          className: LIST_PANEL_CLASS
        },
        React.createElement(
          "h4",
          {
            className: SECTION_HEADING_CLASS
          },
          "Physical Attempts by Provider"
        ),
        React.createElement(BarChart, {
          data:
            attemptsByProvider === null || attemptsByProvider === undefined
              ? null
              : attemptsByProvider.map((item) => ({
                  label: formatDimension(item.provider),
                  value: item.count,
                  valueText: formatCount(item.count)
                })),
          label: "Physical attempts by provider",
          notObservedMessage: "Provider attempt telemetry not observed.",
          emptyMessage:
            "No provider attempts were observed in this time range.",
          barClass: "bg-chart-2",
          valueClass: "text-chart-2"
        })
      )
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "Reliability & context"
      ),
      React.createElement(
        "div",
        { className: PAGE_SECTION_STACK_CLASS },
        React.createElement(
          StatGrid,
          { columns: 3 },
          React.createElement(StatCard, {
            title: "Physical Attempts",
            value: formatCount(metrics.physicalAttempts),
            subtitle: "Provider/model attempt spans"
          }),
          React.createElement(StatCard, {
            title: "Failed Provider Attempts",
            value: formatCount(metrics.failedAttempts),
            subtitle: "GenAI attempt spans with error status"
          }),
          React.createElement(StatCard, {
            title: "Context Compactions",
            value: formatCount(metrics.contextCompactions),
            subtitle: "Runtime-confirmed compactions"
          })
        ),
        React.createElement(
          "div",
          { className: LIST_PANEL_CLASS },
          React.createElement(
            "h4",
            {
              className: SECTION_HEADING_CLASS
            },
            "Failed attempts by provider"
          ),
          React.createElement(BarChart, {
            data:
              attemptErrorsByProvider === null ||
              attemptErrorsByProvider === undefined
                ? null
                : attemptErrorsByProvider.map((item) => ({
                    label: formatDimension(item.provider),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: "Failed provider attempts",
            notObservedMessage: "Provider failure telemetry not observed.",
            emptyMessage:
              "No failed provider attempts were observed in this time range.",
            barClass: "bg-chart-5",
            valueClass: "text-chart-5"
          })
        )
      )
    ),
    React.createElement(
      "div",
      { className: LIST_PANEL_CLASS },
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "Skill activity"
      ),
      React.createElement(BarChart, {
        data:
          skillEventsByEvent === null || skillEventsByEvent === undefined
            ? null
            : skillEventsByEvent.map((item) => ({
                label: formatDimension(item.event),
                value: item.count,
                valueText: formatCount(item.count)
              })),
        label: "Skill observations by event",
        notObservedMessage: "Skill telemetry not observed.",
        emptyMessage: "No skill observations were reported in this time range.",
        barClass: "bg-chart-4",
        valueClass: "text-chart-4"
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "MCP tool activity"
      ),
      React.createElement(
        StatGrid,
        { columns: 3 },
        React.createElement(StatCard, {
          title: "MCP Tool Calls",
          value: formatCount(metrics.mcpCalls),
          subtitle: "MCP tool-call round trips"
        }),
        React.createElement(StatCard, {
          title: "P95 Tool-call Duration",
          value: formatLatency(metrics.p95McpDurationMs),
          subtitle: "MCP tool-call round trip"
        }),
        React.createElement(StatCard, {
          title: "MCP Tool Errors",
          value: formatCount(metrics.mcpErrors),
          subtitle: "Errored MCP tool calls"
        })
      )
    ),
    React.createElement(
      "div",
      {
        className: LIST_PANEL_CLASS
      },
      React.createElement(
        "h4",
        {
          className: SECTION_HEADING_CLASS
        },
        "MCP Calls by Tool Name"
      ),
      React.createElement(BarChart, {
        data:
          callsByTool === null || callsByTool === undefined
            ? null
            : callsByTool.map((item) => ({
                label: formatDimension(item.tool),
                value: item.count,
                valueText: formatCount(item.count)
              })),
        label: "MCP calls by tool name",
        notObservedMessage: "Tool-call telemetry not observed.",
        emptyMessage: "No MCP tool calls were observed in this time range.",
        barClass: "bg-chart-3",
        valueClass: "text-chart-3"
      })
    )
  );
}

export function UsageView({
  metrics,
  filterOptions = UNKNOWN_FILTER_OPTIONS,
  traceList,
  traceLookup,
  selection = DEFAULT_SELECTION,
  activeSessions
}: UsageViewProps): React.JSX.Element {
  const selectedValues = selection.values;
  const todayUtc = new Date().toISOString().slice(0, 10);
  // The live scope has no interval, so the custom bounds do not describe
  // anything here. Rendering them would offer an operator a control that cannot
  // affect the reading in front of them.
  const isActiveSessions = selection.range === "ACTIVE_SESSIONS";
  const observed =
    metrics !== undefined &&
    Object.values(metrics).some((value) => value !== null);

  return React.createElement(
    PageBody,
    {
      feature: "usage",
      attributes: { "data-usage-observed": observed ? "true" : "false" }
    },
    React.createElement(
      FilterBar,
      {
        label: "Usage filters",
        action: "/usage",
        submitTestId: "usage-apply",
        submitMode: isActiveSessions ? "on-change" : "explicit"
      },
      React.createElement(
        "div",
        { className: "flex min-w-0 flex-wrap gap-3 items-center" },
        React.createElement(
          "div",
          { className: FIELD_GROUP_CLASS },
          React.createElement(
            isActiveSessions ? AutoSubmitSelectField : SelectField,
            {
              name: "range",
              // Not "Time range": this control now holds a selection that is
              // not a time range, and a label that promises only a window
              // would misdescribe one of its own options.
              label: "Usage scope:",
              defaultValue: selection.range,
              options: [
                { value: "ACTIVE_SESSIONS", label: "Active sessions" },
                { value: "24H", label: "Last 24 hours" },
                { value: "7D", label: "Last 7 days" },
                { value: "1M", label: "Last 30 days" },
                { value: "3M", label: "Last 90 days" },
                { value: "CUSTOM", label: "Custom range" }
              ]
            }
          )
        ),
        renderScopeMeta(selection, isActiveSessions, todayUtc)
      ),
      renderFilterControls(isActiveSessions, filterOptions, selectedValues)
    ),
    !isActiveSessions && traceLookup
      ? renderTraceLookup(traceLookup, selection)
      : null,
    isActiveSessions
      ? renderActiveSessionsScope(activeSessions)
      : metrics === undefined
        ? null
        : React.createElement(
            React.Fragment,
            null,
            renderHistoricalMetrics(metrics),
            renderRecentAttempts(traceList, selection)
          )
  );
}
