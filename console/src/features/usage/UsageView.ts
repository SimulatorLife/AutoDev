import type {
  UsageFilterOptions,
  UsageFilterSelection,
  UsageMetricsData
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { BarChart } from "../../components/charts/BarChart.ts";
import { FilterBar } from "../../components/filters/FilterBar.ts";
import {
  FIELD_CONTROL_CLASS,
  SelectField
} from "../../components/forms/SelectField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { gridRowClass, StatGrid } from "../../components/panels/DetailGrid.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";

/**
 * Observability Usage view.
 *
 * Per the AutoDev Console target, the Usage dashboard renders logical-request,
 * token, cache-read, latency, attempt, and MCP-tool-call telemetry. Metrics and
 * filter options are supplied by the server-side OpenLIT adapter; missing or
 * malformed observations remain explicitly unknown rather than defaulting to
 * sample counts, rates, or healthy values.
 *
 * Filter selections are GET form state in the URL. The server page uses that
 * state to query OpenLIT; this component never performs browser-side telemetry
 * requests or infers filter values.
 */

export interface UsageViewProps {
  readonly metrics?: UsageMetricsData | undefined;
  readonly filterOptions?: UsageFilterOptions | undefined;
  readonly selection?: UsageFilterSelection | undefined;
}

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

const FILTER_GROUP_CLASS =
  "flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-fg-muted";

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

function formatDimension(value: string): string {
  return value.trim().length === 0 ? "Not attributed" : value;
}

const DEFAULT_SELECTION: UsageFilterSelection = {
  range: "24H",
  values: {}
};

const UNKNOWN_FILTER_OPTIONS: UsageFilterOptions = {
  workspace: null,
  provider: null,
  model: null,
  agent: null,
  skill: null
};

function renderFilterSelect(
  name: "workspace" | "provider" | "model" | "agent",
  label: string,
  options: readonly string[] | null,
  selected: readonly string[]
): React.JSX.Element {
  if (options === null) {
    return React.createElement(
      "div",
      { className: FILTER_GROUP_CLASS },
      React.createElement(SelectField, {
        name: `${name}-unobserved`,
        label: `${label}:`,
        options: [{ value: "", label: "Not observed" }],
        disabled: true,
        dataAttributes: { "data-filter-options-observed": "false" }
      }),
      ...selected.map((value) =>
        React.createElement("input", {
          key: value,
          type: "hidden",
          name,
          value
        })
      )
    );
  }

  const values = [...new Set([...options, ...selected])];
  const selectedValues = selected.length === 0 ? [""] : selected;
  return React.createElement(
    "div",
    { className: FILTER_GROUP_CLASS },
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

export function UsageView({
  metrics,
  filterOptions = UNKNOWN_FILTER_OPTIONS,
  selection = DEFAULT_SELECTION
}: UsageViewProps): React.JSX.Element {
  const safeMetrics = metrics;
  const requestsByRole = safeMetrics?.requestsByRole;
  const attemptsByProvider = safeMetrics?.attemptsByProvider;
  const callsByTool = safeMetrics?.callsByTool;
  const selectedValues = selection.values;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const observed =
    safeMetrics !== undefined &&
    safeMetrics !== null &&
    Object.values(safeMetrics).some((value) => value !== null);

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
        summary: "Filters are stored in the URL"
      },
      React.createElement(
        "div",
        { className: "flex min-w-0 flex-wrap gap-3 items-center" },
        React.createElement(
          "div",
          { className: FILTER_GROUP_CLASS },
          React.createElement(SelectField, {
            name: "range",
            label: "Time range:",
            defaultValue: selection.range,
            options: [
              { value: "24H", label: "Last 24 hours" },
              { value: "7D", label: "Last 7 days" },
              { value: "1M", label: "Last 30 days" },
              { value: "3M", label: "Last 90 days" },
              { value: "CUSTOM", label: "Custom range" }
            ]
          })
        ),
        React.createElement(
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
            { className: FILTER_GROUP_CLASS },
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
            { className: FILTER_GROUP_CLASS },
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
        )
      ),
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
        "Router & GenAI Observability"
      ),
      React.createElement(
        StatGrid,
        { columns: 4 },
        React.createElement(StatCard, {
          title: "Logical Routed Requests",
          value: formatCount(safeMetrics?.logicalRequests ?? null),
          subtitle: "autodev.routed_request"
        }),
        React.createElement(StatCard, {
          title: "Input / Output Tokens",
          value: `${formatTokenCount(safeMetrics?.totalInputTokens ?? null)} / ${formatTokenCount(safeMetrics?.totalOutputTokens ?? null)}`,
          subtitle: "Physical attempt totals"
        }),
        React.createElement(StatCard, {
          title: "Cache-read Rate",
          value: formatCacheRate(safeMetrics?.cacheReadRate ?? null),
          subtitle: "Cached / Input tokens"
        }),
        React.createElement(StatCard, {
          title: "P95 Latency",
          value: formatLatency(safeMetrics?.p95LatencyMs ?? null),
          subtitle: "Physical attempt duration"
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
        "Model Context Protocol Shim Metrics"
      ),
      React.createElement(
        StatGrid,
        { columns: 3 },
        React.createElement(StatCard, {
          title: "MCP Tool Calls",
          value: formatCount(safeMetrics?.mcpCalls ?? null),
          subtitle: "Shim tools/call round trips"
        }),
        React.createElement(StatCard, {
          title: "P95 Tool-call Duration",
          value: formatLatency(safeMetrics?.p95McpDurationMs ?? null),
          subtitle: "Shim-owned round trip"
        }),
        React.createElement(StatCard, {
          title: "MCP Tool Errors",
          value: formatCount(safeMetrics?.mcpErrors ?? null),
          subtitle: "Errored tools/call spans"
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
