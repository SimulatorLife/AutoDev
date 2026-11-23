import {
  CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT,
  type ControlApiMcpRuntimeResponse,
  formatClientSurface,
  type McpServerResource,
  type RuleSyncValidationIssue,
  USAGE_VARIABLE_IDS,
  type UsageActiveSessions,
  type UsageFilterOptions,
  type UsageFilterSelection,
  type UsageGitChangeMetrics,
  type UsageMetricsData,
  type UsageTraceAttempt,
  type UsageTraceDetail,
  type UsageTraceList,
  type UsageTraceSpan
} from "@simulatorlife/autodev-core";
import { type ColumnDef } from "@tanstack/react-table";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { BarChart } from "../../components/charts/BarChart.ts";
import { FilterBar } from "../../components/filters/FilterBar.ts";
import { AutoSubmitSelectField } from "../../components/forms/AutoSubmitSelectField.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import {
  PAGE_SECTION_STACK_CLASS,
  PageBody
} from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { gridRowClass, StatGrid } from "../../components/panels/DetailGrid.ts";
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { chipList } from "../../components/tables/Chips.ts";
import {
  DataTable,
  type DataTableFeatures,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { TraceStatus } from "../../components/traces/TraceStatus.ts";
import {
  formatDurationMs,
  formatSpanDuration
} from "../../components/ui/duration.ts";
import {
  FIELD_GROUP_CLASS,
  TEXT_CONTROL_CLASS
} from "../../components/ui/field-classes.ts";
import { InstantDisplay } from "../../components/ui/InstantDisplay.ts";
import {
  ACTION_LINK_CLASS,
  MONO_ID_LINK_CLASS,
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
  /**
   * The session scope the page is narrowed to, when the operator typed one.
   *
   * `sessionId` is the validated identity; `invalid` says the typed value was
   * not one, which is a different fact from "no session was typed".
   */
  readonly sessionScope?:
    | {
        readonly sessionId: string | null;
        readonly invalid: boolean;
        readonly rawSessionId: string;
      }
    | undefined;
  /** The session-scoped body, rendered instead of the fleet body. */
  readonly sessionView?: React.ReactNode | undefined;
  /** The unscoped fleet diagnostics view, rendered above the historical body. */
  readonly fleetView?: React.ReactNode | undefined;
  /**
   * Control API MCP server inventory and Runtime usage observations.
   *
   * Absent or `kind: "unavailable"` renders an explicit unavailable state
   * rather than an empty server list.
   */
  readonly mcpInventory?: UsageMcpInventory | undefined;
}

export type UsageMcpInventory =
  | {
      readonly kind: "observed";
      readonly servers: readonly McpServerResource[];
      readonly sourceValidity: boolean | null;
      readonly validationIssues: readonly RuleSyncValidationIssue[];
      readonly runtime: ControlApiMcpRuntimeResponse | null;
      readonly runtimeFailure: {
        readonly code: string;
        readonly message: string;
      } | null;
    }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly message: string;
    };

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
const RECENT_PROVIDER_ATTEMPTS_LABEL = "Recent provider attempts";
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
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
const CONTEXT_COMPACTION_EMPTY_MESSAGE =
  "No source-confirmed compactions were observed in this time range.";
const PROVIDER_HOP_EMPTY_MESSAGE =
  "No provider hops were observed in this time range.";
const NOT_APPLICABLE_STATUS = "not-applicable" as const;

/**
 * The chart palette, named once.
 *
 * Every breakdown on this page draws its bars with one of these series
 * colours and its values with the matching text colour. The pairs live here
 * instead of at every chart because a colour is a property of the page, not
 * of one breakdown: the third series on the page is the same colour whether
 * it is the third chart of one section or the third chart of another, and a
 * reader who learns that once should not have to re-learn it from a literal.
 */
const CHART_PALETTE = {
  series1: { bar: "bg-chart-1", value: "text-chart-1" },
  series2: { bar: "bg-chart-2", value: "text-chart-2" },
  series3: { bar: "bg-chart-3", value: "text-chart-3" },
  series4: { bar: "bg-chart-4", value: "text-chart-4" },
  series5: { bar: "bg-chart-5", value: "text-chart-5" }
} as const;

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
  return formatDurationMs(value);
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
type UsageActiveSessionIdentity = NonNullable<
  UsageActiveSessions["sessionIdentities"]
>[number];

function redactedSessionLabel(sessionId: string): string {
  if (sessionId.length <= 4) return "••••";
  const prefixLength = Math.min(
    8,
    Math.max(2, Math.floor(sessionId.length / 2))
  );
  const suffixLength = Math.min(
    4,
    Math.max(1, Math.floor(sessionId.length / 4))
  );
  return `${sessionId.slice(0, prefixLength)}…${sessionId.slice(-suffixLength)}`;
}

/**
 * The live session rows link straight into the session-scoped Usage view.
 *
 * The link carries the session id in the URL, so the target page can read the
 * whole session's diagnostics without a second click. The label stays
 * redacted: the id is in the link, and a link's own href is not the same as a
 * table cell that prints an identity in full.
 */
const LIVE_SESSION_COLUMNS: readonly ColumnDef<
  DataTableFeatures,
  UsageActiveSessionIdentity
>[] = [
  {
    id: "session",
    header: "Session",
    cell: ({ row: { original: session } }) =>
      React.createElement(
        NavigationLink,
        {
          href: `/usage?range=24H&sessionId=${encodeURIComponent(session.sessionId)}`,
          className: ACTION_LINK_CLASS
        },
        redactedSessionLabel(session.sessionId)
      ),
    meta: {
      weight: 120,
      align: "tokens"
    }
  },
  {
    id: "client-surface",
    header: "Client",
    cell: ({ row: { original: session } }) =>
      formatClientSurface(session.clientSurface),
    meta: {
      weight: 140
    }
  },
  {
    id: "activity",
    header: "Activity",
    cell: ({ row: { original: session } }) =>
      session.state.replaceAll("_", " "),
    meta: {
      weight: 120
    }
  },
  {
    id: "provider",
    header: "Provider",
    cell: ({ row: { original: session } }) =>
      session.provider ?? NOT_OBSERVED_LABEL,
    meta: { weight: 120, align: "tokens" }
  },
  {
    id: "model",
    header: "Model",
    cell: ({ row: { original: session } }) =>
      session.model ?? NOT_OBSERVED_LABEL,
    meta: { weight: 150, align: "tokens" }
  },
  {
    id: "role",
    header: "Role",
    cell: ({ row: { original: session } }) =>
      session.role ?? NOT_OBSERVED_LABEL,
    meta: { weight: 100, align: "tokens" }
  },
  {
    id: "last-activity",
    header: "Last activity",
    cell: ({ row: { original: session } }) =>
      React.createElement(InstantDisplay, {
        value: new Date(session.lastActivityAt).toISOString(),
        label: "Last activity"
      }),
    meta: {
      weight: 180,
      align: "tokens"
    }
  }
];

function renderActiveSessionsScope(
  active: UsageActiveSessions | undefined
): React.JSX.Element {
  if (active === undefined) {
    return React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
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
      "h2",
      { className: SECTION_HEADING_CLASS },
      "Active Sessions"
    ),
    React.createElement(
      "div",
      { className: PAGE_SECTION_STACK_CLASS },
      React.createElement(
        StatGrid,
        { columns: 3 },
        React.createElement(StatCard, {
          title: "Active Sessions",
          value: formatCount(active.activeSessions),
          subtitle: "Runtime concurrency count; identity list is separate"
        }),
        React.createElement(StatCard, {
          title: "Identified Sessions",
          value: formatCount(active.identifiedSessionCount),
          subtitle: "Distinct source-confirmed IDs on live agent activity"
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
      active.sessionIdentitiesPartial
        ? React.createElement(
            "p",
            { className: CALLOUT_WARNING_CLASS, role: "status" },
            `The live session list reached its ${CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT}-session limit; the identified-session count remains exact.`
          )
        : null,
      active.unattributedLiveActivityCount !== null &&
        active.unattributedLiveActivityCount > 0
        ? React.createElement(
            "p",
            { className: CALLOUT_WARNING_CLASS, role: "status" },
            `${formatCount(active.unattributedLiveActivityCount)} live activity record${active.unattributedLiveActivityCount === 1 ? "" : "s"} had no source-confirmed session ID. These records are omitted from the identified list, not guessed into a session.`
          )
        : null,
      active.sessionIdentities === null
        ? React.createElement(
            "p",
            { className: MUTED_BODY_CLASS, role: "status" },
            "The Runtime did not report per-session identity; no session list is shown."
          )
        : active.sessionIdentities.length === 0
          ? React.createElement(
              "p",
              { className: MUTED_BODY_CLASS, role: "status" },
              active.unattributedLiveActivityCount === 0
                ? "No identified live sessions were observed."
                : "No live session IDs were identified; see the unattributed activity count above."
            )
          : React.createElement(DataTable<UsageActiveSessionIdentity>, {
              data: active.sessionIdentities,
              columns: LIVE_SESSION_COLUMNS,
              keyExtractor: (session) => session.sessionId,
              emptyMessage: "No identified live sessions were observed.",
              label: "Live Runtime sessions"
            })
    )
  );
}

function formatDimension(value: string): string {
  return value.trim().length === 0 ? "Not attributed" : value;
}

/**
 * The word a panel or card uses when the signal cannot answer the selection.
 *
 * "Not observed" is the Console's word for "the source reported nothing".
 * A signal that cannot answer the selected filter is a different fact: the
 * source reported it, and the selection is what rules it out. Giving both
 * the same word sends the reader looking for a capture that is there, and
 * hides the one thing that explains the missing panel.
 */
const NOT_APPLICABLE_LABEL = "Not applicable";

/**
 * A counted value, or why it is not counted.
 *
 * `unsupportedFilters` names the selected filters the signal does not
 * carry. An empty list means the signal simply was not observed.
 */
function formatSignalCount(
  value: number | null,
  unsupportedFilters: readonly string[]
): string {
  if (value !== null) return formatCount(value);
  return unsupportedFilters.length > 0
    ? NOT_APPLICABLE_LABEL
    : NOT_OBSERVED_LABEL;
}

/**
 * The message a panel shows when it has nothing to draw.
 *
 * A signal that cannot answer the selected filter is not a signal that was
 * not observed, so the panel says which of the two it is. The subject is
 * the panel's own name, so the message names what is missing rather than
 * repeating the section's explanation on every panel.
 */
function panelUnavailableMessage(
  subject: string,
  unsupportedFilters: readonly string[]
): string {
  if (unsupportedFilters.length === 0) return `${subject} not observed.`;
  return `${subject} is unavailable for the selected ${unsupportedFilters.join(" and ")} filter${unsupportedFilters.length === 1 ? "" : "s"}.`;
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
      className: `flex min-w-0 flex-wrap items-center gap-2 ${MUTED_META_CLASS}`,
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
        className: TEXT_CONTROL_CLASS
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
        className: TEXT_CONTROL_CLASS
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

function formatTraceDuration(durationNs: number): string {
  return formatSpanDuration(durationNs);
}

function traceAttemptColumns(
  selection: UsageFilterSelection
): readonly ColumnDef<DataTableFeatures, UsageTraceAttempt>[] {
  return [
    {
      id: "time",
      header: "Time",
      cell: ({ row: { original: attempt } }) =>
        React.createElement(InstantDisplay, {
          value: attempt.timestamp,
          label: "Attempt time"
        }),
      meta: {
        weight: 190,
        align: "tokens"
      }
    },
    {
      id: "provider",
      header: "Provider",
      cell: ({ row: { original: attempt } }) =>
        attempt.provider ?? NOT_OBSERVED_LABEL,
      meta: {
        weight: 120,
        align: "tokens"
      }
    },
    {
      id: "model",
      header: "Model",
      cell: ({ row: { original: attempt } }) =>
        attempt.model ?? NOT_OBSERVED_LABEL,
      meta: {
        weight: 210,
        align: "tokens"
      }
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row: { original: attempt } }) =>
        attempt.role ?? NOT_OBSERVED_LABEL,
      meta: {
        weight: 120,
        align: "tokens"
      }
    },
    {
      id: "duration",
      header: "Duration",
      cell: ({ row: { original: attempt } }) =>
        formatTraceDuration(attempt.durationNs),
      meta: {
        weight: 100
      }
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row: { original: attempt } }) =>
        React.createElement(TraceStatus, { statusCode: attempt.statusCode }),
      meta: {
        weight: 90
      }
    },
    {
      id: "span",
      header: "Span",
      cell: ({ row: { original: attempt } }) =>
        React.createElement(
          NavigationLink,
          {
            href: usageHref(selection, attempt.spanId),
            className: `font-mono text-xs ${ACTION_LINK_CLASS}`,
            "aria-label": `Inspect trace for span ${attempt.spanId}`,
            dataAttributes: { "data-usage-trace-span-id": attempt.spanId }
          },
          attempt.spanId
        ),
      meta: {
        weight: 150,
        align: "tokens"
      }
    }
  ];
}

function traceSpanColumns(
  selection: UsageFilterSelection,
  selectedSpanId: string
): readonly ColumnDef<DataTableFeatures, UsageTraceSpan>[] {
  return [
    {
      id: "span",
      header: "Span",
      cell: ({ row: { original: span } }) =>
        React.createElement(
          NavigationLink,
          {
            href: usageHref(selection, span.spanId),
            className: `font-mono text-xs ${ACTION_LINK_CLASS}`,
            "aria-label": `Inspect span ${span.spanId}${span.spanId === selectedSpanId ? ", selected" : ""}`,
            ...(span.spanId === selectedSpanId
              ? { "aria-current": "true", "data-trace-selected": "true" }
              : {})
          },
          span.spanId
        ),
      meta: {
        weight: 150,
        align: "tokens"
      }
    },
    {
      id: "parent",
      header: "Parent span",
      cell: ({ row: { original: span } }) =>
        span.parentSpanId
          ? React.createElement(
              NavigationLink,
              {
                href: usageHref(selection, span.parentSpanId),
                className: `font-mono text-xs ${ACTION_LINK_CLASS}`,
                "aria-label": `Inspect parent span ${span.parentSpanId}`
              },
              span.parentSpanId
            )
          : "Root span",
      meta: {
        weight: 150,
        align: "tokens"
      }
    },
    {
      id: "operation",
      header: "Operation",
      cell: ({ row: { original: span } }) =>
        span.spanName || NOT_OBSERVED_LABEL,
      meta: {
        weight: 190,
        align: "tokens"
      }
    },
    {
      id: "service",
      header: "Service",
      cell: ({ row: { original: span } }) =>
        span.serviceName || NOT_OBSERVED_LABEL,
      meta: {
        weight: 130,
        align: "tokens"
      }
    },
    {
      id: "time",
      header: "Time",
      cell: ({ row: { original: span } }) =>
        React.createElement(InstantDisplay, {
          value: span.timestamp,
          label: "Span time"
        }),
      meta: {
        weight: 190,
        align: "tokens"
      }
    },
    {
      id: "duration",
      header: "Duration",
      cell: ({ row: { original: span } }) =>
        formatTraceDuration(span.durationNs),
      meta: {
        weight: 100
      }
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row: { original: span } }) =>
        React.createElement(TraceStatus, { statusCode: span.statusCode }),
      meta: {
        weight: 90
      }
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
      `${RECENT_PROVIDER_ATTEMPTS_LABEL} were not observed. Aggregate Usage metrics may still be available.`
    );
  } else if (traceList.kind === NOT_APPLICABLE_STATUS) {
    content = React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      traceList.reason === "skill-filter"
        ? `${RECENT_PROVIDER_ATTEMPTS_LABEL} are not shown with a Skill filter because the source cannot safely attribute provider attempts to a skill.`
        : `${RECENT_PROVIDER_ATTEMPTS_LABEL} are not available for this filter combination.`
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
      className: "flex flex-col gap-3",
      "aria-labelledby": "usage-recent-attempts-heading",
      "data-feature": "usage-recent-attempts",
      "data-trace-list-state": traceList.kind
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "h2",
        {
          id: "usage-recent-attempts-heading",
          className: SECTION_HEADING_CLASS
        },
        RECENT_PROVIDER_ATTEMPTS_LABEL
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
        "h2",
        { id: USAGE_TRACE_DETAIL_HEADING_ID, className: SECTION_HEADING_CLASS },
        USAGE_TRACE_DETAIL_TITLE
      ),
      React.createElement("p", { className: MUTED_BODY_CLASS }, errorMessage),
      React.createElement(
        NavigationLink,
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
        "h2",
        { id: USAGE_TRACE_DETAIL_HEADING_ID, className: SECTION_HEADING_CLASS },
        USAGE_TRACE_DETAIL_TITLE
      ),
      React.createElement(
        NavigationLink,
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
function renderGitChangeMetrics(
  metrics: UsageGitChangeMetrics
): React.JSX.Element {
  if (metrics.status === NOT_APPLICABLE_STATUS) {
    const reason =
      metrics.notApplicableReason === "active-sessions"
        ? "Git change output is historical and has no Active Sessions scope."
        : `Git change output is unavailable for the selected ${metrics.unsupportedFilters.join(" and ")} filter; commit identity does not include those dimensions.`;
    return React.createElement(
      "section",
      { "data-git-change-output": NOT_APPLICABLE_STATUS },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Git change output"
      ),
      React.createElement(
        "p",
        { className: CALLOUT_WARNING_CLASS, role: "status" },
        reason
      )
    );
  }

  const unavailableMessage =
    metrics.status === "unavailable"
      ? "Git change metrics are unavailable for this time range."
      : metrics.status === "not-observed"
        ? "No source-confirmed AutoDev commits were observed in this time range."
        : null;
  return React.createElement(
    "section",
    {
      className: PAGE_SECTION_STACK_CLASS,
      "data-git-change-output": metrics.status
    },
    React.createElement(
      "h2",
      { className: SECTION_HEADING_CLASS },
      "Git change output"
    ),
    unavailableMessage === null
      ? null
      : React.createElement(
          "p",
          {
            className:
              metrics.status === "unavailable"
                ? CALLOUT_WARNING_CLASS
                : MUTED_BODY_CLASS,
            role: "status"
          },
          unavailableMessage
        ),
    metrics.partial === true
      ? React.createElement(
          "p",
          {
            className: CALLOUT_WARNING_CLASS,
            role: "status",
            "data-git-change-output-partial": "true"
          },
          `Partial diff measurements were observed for ${formatCount(metrics.partialCommits)} commit${metrics.partialCommits === 1 ? "" : "s"}; line totals are unavailable because one or more diffs could not be fully summarized.`
        )
      : null,
    metrics.breakdownsPartial
      ? React.createElement(
          "p",
          {
            className: CALLOUT_WARNING_CLASS,
            role: "status",
            "data-git-change-breakdowns": "partial"
          },
          "A Git breakdown reached its result limit; shown categories may be partial."
        )
      : null,
    React.createElement(
      StatGrid,
      { columns: 3 },
      React.createElement(StatCard, {
        title: "Agent Commits",
        value: formatCount(metrics.commits),
        subtitle: "Commit identity confirmed"
      }),
      React.createElement(StatCard, {
        title: "Files Changed",
        value: formatCount(metrics.filesChanged),
        subtitle: "Distinct paths; includes additions and deletions"
      }),
      React.createElement(StatCard, {
        title: "Lines Added / Removed",
        value: `${formatCount(metrics.linesAdded)} / ${formatCount(metrics.linesRemoved)}`,
        subtitle: "Git numstat; unavailable when any diff is partial"
      }),
      React.createElement(StatCard, {
        title: "Files Added",
        value: formatCount(metrics.filesAdded),
        subtitle: "Subset of files changed"
      }),
      React.createElement(StatCard, {
        title: "Files Deleted",
        value: formatCount(metrics.filesDeleted),
        subtitle: "Subset of files changed"
      }),
      React.createElement(StatCard, {
        title: "Partial Commits",
        value: formatCount(metrics.partialCommits),
        subtitle: "Binary or unsummarized diffs"
      })
    ),
    React.createElement(
      "div",
      { className: gridRowClass(3, "gap-6") },
      ...[
        {
          title: "Commits by workspace",
          data: metrics.commitsByWorkspace,
          label: "Source-confirmed agent commits by workspace",
          notObservedMessage: "Workspace commit telemetry not observed.",
          emptyMessage: "No workspace-attributed commits were observed.",
          barClass: CHART_PALETTE.series1.bar,
          valueClass: CHART_PALETTE.series1.value
        },
        {
          title: "Commits by provider",
          data: metrics.commitsByProvider,
          label: "Source-confirmed agent commits by provider",
          notObservedMessage: "Provider commit telemetry not observed.",
          emptyMessage: "No provider-attributed commits were observed.",
          barClass: CHART_PALETTE.series2.bar,
          valueClass: CHART_PALETTE.series2.value
        },
        {
          title: "Commits by agent role",
          data: metrics.commitsByAgent,
          label: "Source-confirmed agent commits by role",
          notObservedMessage: "Agent-role commit telemetry not observed.",
          emptyMessage: "No agent-attributed commits were observed.",
          barClass: CHART_PALETTE.series4.bar,
          valueClass: CHART_PALETTE.series4.value
        }
      ].map((chart) =>
        React.createElement(
          "div",
          { key: chart.title, className: LIST_PANEL_CLASS },
          React.createElement(
            "h3",
            { className: SECTION_HEADING_CLASS },
            chart.title
          ),
          React.createElement(BarChart, {
            data:
              chart.data === null
                ? null
                : chart.data.map((item) => ({
                    label: formatDimension(item.name),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: chart.label,
            notObservedMessage: chart.notObservedMessage,
            emptyMessage: chart.emptyMessage,
            barClass: chart.barClass,
            valueClass: chart.valueClass
          })
        )
      )
    )
  );
}

/**
 * The provider-hop section of the Usage page.
 *
 * A hop is a fact about one request: that request changed the provider
 * serving an agent. It is its own section because it is its own story --
 * which pair of providers the agent moved between, why it moved, and where
 * it moved -- and because none of the page's other history (requests,
 * reliability, skills) can explain a change of provider.
 */
function renderProviderHopMetrics(
  metrics: UsageMetricsData
): React.JSX.Element {
  const providerHopUnsupportedFilters = metrics.providerHopsUnsupportedFilters;
  return React.createElement(
    "div",
    null,
    React.createElement(
      "h2",
      {
        className: SECTION_HEADING_CLASS
      },
      "Provider hops"
    ),
    React.createElement(
      "div",
      { className: PAGE_SECTION_STACK_CLASS },
      providerHopUnsupportedFilters.length > 0
        ? React.createElement(
            "p",
            {
              className: CALLOUT_WARNING_CLASS,
              role: "status",
              "data-provider-hop-scope": NOT_APPLICABLE_STATUS
            },
            `Provider hop data is unavailable for the selected ${providerHopUnsupportedFilters.join(" and ")} filter${providerHopUnsupportedFilters.length === 1 ? "" : "s"}; this source records a hop on the logical request that observed it, and that request does not carry those dimensions.`
          )
        : null,
      metrics.providerHopsBreakdownsPartial
        ? React.createElement(
            "p",
            {
              className: CALLOUT_WARNING_CLASS,
              role: "status",
              "data-provider-hop-breakdowns": "partial"
            },
            "A provider hop breakdown reached its 20-row limit; the shown categories may be partial."
          )
        : null,
      React.createElement(
        StatGrid,
        { columns: 2 },
        React.createElement(StatCard, {
          title: "Provider Hops",
          value: formatSignalCount(
            metrics.providerHops,
            providerHopUnsupportedFilters
          ),
          subtitle: "Requests that changed the provider serving the agent"
        }),
        React.createElement(StatCard, {
          title: "Hops per Request",
          value:
            metrics.providerHopRatePercent === null &&
            providerHopUnsupportedFilters.length > 0
              ? NOT_APPLICABLE_LABEL
              : formatCacheRate(metrics.providerHopRatePercent),
          subtitle: "Provider hops / logical routed requests"
        })
      ),
      React.createElement(
        "div",
        { className: LIST_PANEL_CLASS },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Provider Hops Over Time"
        ),
        React.createElement(BarChart, {
          data:
            metrics.providerHopsOverTime === null
              ? null
              : metrics.providerHopsOverTime.map((item) => ({
                  label: item.bucket,
                  displayLabel: bucketDisplay(
                    item.bucket,
                    "Provider hop time bucket"
                  ),
                  value: item.count,
                  valueText: formatCount(item.count)
                })),
          label: "Provider hops by time bucket",
          notObservedMessage: panelUnavailableMessage(
            "Provider hop time-series data",
            providerHopUnsupportedFilters
          ),
          emptyMessage: PROVIDER_HOP_EMPTY_MESSAGE,
          barClass: CHART_PALETTE.series3.bar,
          valueClass: CHART_PALETTE.series3.value
        })
      ),
      React.createElement(
        "div",
        { className: gridRowClass(2, "gap-6") },
        React.createElement(
          "div",
          { className: LIST_PANEL_CLASS },
          React.createElement(
            "h3",
            { className: SECTION_HEADING_CLASS },
            "Provider Hops by Route"
          ),
          React.createElement(BarChart, {
            data:
              metrics.providerHopsByRoute === null
                ? null
                : metrics.providerHopsByRoute.map((item) => ({
                    label: formatDimension(item.name),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: "Provider hops by the provider pair the agent moved between",
            notObservedMessage: panelUnavailableMessage(
              "Provider hop route breakdown",
              providerHopUnsupportedFilters
            ),
            emptyMessage: PROVIDER_HOP_EMPTY_MESSAGE,
            barClass: CHART_PALETTE.series1.bar,
            valueClass: CHART_PALETTE.series1.value
          })
        ),
        React.createElement(
          "div",
          { className: LIST_PANEL_CLASS },
          React.createElement(
            "h3",
            { className: SECTION_HEADING_CLASS },
            "Provider Hops by Reason"
          ),
          React.createElement(BarChart, {
            data:
              metrics.providerHopsByReason === null
                ? null
                : metrics.providerHopsByReason.map((item) => ({
                    label: formatDimension(item.name),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: "Provider hops by why the provider changed",
            notObservedMessage: panelUnavailableMessage(
              "Provider hop reason breakdown",
              providerHopUnsupportedFilters
            ),
            emptyMessage: PROVIDER_HOP_EMPTY_MESSAGE,
            barClass: CHART_PALETTE.series2.bar,
            valueClass: CHART_PALETTE.series2.value
          })
        )
      ),
      React.createElement(
        "div",
        { className: gridRowClass(3, "gap-6") },
        React.createElement(
          "div",
          { className: LIST_PANEL_CLASS },
          React.createElement(
            "h3",
            { className: SECTION_HEADING_CLASS },
            "Provider Hops by Provider"
          ),
          React.createElement(BarChart, {
            data:
              metrics.providerHopsByProvider === null
                ? null
                : metrics.providerHopsByProvider.map((item) => ({
                    label: formatDimension(item.name),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: "Provider hops by the provider that now serves the agent",
            notObservedMessage: panelUnavailableMessage(
              "Provider hop provider breakdown",
              providerHopUnsupportedFilters
            ),
            emptyMessage: PROVIDER_HOP_EMPTY_MESSAGE,
            barClass: CHART_PALETTE.series3.bar,
            valueClass: CHART_PALETTE.series3.value
          })
        ),
        React.createElement(
          "div",
          { className: LIST_PANEL_CLASS },
          React.createElement(
            "h3",
            { className: SECTION_HEADING_CLASS },
            "Provider Hops by Workspace"
          ),
          React.createElement(BarChart, {
            data:
              metrics.providerHopsByWorkspace === null
                ? null
                : metrics.providerHopsByWorkspace.map((item) => ({
                    label: formatDimension(item.name),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: "Provider hops by workspace",
            notObservedMessage: panelUnavailableMessage(
              "Provider hop workspace breakdown",
              providerHopUnsupportedFilters
            ),
            emptyMessage: PROVIDER_HOP_EMPTY_MESSAGE,
            barClass: CHART_PALETTE.series4.bar,
            valueClass: CHART_PALETTE.series4.value
          })
        ),
        React.createElement(
          "div",
          { className: LIST_PANEL_CLASS },
          React.createElement(
            "h3",
            { className: SECTION_HEADING_CLASS },
            "Provider Hops by Agent Role"
          ),
          React.createElement(BarChart, {
            data:
              metrics.providerHopsByRole === null
                ? null
                : metrics.providerHopsByRole.map((item) => ({
                    label: formatDimension(item.name),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: "Provider hops by agent role",
            notObservedMessage: panelUnavailableMessage(
              "Provider hop agent-role breakdown",
              providerHopUnsupportedFilters
            ),
            emptyMessage: PROVIDER_HOP_EMPTY_MESSAGE,
            barClass: CHART_PALETTE.series5.bar,
            valueClass: CHART_PALETTE.series5.value
          })
        )
      )
    )
  );
}

interface UsageMcpServerRow {
  readonly name: string;
  readonly configured: boolean;
  readonly roles: readonly string[];
  readonly enabled: boolean | null;
  readonly usageState:
    | "used"
    | "used-with-errors"
    | "exposed-never-used"
    | "disabled"
    | "not-exposed"
    | "observed-unconfigured"
    | "not-observed";
  readonly toolCalls: number | null;
  readonly failures: number | null;
}

function buildUsageMcpRows(
  servers: readonly McpServerResource[],
  runtime: ControlApiMcpRuntimeResponse | null
): readonly UsageMcpServerRow[] {
  const runtimeObserved = runtime !== null && runtime.observedServers !== null;
  const observationsByName = new Map(
    (runtime?.servers ?? []).map((server) => [server.name, server] as const)
  );
  const configuredNames = new Set(servers.map((server) => server.name));

  const rows: UsageMcpServerRow[] = servers.map((server) => {
    const observation = observationsByName.get(server.name);
    if (!runtimeObserved) {
      return {
        name: server.name,
        configured: true,
        roles: server.roles,
        enabled: server.enabled,
        usageState: "not-observed",
        toolCalls: null,
        failures: null
      };
    }
    const toolCalls = observation?.toolCalls ?? 0;
    const failures = observation?.failures ?? 0;
    const hasActivity = toolCalls > 0 || failures > 0;
    const usageState: UsageMcpServerRow["usageState"] = hasActivity
      ? failures > 0
        ? "used-with-errors"
        : "used"
      : server.enabled === false
        ? "disabled"
        : server.roles.length > 0
          ? "exposed-never-used"
          : "not-exposed";
    return {
      name: server.name,
      configured: true,
      roles: server.roles,
      enabled: server.enabled,
      usageState,
      toolCalls,
      failures
    };
  });

  if (runtimeObserved) {
    for (const observed of runtime.servers) {
      if (configuredNames.has(observed.name)) continue;
      rows.push({
        name: observed.name,
        configured: false,
        roles: [],
        enabled: null,
        usageState: "observed-unconfigured",
        toolCalls: observed.toolCalls,
        failures: observed.failures
      });
    }
  }

  return rows;
}

const MCP_USAGE_BADGE_DESCRIPTORS: Readonly<
  Record<
    UsageMcpServerRow["usageState"],
    {
      readonly status: "configured" | "invalid" | typeof NOT_OBSERVED_STATUS;
      readonly label: string;
    }
  >
> = {
  used: { status: "configured", label: "Used" },
  "used-with-errors": { status: "invalid", label: "Used (errors)" },
  "exposed-never-used": {
    status: NOT_OBSERVED_STATUS,
    label: "Exposed, never used"
  },
  disabled: { status: NOT_OBSERVED_STATUS, label: "Disabled" },
  "not-exposed": { status: NOT_OBSERVED_STATUS, label: "Not exposed" },
  "observed-unconfigured": {
    status: "configured",
    label: "Observed (unconfigured)"
  },
  "not-observed": { status: NOT_OBSERVED_STATUS, label: NOT_OBSERVED_LABEL }
};

function mcpUsageBadge(
  state: UsageMcpServerRow["usageState"]
): React.JSX.Element {
  const descriptor = MCP_USAGE_BADGE_DESCRIPTORS[state];
  return React.createElement(
    "span",
    { "data-mcp-usage-state": state },
    React.createElement(StatusBadge, {
      status: descriptor.status,
      label: descriptor.label
    })
  );
}

function renderMcpServersPanel(
  mcpInventory: UsageMcpInventory | undefined
): React.JSX.Element {
  const windowNote = React.createElement(
    "p",
    { className: `${MUTED_META_CLASS} mb-3` },
    "Inventory from Control API (/control/mcps). Observed calls and failures come from Runtime observations (/control/mcp-runtime) accumulated since router start — independent of the OpenLIT time range and filters above."
  );

  if (mcpInventory === undefined || mcpInventory.kind === "unavailable") {
    const code =
      mcpInventory === undefined
        ? "autodev_control_api_unavailable"
        : mcpInventory.code;
    const message =
      mcpInventory === undefined
        ? "Control API MCP server inventory is unavailable for this view."
        : mcpInventory.message;
    return React.createElement(
      "div",
      {
        className: LIST_PANEL_CLASS,
        "data-mcp-inventory-status": "unavailable"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "MCP servers"
      ),
      windowNote,
      React.createElement(
        "div",
        { className: CALLOUT_WARNING_CLASS, role: "status" },
        React.createElement(
          "p",
          { className: "font-medium" },
          "MCP server inventory is unavailable"
        ),
        React.createElement("p", { className: "mt-1 text-xs" }, message),
        React.createElement(
          "p",
          { className: `mt-1 font-mono ${MUTED_META_CLASS}` },
          code
        )
      )
    );
  }

  const runtimeObserved =
    mcpInventory.runtime !== null &&
    mcpInventory.runtime.observedServers !== null;
  const rows = buildUsageMcpRows(mcpInventory.servers, mcpInventory.runtime);
  const exposedCount = rows.filter(
    (row) => row.configured && row.enabled !== false && row.roles.length > 0
  ).length;
  const usedCount = rows.filter(
    (row) =>
      row.usageState === "used" ||
      row.usageState === "used-with-errors" ||
      row.usageState === "observed-unconfigured"
  ).length;
  const exposedNeverUsedCount = rows.filter(
    (row) => row.usageState === "exposed-never-used"
  ).length;

  const columns: ColumnDef<DataTableFeatures, UsageMcpServerRow>[] = [
    {
      id: "name",
      header: "Server",
      cell: ({ row: { original: server } }) =>
        React.createElement(
          NavigationLink,
          {
            className: MONO_ID_LINK_CLASS,
            href: `/mcps/${encodeURIComponent(server.name)}`,
            title: server.name
          },
          server.name
        ),
      meta: { weight: 190 }
    },
    {
      id: "roles",
      header: "Exposed roles",
      cell: ({ row: { original: server } }) =>
        chipList({
          items: server.roles,
          emptyLabel: server.configured
            ? "No roles assigned"
            : "Not in catalog",
          testId: "usage-mcp-roles"
        }),
      meta: { align: "tokens", weight: 210 }
    },
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row: { original: server } }) =>
        React.createElement(StatusBadge, {
          status: server.enabled === null ? NOT_OBSERVED_STATUS : "configured",
          label:
            server.enabled === null
              ? NOT_OBSERVED_LABEL
              : server.enabled
                ? "Enabled"
                : "Disabled"
        }),
      meta: { weight: 130 }
    },
    {
      id: "usage",
      header: "Runtime use",
      cell: ({ row: { original: server } }) => mcpUsageBadge(server.usageState),
      meta: { weight: 185 }
    },
    {
      id: "calls",
      header: "Calls (since start)",
      cell: ({ row: { original: server } }) => formatCount(server.toolCalls),
      meta: { weight: 145 }
    },
    {
      id: "failures",
      header: "Failures (since start)",
      cell: ({ row: { original: server } }) => formatCount(server.failures),
      meta: { weight: 155 }
    }
  ];

  const tableProps: DataTableProps<UsageMcpServerRow> = {
    data: rows,
    columns,
    keyExtractor: (row) => row.name,
    emptyMessage: "No MCP servers are configured or observed.",
    label: "MCP servers"
  };

  return React.createElement(
    "div",
    {
      className: LIST_PANEL_CLASS,
      "data-mcp-inventory-status": runtimeObserved
        ? "observed"
        : "runtime-unavailable"
    },
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      "MCP servers"
    ),
    windowNote,
    mcpInventory.sourceValidity === false &&
      mcpInventory.validationIssues.length > 0
      ? React.createElement(
          "div",
          { className: "mb-3" },
          React.createElement(SourceValidationIssues, {
            issues: mcpInventory.validationIssues,
            testId: "usage-mcp-validation-issues",
            subject: "MCP source"
          })
        )
      : null,
    runtimeObserved
      ? React.createElement(
          "p",
          { className: `${MUTED_BODY_CLASS} mb-3` },
          `${COUNT_FORMATTER.format(mcpInventory.servers.length)} configured · ${COUNT_FORMATTER.format(exposedCount)} exposed · ${COUNT_FORMATTER.format(usedCount)} used · ${COUNT_FORMATTER.format(exposedNeverUsedCount)} exposed, never used`
        )
      : React.createElement(
          "p",
          { className: `${CALLOUT_WARNING_CLASS} mb-3`, role: "status" },
          mcpInventory.runtimeFailure === null
            ? "Runtime MCP observations are not attached; calls and failures are shown as Not observed."
            : `Runtime MCP observations are unavailable (${mcpInventory.runtimeFailure.code}): ${mcpInventory.runtimeFailure.message} Calls and failures are shown as Not observed.`
        ),
    React.createElement(DataTable<UsageMcpServerRow>, tableProps)
  );
}

function renderHistoricalMetrics(
  metrics: UsageMetricsData,
  mcpInventory: UsageMcpInventory | undefined
): React.JSX.Element {
  const requestsByRole = metrics.requestsByRole;
  const requestsByModel = metrics.requestsByModel;
  const attemptsByProvider = metrics.attemptsByProvider;
  const attemptsByModel = metrics.attemptsByModel;
  const attemptErrorsByProvider = metrics.attemptErrorsByProvider;
  const callsByTool = metrics.callsByTool;
  const skillEventsByEvent = metrics.skillEventsByEvent;
  const compactionUnsupportedFilters =
    metrics.contextCompactionsUnsupportedFilters;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Requests & model usage"
      ),
      React.createElement(
        StatGrid,
        { columns: 4 },
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
          title: "Estimated Cost",
          value: formatEstimatedCost(metrics.estimatedCostUsd),
          subtitle: "OpenLIT pricing estimate; not billed cost"
        })
      )
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Attempt latency"
      ),
      // Where an attempt's time went: its whole duration, then -- from the
      // bridges that report it -- the wait for the provider and the time on it.
      React.createElement(
        StatGrid,
        { columns: 3 },
        React.createElement(StatCard, {
          title: "P95 Latency",
          value: formatLatency(metrics.p95LatencyMs),
          subtitle: "Physical attempt duration"
        }),
        React.createElement(StatCard, {
          title: "P95 Provider Queue",
          value: formatLatency(metrics.p95ProviderQueueMs),
          subtitle: "Waiting for the provider, e.g. a free browser tab"
        }),
        React.createElement(StatCard, {
          title: "P95 Provider On-site",
          value: formatLatency(metrics.p95ProviderSiteMs),
          subtitle: "On the provider once it took the attempt"
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
          "h3",
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
          barClass: CHART_PALETTE.series1.bar,
          valueClass: CHART_PALETTE.series1.value
        })
      ),
      React.createElement(
        "div",
        {
          className: LIST_PANEL_CLASS
        },
        React.createElement(
          "h3",
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
          barClass: CHART_PALETTE.series2.bar,
          valueClass: CHART_PALETTE.series2.value
        })
      ),
      React.createElement(
        "div",
        {
          className: LIST_PANEL_CLASS
        },
        React.createElement(
          "h3",
          {
            className: SECTION_HEADING_CLASS
          },
          "Requests by Model"
        ),
        React.createElement(BarChart, {
          data:
            requestsByModel === null || requestsByModel === undefined
              ? null
              : requestsByModel.map((item) => ({
                  label: formatDimension(item.model),
                  value: item.count,
                  valueText: formatCount(item.count)
                })),
          label: "Logical routed requests by model",
          notObservedMessage: "Requested model telemetry not observed.",
          emptyMessage: "No logical requests were observed in this time range.",
          barClass: CHART_PALETTE.series1.bar,
          valueClass: CHART_PALETTE.series1.value
        })
      ),
      React.createElement(
        "div",
        {
          className: LIST_PANEL_CLASS
        },
        React.createElement(
          "h3",
          {
            className: SECTION_HEADING_CLASS
          },
          "Physical Attempts by Model"
        ),
        React.createElement(BarChart, {
          data:
            attemptsByModel === null || attemptsByModel === undefined
              ? null
              : attemptsByModel.map((item) => ({
                  label: formatDimension(item.model),
                  value: item.count,
                  valueText: formatCount(item.count)
                })),
          label: "Physical attempts by model",
          notObservedMessage: "Served model attempt telemetry not observed.",
          emptyMessage:
            "No provider attempts were observed in this time range.",
          barClass: CHART_PALETTE.series2.bar,
          valueClass: CHART_PALETTE.series2.value
        })
      )
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Reliability & context"
      ),
      React.createElement(
        "div",
        { className: PAGE_SECTION_STACK_CLASS },
        compactionUnsupportedFilters.length > 0
          ? React.createElement(
              "p",
              {
                className: CALLOUT_WARNING_CLASS,
                role: "status",
                "data-context-compaction-scope": NOT_APPLICABLE_STATUS
              },
              `Context compaction data is unavailable for the selected ${compactionUnsupportedFilters.join(" and ")} filter${compactionUnsupportedFilters.length === 1 ? "" : "s"}; this source attributes compactions to logical requests, not those dimensions.`
            )
          : null,
        metrics.contextCompactionsBreakdownsPartial
          ? React.createElement(
              "p",
              {
                className: CALLOUT_WARNING_CLASS,
                role: "status",
                "data-context-compaction-breakdowns": "partial"
              },
              "A compaction breakdown reached its 20-row limit; the shown categories may be partial."
            )
          : null,
        React.createElement(
          StatGrid,
          { columns: 4 },
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
            value: formatSignalCount(
              metrics.contextCompactions,
              compactionUnsupportedFilters
            ),
            subtitle: "Source-confirmed logical requests"
          }),
          React.createElement(StatCard, {
            title: "Compactions per Request",
            value:
              metrics.contextCompactionRatePercent === null &&
              compactionUnsupportedFilters.length > 0
                ? NOT_APPLICABLE_LABEL
                : formatCacheRate(metrics.contextCompactionRatePercent),
            subtitle: "Compactions / logical routed requests"
          })
        ),
        React.createElement(
          "div",
          { className: LIST_PANEL_CLASS },
          React.createElement(
            "h3",
            { className: SECTION_HEADING_CLASS },
            "Context Compactions Over Time"
          ),
          React.createElement(BarChart, {
            data:
              metrics.contextCompactionsOverTime === null
                ? null
                : metrics.contextCompactionsOverTime.map((item) => ({
                    label: item.bucket,
                    displayLabel: bucketDisplay(
                      item.bucket,
                      "Context compaction time bucket"
                    ),
                    value: item.count,
                    valueText: formatCount(item.count)
                  })),
            label: "Source-confirmed context compactions by time bucket",
            notObservedMessage: panelUnavailableMessage(
              "Compaction time-series data",
              compactionUnsupportedFilters
            ),
            emptyMessage: CONTEXT_COMPACTION_EMPTY_MESSAGE,
            barClass: CHART_PALETTE.series3.bar,
            valueClass: CHART_PALETTE.series3.value
          })
        ),
        React.createElement(
          "div",
          { className: gridRowClass(2, "gap-6") },
          React.createElement(
            "div",
            { className: LIST_PANEL_CLASS },
            React.createElement(
              "h3",
              { className: SECTION_HEADING_CLASS },
              "Context Compactions by Workspace"
            ),
            React.createElement(BarChart, {
              data:
                metrics.contextCompactionsByWorkspace === null
                  ? null
                  : metrics.contextCompactionsByWorkspace.map((item) => ({
                      label: formatDimension(item.name),
                      value: item.count,
                      valueText: formatCount(item.count)
                    })),
              label: "Source-confirmed context compactions by workspace",
              notObservedMessage: panelUnavailableMessage(
                "Workspace compaction breakdown",
                compactionUnsupportedFilters
              ),
              emptyMessage: CONTEXT_COMPACTION_EMPTY_MESSAGE,
              barClass: CHART_PALETTE.series1.bar,
              valueClass: CHART_PALETTE.series1.value
            })
          ),
          React.createElement(
            "div",
            { className: LIST_PANEL_CLASS },
            React.createElement(
              "h3",
              { className: SECTION_HEADING_CLASS },
              "Context Compactions by Requested Model"
            ),
            React.createElement(BarChart, {
              data:
                metrics.contextCompactionsByModel === null
                  ? null
                  : metrics.contextCompactionsByModel.map((item) => ({
                      label: formatDimension(item.name),
                      value: item.count,
                      valueText: formatCount(item.count)
                    })),
              label: "Source-confirmed context compactions by requested model",
              notObservedMessage: panelUnavailableMessage(
                "Requested-model compaction breakdown",
                compactionUnsupportedFilters
              ),
              emptyMessage: CONTEXT_COMPACTION_EMPTY_MESSAGE,
              barClass: CHART_PALETTE.series2.bar,
              valueClass: CHART_PALETTE.series2.value
            })
          ),
          React.createElement(
            "div",
            { className: LIST_PANEL_CLASS },
            React.createElement(
              "h3",
              { className: SECTION_HEADING_CLASS },
              "Context Compactions by Agent Role"
            ),
            React.createElement(BarChart, {
              data:
                metrics.contextCompactionsByAgent === null
                  ? null
                  : metrics.contextCompactionsByAgent.map((item) => ({
                      label: formatDimension(item.name),
                      value: item.count,
                      valueText: formatCount(item.count)
                    })),
              label: "Source-confirmed context compactions by agent role",
              notObservedMessage: panelUnavailableMessage(
                "Agent-role compaction breakdown",
                compactionUnsupportedFilters
              ),
              emptyMessage: CONTEXT_COMPACTION_EMPTY_MESSAGE,
              barClass: CHART_PALETTE.series4.bar,
              valueClass: CHART_PALETTE.series4.value
            })
          ),
          React.createElement(
            "div",
            { className: LIST_PANEL_CLASS },
            React.createElement(
              "h3",
              { className: SECTION_HEADING_CLASS },
              "Context Compactions by Provider"
            ),
            React.createElement(BarChart, {
              data:
                metrics.contextCompactionsByProvider === null
                  ? null
                  : metrics.contextCompactionsByProvider.map((item) => ({
                      label: formatDimension(item.name),
                      value: item.count,
                      valueText: formatCount(item.count)
                    })),
              label:
                "Source-confirmed context compactions by the provider that served them",
              notObservedMessage: panelUnavailableMessage(
                "Provider compaction breakdown",
                compactionUnsupportedFilters
              ),
              emptyMessage: CONTEXT_COMPACTION_EMPTY_MESSAGE,
              barClass: CHART_PALETTE.series5.bar,
              valueClass: CHART_PALETTE.series5.value
            })
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
            barClass: CHART_PALETTE.series5.bar,
            valueClass: CHART_PALETTE.series5.value
          })
        )
      )
    ),
    renderProviderHopMetrics(metrics),
    React.createElement(
      "div",
      { className: LIST_PANEL_CLASS },
      React.createElement(
        "h2",
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
        barClass: CHART_PALETTE.series4.bar,
        valueClass: CHART_PALETTE.series4.value
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
        "h3",
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
        barClass: CHART_PALETTE.series3.bar,
        valueClass: CHART_PALETTE.series3.value
      })
    ),
    renderMcpServersPanel(mcpInventory),
    renderGitChangeMetrics(metrics.gitChanges)
  );
}

/** OpenLIT time-series buckets are UTC wall-clock labels, not local times. */
function timeBucketInstant(bucket: string): string | null {
  if (
    (bucket.length !== 16 && bucket.length !== 19) ||
    (bucket[10] !== " " && bucket[10] !== "T") ||
    bucket[13] !== ":" ||
    (bucket.length === 19 && bucket[16] !== ":")
  ) {
    return null;
  }
  const digitPositions = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15];
  if (bucket.length === 19) digitPositions.push(17, 18);
  if (
    digitPositions.some((index) => {
      const char = bucket[index];
      return char === undefined || char < "0" || char > "9";
    })
  ) {
    return null;
  }
  const wallClock = `${bucket.slice(0, 10)}T${bucket.slice(11, 16)}:${bucket.length === 19 ? bucket.slice(17, 19) : "00"}`;
  const date = new Date(`${wallClock}Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 19) !== wallClock
  ) {
    return null;
  }
  return `${wallClock}Z`;
}

function bucketDisplay(
  bucket: string,
  label: string
): React.ReactNode | undefined {
  const value = timeBucketInstant(bucket);
  return value === null
    ? undefined
    : React.createElement(InstantDisplay, { value, label });
}

function usageMetricsObserved(metrics: UsageMetricsData | undefined): boolean {
  if (metrics === undefined) return false;
  const signals: readonly unknown[] = [
    metrics.logicalRequests,
    metrics.totalInputTokens,
    metrics.totalOutputTokens,
    metrics.cacheReadRate,
    metrics.p95LatencyMs,
    metrics.p95ProviderQueueMs,
    metrics.p95ProviderSiteMs,
    metrics.estimatedCostUsd,
    metrics.physicalAttempts,
    metrics.mcpCalls,
    metrics.p95McpDurationMs,
    metrics.mcpErrors,
    metrics.failedAttempts,
    metrics.attemptErrorsByProvider,
    metrics.contextCompactions,
    metrics.contextCompactionRatePercent,
    metrics.contextCompactionsOverTime,
    metrics.contextCompactionsByWorkspace,
    metrics.contextCompactionsByModel,
    metrics.contextCompactionsByAgent,
    metrics.contextCompactionsByProvider,
    metrics.providerHops,
    metrics.providerHopRatePercent,
    metrics.providerHopsOverTime,
    metrics.providerHopsByRoute,
    metrics.providerHopsByProvider,
    metrics.providerHopsByRole,
    metrics.providerHopsByWorkspace,
    metrics.providerHopsByReason,
    metrics.skillEventsByEvent,
    metrics.requestsByRole,
    metrics.requestsByModel,
    metrics.attemptsByProvider,
    metrics.attemptsByModel,
    metrics.callsByTool
  ];
  return (
    metrics.gitChanges.status === "observed" ||
    signals.some((value) => value !== null)
  );
}

export function UsageView({
  metrics,
  filterOptions = UNKNOWN_FILTER_OPTIONS,
  traceList,
  traceLookup,
  selection = DEFAULT_SELECTION,
  activeSessions,
  sessionScope,
  sessionView,
  fleetView,
  mcpInventory
}: UsageViewProps): React.JSX.Element {
  const selectedValues = selection.values;
  const todayUtc = new Date().toISOString().slice(0, 10);
  // The live scope has no interval, so the custom bounds do not describe
  // anything here. Rendering them would offer an operator a control that cannot
  // affect the reading in front of them.
  const isActiveSessions = selection.range === "ACTIVE_SESSIONS";
  const observed = usageMetricsObserved(metrics);
  // A session scope replaces the fleet body entirely: the page is about one
  // session, and the fleet-wide metrics would be a different question answered
  // beside it.
  const isSessionScoped = sessionScope !== undefined;
  const leftoverFleetFilters = Object.entries(selectedValues).filter(
    ([, values]) => (values ?? []).length > 0
  );

  return React.createElement(
    PageBody,
    {
      feature: "usage",
      attributes: {
        "data-usage-observed": observed ? "true" : "false",
        "data-usage-session-scoped": isSessionScoped ? "true" : "false"
      }
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
      React.createElement(TextField, {
        id: "usage-session-id",
        name: "sessionId",
        label: "Session ID:",
        hideLabel: true,
        defaultValue: sessionScope?.rawSessionId ?? "",
        placeholder: "Session or thread ID",
        maxLength: 128,
        className: "min-w-48 basis-56",
        testId: "usage-session-id"
      }),
      isSessionScoped
        ? React.createElement(
            NavigationLink,
            {
              href: usageHref(selection),
              className: ACTION_LINK_CLASS,
              dataAttributes: { "data-usage-clear-session": "true" }
            },
            "Clear session"
          )
        : null,
      isSessionScoped
        ? null
        : renderFilterControls(isActiveSessions, filterOptions, selectedValues)
    ),
    isSessionScoped && leftoverFleetFilters.length > 0
      ? React.createElement(
          "p",
          { className: CALLOUT_WARNING_CLASS, role: "status" },
          `This page is scoped to one session, so the fleet filters (${leftoverFleetFilters
            .map(([name]) => name)
            .join(", ")}) are not applied. Clear the session to use them.`
        )
      : null,
    isSessionScoped
      ? sessionView
      : React.createElement(
          React.Fragment,
          null,
          fleetView,
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
                  renderHistoricalMetrics(metrics, mcpInventory),
                  renderRecentAttempts(traceList, selection)
                )
        )
  );
}
