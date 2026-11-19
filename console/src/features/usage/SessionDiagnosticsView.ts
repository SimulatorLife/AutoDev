/**
 * The session-scoped Usage view.
 *
 * A session id in the top filter bar scopes the whole `/usage` page to one
 * session: its rollouts, its router requests, its failures and its spans. The
 * five tabs are the same report read five ways, and every one of them is
 * server-rendered from the Control API's diagnostics routes -- there is no
 * browser-side telemetry request and no second copy of the diagnostics logic.
 *
 * The page is a server component on purpose. The previous session lookup was a
 * client island that posted to a browser proxy route and could only ever show
 * a fixed 200-span sample of one metric source; a session's evidence lives in
 * the rollouts, the router logs and the span store together, and it has to be
 * read server-side to be read at all.
 */

import {
  type SessionDiagnosticsReport,
  type SessionRouterEventRow,
  type SessionRouterSummary,
  type SessionThreadItem,
  type SessionThreadTrace,
  TOOL_FAILURE_CATEGORIES,
  type ToolFailureCategory,
  type UsageSessionEvidence,
  type UsageSessionSpanSummary
} from "@simulatorlife/autodev-core";
import { type ColumnDef } from "@tanstack/react-table";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  BarChart,
  type BarChartDatum
} from "../../components/charts/BarChart.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PAGE_SECTION_STACK_CLASS } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { Pagination } from "../../components/navigation/Pagination.ts";
import {
  DetailGrid,
  DetailValue,
  StatGrid
} from "../../components/panels/DetailGrid.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import { instantLabel } from "../../components/ui/instant.ts";
import {
  ACTION_LINK_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";

/** The tabs the session-scoped page offers. */
export const SESSION_TABS = [
  { id: "overview", label: "Overview" },
  { id: "threads", label: "Threads & Turns" },
  { id: "failures", label: "Failures & Hooks" },
  { id: "requests", label: "Router Requests" },
  { id: "spans", label: "OTel Spans" }
] as const;

/**
 * A panel's own stack: the blocks inside one panel, at the tighter rhythm.
 *
 * The page's top-level sections use the shared section stack; the content
 * inside a panel is a tighter column, so it gets its own name rather than
 * repeating the same class string.
 */
const PANEL_CONTENT_STACK_CLASS = "flex flex-col gap-3";

/** The column header every time-carrying table uses. */
const TIME_UTC_HEADER = "Time (UTC)";

/** The session-scoped page's own state. */
export interface SessionDiagnosticsViewState {
  readonly sessionId: string;
  readonly range: string;
  readonly tab: string;
  readonly spanOffset: number;
  readonly spanLimit: 50 | 100 | 200;
  readonly spanSort: "desc" | "asc";
  readonly eventsOffset: number;
  readonly eventsLimit: 50 | 100;
  readonly itemsOffset: number;
  readonly itemsLimit: 50 | 100;
  readonly threadId: string | undefined;
  readonly failureCategory: ToolFailureCategory | undefined;
}

/** A read that did not produce evidence, and why. */
export interface SessionDiagnosticsFailure {
  readonly code: string;
  readonly message: string;
}

export interface SessionDiagnosticsViewProps {
  readonly state: SessionDiagnosticsViewState;
  readonly report: SessionDiagnosticsReport | null;
  readonly diagnosticsFailure: SessionDiagnosticsFailure | null;
  readonly spans: UsageSessionEvidence | null;
  readonly spansFailure: SessionDiagnosticsFailure | null;
  readonly spanHrefFor: (offset: number) => string;
}

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});
const COST_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
});
const CHART_PALETTE = {
  series1: { bar: "bg-chart-1", value: "text-chart-1" },
  series2: { bar: "bg-chart-2", value: "text-chart-2" },
  series3: { bar: "bg-chart-3", value: "text-chart-3" },
  series4: { bar: "bg-chart-4", value: "text-chart-4" },
  series5: { bar: "bg-chart-5", value: "text-chart-5" }
} as const;
const NO_FAILURES_MESSAGE =
  "No tool call failed in this session's observed rollouts.";
const NO_EVENTS_MESSAGE =
  "No router event was observed for this session in the router logs.";
const NO_ITEMS_MESSAGE =
  "No rollout item was observed for this session.";
const NO_SPANS_MESSAGE =
  "No span was observed for this session in the telemetry store.";

function count(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : COUNT_FORMATTER.format(value);
}

function tokens(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : TOKEN_FORMATTER.format(value);
}

function percent(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : `${value}%`;
}

function cost(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : COST_FORMATTER.format(value);
}

function chartData(
  entries: Readonly<Record<string, number>>
): readonly BarChartDatum[] {
  return Object.entries(entries)
    .map(([name, value]) => ({
      label: name,
      value,
      valueText: COUNT_FORMATTER.format(value)
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * The URL of one view of the session.
 *
 * Every control in the session view is a link to another URL rather than a
 * browser-side state change, so the page stays addressable, bookmarkable and
 * reachable by the back button -- and every tab keeps the session scope.
 */
export function sessionViewHref(
  state: SessionDiagnosticsViewState,
  changes: Readonly<Record<string, string | number | undefined>>
): string {
  const params = new URLSearchParams({
    range: state.range,
    sessionId: state.sessionId,
    tab: state.tab
  });
  const merged: Record<string, string | number | undefined> = {
    threadId: state.threadId,
    failureCategory: state.failureCategory,
    ...changes
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  return `/usage?${params.toString()}`;
}

function panel(
  title: string,
  children: React.ReactNode
): React.JSX.Element {
  return React.createElement(
    "section",
    { className: PANEL_CONTENT_STACK_CLASS },
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      title
    ),
    React.createElement("div", { className: LIST_PANEL_CLASS }, children)
  );
}

/* ------------------------------------------------------------------ */
/* The session context header.                                         */
/* ------------------------------------------------------------------ */

function renderContextHeader(
  report: SessionDiagnosticsReport
): React.JSX.Element {
  const root = report.threads.find((thread) => thread.parentId === null);
  const workspace = root?.cwd ?? null;
  const started = report.threads
    .map((thread) => thread.start)
    .filter((value): value is string => typeof value === "string")
    .sort()[0];
  const ended = report.threads
    .map((thread) => thread.end)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);
  const openThread = report.live?.openThreads.some(
    (thread) => thread.id === root?.id
  );
  return React.createElement(
    DetailGrid,
    { columns: 3 },
    React.createElement(
      DetailValue,
      { label: "Session" },
      report.rootSessionId ?? report.requestedId
    ),
    React.createElement(
      DetailValue,
      { label: "Workspace" },
      workspace ?? NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Threads" },
      String(report.aggregates.threadCount)
    ),
    React.createElement(
      DetailValue,
      { label: "Started (UTC)" },
      started ? instantLabel(started) : NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Ended (UTC)" },
      ended ? instantLabel(ended) : NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "CLI version" },
      root?.cliVersion ?? NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Live" },
      openThread === true
        ? React.createElement(Tag, { children: "Open turn" })
        : React.createElement(Tag, { children: "Not running" })
    ),
    React.createElement(
      DetailValue,
      { label: "Matched by" },
      report.matchedByThreadId
        ? "A child thread id; the whole session is shown."
        : "The session root."
    ),
    React.createElement(
      DetailValue,
      { label: "Resolved from" },
      report.requestedId
    )
  );
}

function renderAlerts(report: SessionDiagnosticsReport): React.JSX.Element[] {
  const alerts: React.JSX.Element[] = [];
  if (!report.found) {
    alerts.push(
      React.createElement(
        "p",
        { className: CALLOUT_WARNING_CLASS, role: "status" },
        "No rollout matched this session id under the Codex home's sessions or archived_sessions directories."
      )
    );
  }
  if (report.bridgeAlerts.length > 0) {
    alerts.push(
      React.createElement(
        "p",
        { className: CALLOUT_WARNING_CLASS, role: "status" },
        `${report.bridgeAlerts.length} bridge log(s) reported problems in the observed tail.`
      )
    );
  }
  const drift = report.live?.drift ?? null;
  if (drift && drift.differing.length > 0) {
    alerts.push(
      React.createElement(
        "p",
        { className: CALLOUT_WARNING_CLASS, role: "status" },
        `${drift.differing.length} installed runtime file(s) differ from the checkout; the running services execute the installed copies.`
      )
    );
  }
  const liveCount = report.live?.router.canonicalLiveCount ?? null;
  const openThreads = report.live?.openThreads.length ?? null;
  if (liveCount !== null && openThreads !== null && liveCount !== openThreads) {
    alerts.push(
      React.createElement(
        "p",
        { className: CALLOUT_WARNING_CLASS, role: "status" },
        `The router reports ${liveCount} live agents while ${openThreads} thread(s) have an open turn.`
      )
    );
  }
  return alerts;
}

/* ------------------------------------------------------------------ */
/* Overview.                                                           */
/* ------------------------------------------------------------------ */

function threadColumns(
  state: SessionDiagnosticsViewState
): readonly ColumnDef<SessionThreadTrace, unknown>[] {
  return [
    {
      id: "thread",
      header: "Thread",
      cell: ({ row: { original: thread } }) =>
        React.createElement(
          NavigationLink,
          {
            href: sessionViewHref(state, {
              tab: "threads",
              threadId: thread.id,
              itemsOffset: 0
            }),
            className: ACTION_LINK_CLASS
          },
          thread.nickname ?? thread.id
        ),
      meta: { weight: 200, align: "tokens" }
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row: { original: thread } }) => thread.role ?? NOT_OBSERVED_LABEL,
      meta: { weight: 90, align: "tokens" }
    },
    {
      id: "model",
      header: "Model",
      cell: ({ row: { original: thread } }) => thread.model ?? NOT_OBSERVED_LABEL,
      meta: { weight: 130, align: "tokens" }
    },
    {
      id: "turns",
      header: "Turns",
      cell: ({ row: { original: thread } }) => String(thread.turns.length),
      meta: { weight: 70, align: "tokens" }
    },
    {
      id: "tokens",
      header: "Tokens",
      cell: ({ row: { original: thread } }) =>
        tokens(thread.efficiency?.tokens.totalTokens ?? null),
      meta: { weight: 90, align: "tokens" }
    },
    {
      id: "cache",
      header: "Cache %",
      cell: ({ row: { original: thread } }) =>
        percent(thread.efficiency?.tokens.cacheHitPct ?? null),
      meta: { weight: 80, align: "tokens" }
    },
    {
      id: "compactions",
      header: "Compactions",
      cell: ({ row: { original: thread } }) =>
        String(thread.efficiency?.compaction.count ?? 0),
      meta: { weight: 90, align: "tokens" }
    },
    {
      id: "failures",
      header: "Failures",
      cell: ({ row: { original: thread } }) =>
        String(thread.toolFailures.length),
      meta: { weight: 80, align: "tokens" }
    },
    {
      id: "skills",
      header: "Skills",
      cell: ({ row: { original: thread } }) =>
        `${thread.efficiency?.prompt.skillsLoaded ?? 0} loaded / ${
          thread.efficiency?.prompt.skillsRead.length ?? 0
        } read`,
      meta: { weight: 150, align: "tokens" }
    }
  ];
}

function renderOverview(
  report: SessionDiagnosticsReport,
  spans: UsageSessionEvidence | null,
  state: SessionDiagnosticsViewState
): React.JSX.Element[] {
  const aggregates = report.aggregates;
  const byProvider = chartData(
    Object.fromEntries(
      Object.entries(aggregates.byProvider).map(([provider, stats]) => [
        provider,
        stats.requests
      ])
    )
  );
  const failuresByCategory = chartData(aggregates.toolFailuresByCategory);
  const skippedByReason = chartData(aggregates.routerSkippedByReason);
  const tools = chartData(aggregates.toolCallsByName);
  const turns = chartData(aggregates.turnsByOutcome);

  return [
    React.createElement(
      "div",
      { className: PAGE_SECTION_STACK_CLASS },
      panel(
        "Session tokens",
        React.createElement(
          StatGrid,
          { columns: 4 },
          React.createElement(StatCard, {
            title: "Total tokens",
            value: tokens(aggregates.totalTokens),
            subtitle: `${count(aggregates.inputTokens)} in / ${count(
              aggregates.outputTokens
            )} out`
          }),
          React.createElement(StatCard, {
            title: "Reasoning share",
            value: percent(aggregates.reasoningPct),
            subtitle: `${count(aggregates.reasoningOutputTokens)} reasoning tokens`
          }),
          React.createElement(StatCard, {
            title: "Cache-read rate",
            value: percent(aggregates.cacheHitPct),
            subtitle: `${count(aggregates.cachedInputTokens)} cached tokens`
          }),
          React.createElement(StatCard, {
            title: "Peak input",
            value: tokens(aggregates.peakInputTokens),
            subtitle: `${count(aggregates.cacheDrops)} cache drop(s)`
          })
        )
      ),
      panel(
        "Router and turns",
        React.createElement(
          StatGrid,
          { columns: 4 },
          React.createElement(StatCard, {
            title: "Router requests",
            value: count(aggregates.routerRequests),
            subtitle: `${count(aggregates.routerFailures)} failed`
          }),
          React.createElement(StatCard, {
            title: "Router skipped",
            value: count(aggregates.routerSkippedTotal),
            subtitle: `${count(aggregates.routerRetries)} retried`
          }),
          React.createElement(StatCard, {
            title: "Turns",
            value: count(aggregates.turnsTotal),
            subtitle: `${count(aggregates.gapsCount)} gap(s) of 60s or more`
          }),
          React.createElement(StatCard, {
            title: "Estimated cost",
            value: cost(spans?.estimatedCostUsd ?? null),
            subtitle: "OpenLIT's pricing estimate for the session"
          })
        )
      ),
      panel(
        "Context, prompts and tools",
        React.createElement(
          StatGrid,
          { columns: 4 },
          React.createElement(StatCard, {
            title: "Compactions",
            value: count(aggregates.compactions),
            subtitle: `${count(aggregates.contextCompactedEvents)} context_compacted events`
          }),
          React.createElement(StatCard, {
            title: "Largest replacement",
            value: count(aggregates.maxReplacementItems),
            subtitle: `${count(aggregates.maxReplacementBytes)} bytes, ${count(
              aggregates.maxReplacementImages
            )} image(s)`
          }),
          React.createElement(StatCard, {
            title: "Prompt overhead",
            value: count(aggregates.maxInitialDeveloperBytes),
            subtitle: `${count(aggregates.maxSkillsCatalogBytes)} bytes of skill catalog`
          }),
          React.createElement(StatCard, {
            title: "Tool calls",
            value: count(aggregates.toolCallsTotal),
            subtitle: `${count(aggregates.toolFailuresTotal)} failed, ${count(
              aggregates.preToolUseBlocks
            )} hook-blocked`
          })
        )
      ),
      panel(
        "Requests by provider",
        React.createElement(BarChart, {
          data: byProvider,
          label: "Requests by provider",
          notObservedMessage: "The router logs reported no request for this session.",
          emptyMessage: "The router logs reported no request for this session.",
          barClass: CHART_PALETTE.series1.bar
        })
      ),
      panel(
        "Turns by outcome",
        React.createElement(BarChart, {
          data: turns,
          label: "Turns by outcome",
          notObservedMessage: "No turn outcome was observed.",
          emptyMessage: "No turn outcome was observed.",
          barClass: CHART_PALETTE.series2.bar
        })
      ),
      panel(
        "Top tool calls",
        React.createElement(BarChart, {
          data: tools.slice(0, 10),
          label: "Top tool calls",
          notObservedMessage: "No tool call was observed.",
          emptyMessage: "No tool call was observed.",
          barClass: CHART_PALETTE.series3.bar
        })
      ),
      panel(
        "Tool failures by category",
        React.createElement(BarChart, {
          data: failuresByCategory,
          label: "Tool failures by category",
          notObservedMessage: NO_FAILURES_MESSAGE,
          emptyMessage: NO_FAILURES_MESSAGE,
          barClass: CHART_PALETTE.series4.bar
        })
      ),
      skippedByReason.length > 0
        ? panel(
            "Router skips by reason",
            React.createElement(BarChart, {
              data: skippedByReason,
              label: "Router skips by reason",
              notObservedMessage: "No router request was skipped.",
              emptyMessage: "No router request was skipped.",
              barClass: CHART_PALETTE.series5.bar
            })
          )
        : React.createElement("div"),
      panel(
        "Threads",
        React.createElement<DataTableProps<SessionThreadTrace>>(DataTable, {
          data: report.threads,
          columns: threadColumns(state),
          keyExtractor: (thread) => thread.id,
          emptyMessage: "No thread was observed for this session.",
          label: "Session threads"
        })
      )
    )
  ];
}

/* ------------------------------------------------------------------ */
/* Threads & Turns.                                                    */
/* ------------------------------------------------------------------ */

function turnColumns(): readonly ColumnDef<
  SessionThreadTrace["turns"][number],
  unknown
>[] {
  return [
    {
      id: "turn",
      header: "Turn",
      cell: ({ row: { original: turn } }) => turn.turnId || NOT_OBSERVED_LABEL,
      meta: { weight: 160, align: "tokens" }
    },
    {
      id: "started",
      header: "Started (UTC)",
      cell: ({ row: { original: turn } }) =>
        turn.started ? instantLabel(turn.started) : NOT_OBSERVED_LABEL,
      meta: { weight: 170, align: "tokens" }
    },
    {
      id: "ended",
      header: "Ended (UTC)",
      cell: ({ row: { original: turn } }) =>
        turn.ended ? instantLabel(turn.ended) : "open",
      meta: { weight: 170, align: "tokens" }
    },
    {
      id: "outcome",
      header: "Outcome",
      cell: ({ row: { original: turn } }) => turn.outcome,
      meta: { weight: 120, align: "tokens" }
    },
    {
      id: "detail",
      header: "Detail",
      cell: ({ row: { original: turn } }) => turn.detail ?? "",
      meta: { weight: 260, align: "tokens" }
    }
  ];
}

function gapColumns(): readonly ColumnDef<
  SessionThreadTrace["gaps"][number],
  unknown
>[] {
  return [
    {
      id: "seconds",
      header: "Gap (s)",
      cell: ({ row: { original: gap } }) => String(gap.seconds),
      meta: { weight: 80, align: "tokens" }
    },
    {
      id: "at",
      header: "At (UTC)",
      cell: ({ row: { original: gap } }) => instantLabel(gap.at),
      meta: { weight: 170, align: "tokens" }
    },
    {
      id: "after",
      header: "After",
      cell: ({ row: { original: gap } }) => gap.after,
      meta: { weight: 200, align: "tokens" }
    },
    {
      id: "before",
      header: "Before",
      cell: ({ row: { original: gap } }) => gap.before,
      meta: { weight: 200, align: "tokens" }
    }
  ];
}

function itemColumns(): readonly ColumnDef<SessionThreadItem, unknown>[] {
  return [
    {
      id: "at",
      header: "At (UTC)",
      cell: ({ row: { original: item } }) => instantLabel(item.at),
      meta: { weight: 170, align: "tokens" }
    },
    {
      id: "kind",
      header: "Kind",
      cell: ({ row: { original: item } }) => item.kind,
      meta: { weight: 140, align: "tokens" }
    },
    {
      id: "detail",
      header: "Detail",
      cell: ({ row: { original: item } }) => item.detail,
      meta: { weight: 420, align: "tokens" }
    }
  ];
}

function renderThreadDetail(
  thread: SessionThreadTrace
): React.JSX.Element {
  const efficiency = thread.efficiency;
  return React.createElement(
    DetailGrid,
    { columns: 3 },
    React.createElement(
      DetailValue,
      { label: "Model" },
      thread.model ?? NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Provider" },
      thread.modelProvider ?? NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Initial developer prompt" },
      `${count(efficiency?.prompt.initialDeveloperBytes ?? 0)} bytes`
    ),
    React.createElement(
      DetailValue,
      { label: "Skill catalog" },
      `${count(efficiency?.prompt.skillsCatalogBytes ?? 0)} bytes across ${count(
        efficiency?.prompt.skillsLoaded ?? 0
      )} skills`
    ),
    React.createElement(
      DetailValue,
      { label: "SKILL.md reads" },
      (efficiency?.prompt.skillsRead ?? []).join(", ") || NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Skill-read telemetry" },
      efficiency === undefined || efficiency.prompt.skillTelemetryReads === null
        ? NOT_OBSERVED_LABEL
        : String(efficiency.prompt.skillTelemetryReads)
    ),
    React.createElement(
      DetailValue,
      { label: "Pre-edit investigation" },
      thread.investigation.observed
        ? `${count(thread.investigation.toolCalls)} calls, ${count(
            thread.investigation.filesRead
          )} files read, ${count(thread.investigation.repeatedReads)} repeated`
        : NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Context searches" },
      thread.investigation.observed
        ? `${count(thread.investigation.searches)} searches, ${count(
            thread.investigation.repeatedSearches
          )} repeated`
        : NOT_OBSERVED_LABEL
    ),
    React.createElement(
      DetailValue,
      { label: "Context MCP calls" },
      thread.investigation.observed
        ? `ccc ${count(thread.investigation.context.ccc)} · cgc ${count(
            thread.investigation.context.cgc
          )} · lsp ${count(thread.investigation.context.lsp)}`
        : NOT_OBSERVED_LABEL
    )
  );
}

function renderThreads(
  report: SessionDiagnosticsReport,
  state: SessionDiagnosticsViewState
): React.JSX.Element {
  const selected = state.threadId
    ? report.threads.filter((thread) => thread.id === state.threadId)
    : report.threads;
  const thread = selected[0] ?? null;
  const threadLinks = [
    React.createElement(
      NavigationLink,
      {
        key: "all",
        href: sessionViewHref(state, { threadId: undefined, itemsOffset: 0 }),
        className: ACTION_LINK_CLASS,
        "aria-current": state.threadId === undefined ? "page" : undefined
      },
      "All threads"
    ),
    ...report.threads.map((entry) =>
      React.createElement(
        NavigationLink,
        {
          key: entry.id,
          href: sessionViewHref(state, { threadId: entry.id, itemsOffset: 0 }),
          className: ACTION_LINK_CLASS,
          "aria-current": state.threadId === entry.id ? "page" : undefined
        },
        entry.nickname ?? entry.id
      )
    )
  ];
  return React.createElement(
    "div",
    { className: PAGE_SECTION_STACK_CLASS },
    React.createElement(
      "nav",
      { "aria-label": "Thread filter", className: "flex flex-wrap gap-3" },
      ...threadLinks
    ),
    thread === null
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "No thread was observed for this session."
        )
      : React.createElement(
          "div",
          { className: PAGE_SECTION_STACK_CLASS },
          panel("Thread detail", renderThreadDetail(thread)),
          panel(
            "Turns",
            React.createElement<DataTableProps<SessionThreadTrace["turns"][number]>>(
                DataTable,
                {
                  data: thread.turns,
                  columns: turnColumns(),
                  keyExtractor: (turn) =>
                    `${thread.id}:${turn.turnId}:${turn.started ?? ""}`,
                  emptyMessage: "No turn was observed for this thread.",
                  label: "Thread turns"
                }
              )
          ),
          panel(
            "Silences of a minute or more",
            React.createElement<DataTableProps<SessionThreadTrace["gaps"][number]>>(
                DataTable,
                {
                  data: thread.gaps,
                  columns: gapColumns(),
                  keyExtractor: (gap) => `${thread.id}:${gap.at}:${gap.before}`,
                  emptyMessage: "No silence of a minute or more was observed.",
                  label: "Thread gaps"
                }
              )
          ),
          state.threadId === undefined
            ? React.createElement("div")
            : panel(
                "Rollout items",
                React.createElement(
                  "div",
                  { className: PANEL_CONTENT_STACK_CLASS },
                  React.createElement<DataTableProps<SessionThreadItem>>(DataTable, {
                    data: report.itemsPage.items,
                    columns: itemColumns(),
                    keyExtractor: (item) => `${item.threadId}:${item.at}:${item.kind}`,
                    emptyMessage: NO_ITEMS_MESSAGE,
                    label: "Rollout items"
                  }),
                  React.createElement(Pagination, {
                    label: "Rollout items",
                    offset: report.itemsPage.offset,
                    limit: report.itemsPage.limit,
                    total: report.itemsPage.total,
                    hrefForOffset: (offset) =>
                      sessionViewHref(state, { itemsOffset: offset })
                  })
                )
              )
        )
  );
}

/* ------------------------------------------------------------------ */
/* Failures & Hooks.                                                   */
/* ------------------------------------------------------------------ */

interface RouterFailureRow {
  readonly key: string;
  readonly at: string;
  readonly thread: string;
  readonly provider: string;
  readonly status: number | null;
  readonly failureClass: string;
}

interface FailureRow {
  readonly key: string;
  readonly at: string;
  readonly thread: string;
  readonly tool: string;
  readonly category: ToolFailureCategory;
  readonly detail: string;
  readonly input: string;
}

function failureRows(report: SessionDiagnosticsReport): FailureRow[] {
  const rows: FailureRow[] = [];
  for (const thread of report.threads) {
    for (const failure of thread.toolFailures) {
      rows.push({
        key: `${thread.id}:${failure.callId}:${failure.at}`,
        at: failure.at,
        thread: thread.nickname ?? thread.id,
        tool: failure.tool,
        category: failure.category ?? "other",
        detail: failure.detail,
        input: failure.input ?? ""
      });
    }
  }
  return rows;
}

function failureColumns(): readonly ColumnDef<FailureRow, unknown>[] {
  return [
    {
      id: "at",
      header: TIME_UTC_HEADER,
      cell: ({ row: { original: row } }) => instantLabel(row.at),
      meta: { weight: 170, align: "tokens" }
    },
    {
      id: "thread",
      header: "Thread",
      cell: ({ row: { original: row } }) => row.thread,
      meta: { weight: 160, align: "tokens" }
    },
    {
      id: "tool",
      header: "Tool",
      cell: ({ row: { original: row } }) => row.tool,
      meta: { weight: 110, align: "tokens" }
    },
    {
      id: "category",
      header: "Category",
      cell: ({ row: { original: row } }) =>
        React.createElement(Tag, { children: row.category }),
      meta: { weight: 150, align: "tokens" }
    },
    {
      id: "detail",
      header: "Detail",
      cell: ({ row: { original: row } }) => row.detail,
      meta: { weight: 320, align: "tokens" }
    },
    {
      id: "input",
      header: "Sanitized input",
      cell: ({ row: { original: row } }) => row.input,
      meta: { weight: 240, align: "tokens" }
    }
  ];
}

function renderFailures(
  report: SessionDiagnosticsReport,
  state: SessionDiagnosticsViewState
): React.JSX.Element {
  const allRows = failureRows(report);
  const rows = state.failureCategory
    ? allRows.filter((row) => row.category === state.failureCategory)
    : allRows;
  const categoryLinks = [
    React.createElement(
      NavigationLink,
      {
        key: "all",
        href: sessionViewHref(state, { failureCategory: undefined }),
        className: ACTION_LINK_CLASS,
        "aria-current": state.failureCategory === undefined ? "page" : undefined
      },
      "All categories"
    ),
    ...TOOL_FAILURE_CATEGORIES.filter((category) =>
      allRows.some((row) => row.category === category)
    ).map((category) =>
      React.createElement(
        NavigationLink,
        {
          key: category,
          href: sessionViewHref(state, { failureCategory: category }),
          className: ACTION_LINK_CLASS,
          "aria-current":
            state.failureCategory === category ? "page" : undefined
        },
        category
      )
    )
  ];
  const routerFailures = report.router.flatMap((summary) =>
    summary.failures.map((failure) => ({
      key: `${summary.thread}:${failure.requestId}:${failure.at}`,
      at: failure.at,
      thread: summary.thread,
      provider: failure.provider ?? NOT_OBSERVED_LABEL,
      status: failure.status ?? null,
      failureClass: failure.failureClass ?? NOT_OBSERVED_LABEL
    }))
  );
  return React.createElement(
    "div",
    { className: PAGE_SECTION_STACK_CLASS },
    React.createElement(
      "nav",
      { "aria-label": "Failure category filter", className: "flex flex-wrap gap-3" },
      ...categoryLinks
    ),
    panel(
      "Tool failures",
      React.createElement<DataTableProps<FailureRow>>(DataTable, {
        data: rows,
        columns: failureColumns(),
        keyExtractor: (row) => row.key,
        emptyMessage: NO_FAILURES_MESSAGE,
        label: "Tool failures"
      })
    ),
    panel(
      "Router failures",
      React.createElement<DataTableProps<RouterFailureRow>>(DataTable, {
        data: routerFailures,
        columns: [
          {
            id: "at",
            header: TIME_UTC_HEADER,
            cell: ({ row: { original: row } }) => instantLabel(row.at),
            meta: { weight: 170, align: "tokens" }
          },
          {
            id: "thread",
            header: "Thread",
            cell: ({ row: { original: row } }) => row.thread,
            meta: { weight: 200, align: "tokens" }
          },
          {
            id: "provider",
            header: "Provider",
            cell: ({ row: { original: row } }) => row.provider,
            meta: { weight: 120, align: "tokens" }
          },
          {
            id: "status",
            header: "Status",
            cell: ({ row: { original: row } }) =>
              row.status === null ? NOT_OBSERVED_LABEL : String(row.status),
            meta: { weight: 80, align: "tokens" }
          },
          {
            id: "class",
            header: "Failure class",
            cell: ({ row: { original: row } }) => row.failureClass,
            meta: { weight: 220, align: "tokens" }
          }
        ],
        keyExtractor: (row) => row.key,
        emptyMessage: "No router request failed for this session.",
        label: "Router failures"
      })
    ),
    panel(
      "Bridge log alerts",
      report.bridgeAlerts.length === 0
        ? React.createElement(
            "p",
            { className: MUTED_BODY_CLASS },
            "No bridge log line reported a problem in the observed tail."
          )
        : React.createElement(
            "div",
            { className: PANEL_CONTENT_STACK_CLASS },
            ...report.bridgeAlerts.map((alert) =>
              React.createElement(
                "div",
                { key: alert.file, className: "flex flex-col gap-1" },
                React.createElement(
                  "p",
                  { className: MUTED_META_CLASS },
                  `${alert.file}: ${alert.count} matching line(s)`
                ),
                ...alert.samples.map((sample, index) =>
                  React.createElement(
                    "p",
                    { key: `${alert.file}:${index}`, className: MUTED_BODY_CLASS },
                    sample
                  )
                )
              )
            )
          )
    )
  );
}

/* ------------------------------------------------------------------ */
/* Router Requests.                                                    */
/* ------------------------------------------------------------------ */

function renderRequests(
  report: SessionDiagnosticsReport,
  state: SessionDiagnosticsViewState
): React.JSX.Element {
  return React.createElement(
    "div",
    { className: PAGE_SECTION_STACK_CLASS },
    panel(
      "Per-thread router summary",
      React.createElement<DataTableProps<SessionRouterSummary>>(DataTable, {
        data: report.router,
        columns: [
          {
            id: "thread",
            header: "Thread",
            cell: ({ row: { original: summary } }) => summary.thread,
            meta: { weight: 220, align: "tokens" }
          },
          {
            id: "matched",
            header: "Match",
            cell: ({ row: { original: summary } }) => summary.matchedBy,
            meta: { weight: 120, align: "tokens" }
          },
          {
            id: "requests",
            header: "Requests",
            cell: ({ row: { original: summary } }) => String(summary.requests),
            meta: { weight: 90, align: "tokens" }
          },
          {
            id: "providers",
            header: "Provider sequence",
            cell: ({ row: { original: summary } }) =>
              summary.providerSequence.join(" → ") || NOT_OBSERVED_LABEL,
            meta: { weight: 220, align: "tokens" }
          },
          {
            id: "failures",
            header: "Failures",
            cell: ({ row: { original: summary } }) =>
              String(summary.failures.length),
            meta: { weight: 90, align: "tokens" }
          },
          {
            id: "skipped",
            header: "Skipped",
            cell: ({ row: { original: summary } }) =>
              String(summary.skipped?.length ?? 0),
            meta: { weight: 90, align: "tokens" }
          },
          {
            id: "retries",
            header: "Retries",
            cell: ({ row: { original: summary } }) =>
              String(summary.retries ?? 0),
            meta: { weight: 80, align: "tokens" }
          },
          {
            id: "exhaustion",
            header: "Exhaustion waits",
            cell: ({ row: { original: summary } }) =>
              String(summary.exhaustionWaits?.count ?? 0),
            meta: { weight: 120, align: "tokens" }
          },
          {
            id: "transport",
            header: "Transport errors",
            cell: ({ row: { original: summary } }) =>
              String(summary.transportErrors ?? 0),
            meta: { weight: 120, align: "tokens" }
          }
        ],
        keyExtractor: (summary) => summary.thread,
        emptyMessage: "No router request was observed for this session.",
        label: "Router summary"
      })
    ),
    panel(
      "Router events",
      React.createElement(
        "div",
        { className: PANEL_CONTENT_STACK_CLASS },
        React.createElement<DataTableProps<SessionRouterEventRow>>(DataTable, {
          data: report.eventsPage.items,
          columns: [
            {
              id: "at",
              header: TIME_UTC_HEADER,
              cell: ({ row: { original: event } }) => instantLabel(event.at),
              meta: { weight: 170, align: "tokens" }
            },
            {
              id: "phase",
              header: "Phase",
              cell: ({ row: { original: event } }) => event.phase,
              meta: { weight: 120, align: "tokens" }
            },
            {
              id: "provider",
              header: "Provider",
              cell: ({ row: { original: event } }) =>
                event.provider ?? NOT_OBSERVED_LABEL,
              meta: { weight: 120, align: "tokens" }
            },
            {
              id: "model",
              header: "Model",
              cell: ({ row: { original: event } }) =>
                event.model ?? NOT_OBSERVED_LABEL,
              meta: { weight: 140, align: "tokens" }
            },
            {
              id: "outcome",
              header: "Outcome",
              cell: ({ row: { original: event } }) =>
                event.outcome ?? NOT_OBSERVED_LABEL,
              meta: { weight: 110, align: "tokens" }
            },
            {
              id: "elapsed",
              header: "Elapsed (ms)",
              cell: ({ row: { original: event } }) =>
                event.elapsedMs === null
                  ? NOT_OBSERVED_LABEL
                  : String(event.elapsedMs),
              meta: { weight: 110, align: "tokens" }
            }
          ],
          keyExtractor: (event: SessionRouterEventRow) =>
            `${event.at}:${event.requestId}:${event.phase}`,
          emptyMessage: NO_EVENTS_MESSAGE,
          label: "Router events"
        }),
        React.createElement(Pagination, {
          label: "Router events",
          offset: report.eventsPage.offset,
          limit: report.eventsPage.limit,
          total: report.eventsPage.total,
          hrefForOffset: (offset) =>
            sessionViewHref(state, { eventsOffset: offset })
        })
      )
    )
  );
}

/* ------------------------------------------------------------------ */
/* OTel Spans.                                                         */
/* ------------------------------------------------------------------ */

function spanColumns(): readonly ColumnDef<UsageSessionSpanSummary, unknown>[] {
  return [
    {
      id: "time",
      header: TIME_UTC_HEADER,
      cell: ({ row: { original: span } }) => instantLabel(span.timestamp),
      meta: { weight: 180, align: "tokens" }
    },
    {
      id: "operation",
      header: "Operation",
      cell: ({ row: { original: span } }) => span.operationName,
      meta: { weight: 180, align: "tokens" }
    },
    {
      id: "provider",
      header: "Provider",
      cell: ({ row: { original: span } }) =>
        span.provider ?? NOT_OBSERVED_LABEL,
      meta: { weight: 110, align: "tokens" }
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row: { original: span } }) => span.role ?? NOT_OBSERVED_LABEL,
      meta: { weight: 100, align: "tokens" }
    },
    {
      id: "input",
      header: "Input",
      cell: ({ row: { original: span } }) =>
        span.inputTokens === null
          ? NOT_OBSERVED_LABEL
          : COUNT_FORMATTER.format(span.inputTokens),
      meta: { weight: 90, align: "tokens" }
    },
    {
      id: "output",
      header: "Output",
      cell: ({ row: { original: span } }) =>
        span.outputTokens === null
          ? NOT_OBSERVED_LABEL
          : COUNT_FORMATTER.format(span.outputTokens),
      meta: { weight: 90, align: "tokens" }
    },
    {
      id: "cost",
      header: "Cost",
      cell: ({ row: { original: span } }) =>
        span.costUsd === null ? NOT_OBSERVED_LABEL : COST_FORMATTER.format(span.costUsd),
      meta: { weight: 100, align: "tokens" }
    }
  ];
}

function renderSpans(
  state: SessionDiagnosticsViewState,
  spans: UsageSessionEvidence | null,
  spansFailure: SessionDiagnosticsFailure | null,
  spanHrefFor: (offset: number) => string
): React.JSX.Element {
  if (spansFailure !== null) {
    return React.createElement(
      "p",
      { className: CALLOUT_ERROR_CLASS, role: "status" },
      spansFailure.message
    );
  }
  if (spans === null) {
    return React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "The telemetry store reported no span evidence for this session."
    );
  }
  const total = spans.total ?? spans.spans.length;
  return React.createElement(
    "div",
    { className: "flex flex-col gap-4" },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-3" },
      React.createElement(
        "span",
        { className: MUTED_META_CLASS },
        `Page size: ${state.spanLimit}`
      ),
      ...[50, 100, 200].map((size) =>
        React.createElement(
          NavigationLink,
          {
            key: String(size),
            href: sessionViewHref(state, {
              spanLimit: size,
              spanOffset: 0
            }),
            className: ACTION_LINK_CLASS,
            "aria-current": state.spanLimit === size ? "page" : undefined
          },
          String(size)
        )
      ),
      React.createElement(
        "span",
        { className: MUTED_META_CLASS },
        "Sort:"
      ),
      ...(["desc", "asc"] as const).map((sort) =>
        React.createElement(
          NavigationLink,
          {
            key: sort,
            href: sessionViewHref(state, { spanSort: sort, spanOffset: 0 }),
            className: ACTION_LINK_CLASS,
            "aria-current": state.spanSort === sort ? "page" : undefined
          },
          sort === "desc" ? "Newest first" : "Oldest first"
        )
      )
    ),
    React.createElement(
      "div",
      { className: LIST_PANEL_CLASS },
      React.createElement<DataTableProps<UsageSessionSpanSummary>>(DataTable, {
        data: spans.spans,
        columns: spanColumns(),
        keyExtractor: (span) => span.spanId,
        emptyMessage: NO_SPANS_MESSAGE,
        label: "Session spans"
      })
    ),
    React.createElement(Pagination, {
      label: "Spans",
      offset: state.spanOffset,
      limit: state.spanLimit,
      total,
      hrefForOffset: spanHrefFor
    })
  );
}

/* ------------------------------------------------------------------ */
/* The view.                                                           */
/* ------------------------------------------------------------------ */

export function SessionDiagnosticsView({
  state,
  report,
  diagnosticsFailure,
  spans,
  spansFailure,
  spanHrefFor
}: SessionDiagnosticsViewProps): React.JSX.Element {
  const body = ((): React.JSX.Element => {
    if (diagnosticsFailure !== null) {
      return React.createElement(
        "p",
        { className: CALLOUT_ERROR_CLASS, role: "status" },
        diagnosticsFailure.message
      );
    }
    if (report === null) {
      return React.createElement(
        "p",
        { className: MUTED_BODY_CLASS },
        "The session diagnostics could not be read."
      );
    }
    switch (state.tab) {
      case "threads": {
        return renderThreads(report, state);
      }
      case "failures": {
        return renderFailures(report, state);
      }
      case "requests": {
        return renderRequests(report, state);
      }
      case "spans": {
        return renderSpans(state, spans, spansFailure, spanHrefFor);
      }
      default: {
        return React.createElement(
          "div",
          { className: PAGE_SECTION_STACK_CLASS },
          ...renderOverview(report, spans, state)
        );
      }
    }
  })();

  return React.createElement(
    "div",
    { className: PAGE_SECTION_STACK_CLASS, "data-session-diagnostics": "true" },
    report === null
      ? React.createElement("div")
      : React.createElement(
          "div",
          { className: PANEL_CONTENT_STACK_CLASS },
          renderContextHeader(report),
          ...renderAlerts(report)
        ),
    React.createElement(TabNav, {
      navLabel: "Session diagnostics",
      basePath: "/usage",
      tabs: SESSION_TABS.map((tab) => ({ id: tab.id, label: tab.label })),
      activeTabId: state.tab,
      hrefFor: (tabId: string) =>
        sessionViewHref(state, {
          tab: tabId,
          spanOffset: tabId === "spans" ? state.spanOffset : undefined,
          eventsOffset: tabId === "requests" ? state.eventsOffset : undefined,
          itemsOffset: tabId === "threads" ? state.itemsOffset : undefined
        })
    }),
    body
  );
}
