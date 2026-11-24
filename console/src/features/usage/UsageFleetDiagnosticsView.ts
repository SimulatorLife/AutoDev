/**
 * The unscoped fleet diagnostics views.
 *
 * Two views sit beside the fleet-wide Usage aggregate: the newest sessions
 * with their efficiency and failure rollups, and the hook denials the policy
 * recorded. Both are read from the Control API's diagnostics routes -- the same
 * engine the session view and the CLI read -- so a number here and the same
 * number in a session's own report are the same measurement.
 *
 * The recent-sessions rows link straight into the session-scoped page, which is
 * what makes the fleet view a way *into* a session rather than a table of
 * numbers with no next step.
 */

import {
  type FleetSessionRow,
  formatClientSurface,
  type SessionFleetScanResponse,
  type SessionHookDenialsResponse
} from "@simulatorlife/autodev-core";
import { type ColumnDef } from "@tanstack/react-table";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  BarChart,
  type BarChartDatum
} from "../../components/charts/BarChart.ts";
import { CALLOUT_ERROR_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  DataTable,
  type DataTableFeatures,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import { InstantDisplay } from "../../components/ui/InstantDisplay.ts";
import {
  ACTION_LINK_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";

/** A read that did not produce evidence, and why. */
export interface UsageFleetFailure {
  readonly code: string;
  readonly message: string;
}

export interface UsageFleetDiagnosticsViewProps {
  readonly view: "overview" | "sessions" | "hooks";
  readonly range: string;
  readonly scan: SessionFleetScanResponse | null;
  readonly scanFailure: UsageFleetFailure | null;
  readonly hooks: SessionHookDenialsResponse | null;
  readonly hooksFailure: UsageFleetFailure | null;
  readonly hooksSinceDays: 1 | 7 | 30;
}

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});
const CHART_PALETTE = {
  series1: { bar: "bg-chart-1", value: "text-chart-1" },
  series2: { bar: "bg-chart-2", value: "text-chart-2" }
} as const;

/** What every hook chart says when the window held no PreToolUse denial. */
const NO_HOOK_DENIAL_MESSAGE =
  "No PreToolUse denial was observed in this window.";

function count(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : COUNT_FORMATTER.format(value);
}

function tokens(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : TOKEN_FORMATTER.format(value);
}

function percent(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : `${value}%`;
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

function fleetHref(
  range: string,
  changes: Readonly<Record<string, string | number | undefined>>
): string {
  const params = new URLSearchParams({ range });
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  return `/usage?${params.toString()}`;
}

function panel(title: string, children: React.ReactNode): React.JSX.Element {
  return React.createElement(
    "section",
    { className: "flex flex-col gap-3" },
    React.createElement("h3", { className: SECTION_HEADING_CLASS }, title),
    React.createElement("div", { className: LIST_PANEL_CLASS }, children)
  );
}

function sessionColumns(
  range: string
): readonly ColumnDef<DataTableFeatures, FleetSessionRow, unknown>[] {
  return [
    {
      id: "session",
      header: "Session",
      cell: ({ row: { original: row } }) =>
        React.createElement(
          NavigationLink,
          {
            href: fleetHref(range, { sessionId: row.id }),
            className: ACTION_LINK_CLASS
          },
          row.id
        ),
      meta: { weight: 260, align: "tokens" }
    },
    {
      id: "client",
      header: "Client",
      cell: ({ row: { original: row } }) =>
        formatClientSurface(row.clientSurface),
      meta: { weight: 150, align: "tokens" }
    },
    {
      id: "lastWrite",
      header: "Last write",
      cell: ({ row: { original: row } }) =>
        React.createElement(InstantDisplay, {
          value: row.lastWrite,
          label: "Last write"
        }),
      meta: { weight: 180, align: "tokens" }
    },
    {
      id: "threads",
      header: "Threads",
      cell: ({ row: { original: row } }) => String(row.threads),
      meta: { weight: 80, align: "tokens" }
    },
    {
      id: "tokens",
      header: "Tokens",
      cell: ({ row: { original: row } }) => tokens(row.totalTokens),
      meta: { weight: 90, align: "tokens" }
    },
    {
      id: "cache",
      header: "Cache %",
      cell: ({ row: { original: row } }) => percent(row.cacheHitPct),
      meta: { weight: 80, align: "tokens" }
    },
    {
      id: "compactions",
      header: "Compactions",
      cell: ({ row: { original: row } }) => String(row.compactions),
      meta: { weight: 100, align: "tokens" }
    },
    {
      id: "failures",
      header: "Failures",
      cell: ({ row: { original: row } }) =>
        React.createElement(
          "span",
          { className: "flex flex-wrap gap-1" },
          String(row.toolFailures),
          row.topFailureCategory === null
            ? null
            : React.createElement(Tag, { children: row.topFailureCategory })
        ),
      meta: { weight: 180, align: "tokens" }
    },
    {
      id: "hooks",
      header: "Hook blocks",
      cell: ({ row: { original: row } }) => String(row.preToolUseBlocks),
      meta: { weight: 100, align: "tokens" }
    },
    {
      id: "requests",
      header: "Router requests",
      cell: ({ row: { original: row } }) => String(row.routerRequests),
      meta: { weight: 120, align: "tokens" }
    }
  ];
}

function renderRecentSessions(
  scan: SessionFleetScanResponse | null,
  scanFailure: UsageFleetFailure | null,
  range: string
): React.JSX.Element {
  if (scanFailure !== null) {
    return React.createElement(
      "p",
      { className: CALLOUT_ERROR_CLASS, role: "status" },
      scanFailure.message
    );
  }
  if (scan === null) {
    return React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "The fleet scan could not be read."
    );
  }
  const totals = scan.totals;
  return React.createElement(
    "div",
    { className: "flex flex-col gap-6" },
    panel(
      "Fleet totals",
      React.createElement(
        StatGrid,
        { columns: 4 },
        React.createElement(StatCard, {
          title: "Sessions",
          value: count(totals.sessions),
          subtitle: `${count(totals.threads)} threads`
        }),
        React.createElement(StatCard, {
          title: "Tokens",
          value: tokens(totals.totalTokens),
          subtitle: `${percent(totals.cacheHitPct)} cache-read`
        }),
        React.createElement(StatCard, {
          title: "Cache drops",
          value: count(totals.cacheDrops),
          subtitle: `${count(totals.compactions)} compactions`
        }),
        React.createElement(StatCard, {
          title: "Tool failures",
          value: count(
            Object.values(totals.toolFailuresByCategory).reduce(
              (total, value) => total + value,
              0
            )
          ),
          subtitle: `${count(totals.preToolUseReasons.length)} block reason(s)`
        })
      )
    ),
    panel(
      "Recent sessions",
      React.createElement<DataTableProps<FleetSessionRow>>(DataTable, {
        data: scan.sessions,
        columns: sessionColumns(range),
        keyExtractor: (row) => row.id,
        emptyMessage: "No session rollout was observed.",
        label: "Recent sessions"
      })
    )
  );
}

function renderHookDenials(
  hooks: SessionHookDenialsResponse | null,
  hooksFailure: UsageFleetFailure | null,
  range: string,
  sinceDays: 1 | 7 | 30
): React.JSX.Element {
  const windowLinks = [1, 7, 30].map((days) =>
    React.createElement(
      NavigationLink,
      {
        key: String(days),
        href: fleetHref(range, { view: "hooks", hooksSinceDays: days }),
        className: ACTION_LINK_CLASS,
        "aria-current": sinceDays === days ? "page" : undefined
      },
      `${days}d`
    )
  );
  if (hooksFailure !== null) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-3" },
      React.createElement(
        "nav",
        {
          "aria-label": "Hook denial window",
          className: "flex flex-wrap gap-3"
        },
        ...windowLinks
      ),
      React.createElement(
        "p",
        { className: CALLOUT_ERROR_CLASS, role: "status" },
        hooksFailure.message
      )
    );
  }
  if (hooks === null) {
    return React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "The hook-denial summary could not be read."
    );
  }
  const summary = hooks.summary;
  return React.createElement(
    "div",
    { className: "flex flex-col gap-6" },
    React.createElement(
      "nav",
      { "aria-label": "Hook denial window", className: "flex flex-wrap gap-3" },
      ...windowLinks
    ),
    panel(
      "Hook denials",
      React.createElement(
        StatGrid,
        { columns: 3 },
        React.createElement(StatCard, {
          title: "PreToolUse denials",
          value: count(summary.preToolUseDenials),
          subtitle: React.createElement(
            React.Fragment,
            null,
            "Since ",
            React.createElement(InstantDisplay, {
              value: summary.cutoff,
              label: "Since"
            })
          )
        }),
        React.createElement(StatCard, {
          title: "Policies",
          value: count(Object.keys(summary.byPolicy).length),
          subtitle: `${count(Object.keys(summary.byRole).length)} role(s)`
        })
      )
    ),
    panel(
      "Denials by policy",
      React.createElement(BarChart, {
        data: chartData(summary.byPolicy),
        label: "Denials by policy",
        notObservedMessage: NO_HOOK_DENIAL_MESSAGE,
        emptyMessage: NO_HOOK_DENIAL_MESSAGE,
        barClass: CHART_PALETTE.series1.bar
      })
    ),
    panel(
      "Denials by role",
      React.createElement(BarChart, {
        data: chartData(summary.byRole),
        label: "Denials by role",
        notObservedMessage: NO_HOOK_DENIAL_MESSAGE,
        emptyMessage: NO_HOOK_DENIAL_MESSAGE,
        barClass: CHART_PALETTE.series2.bar
      })
    ),
    panel(
      "Top denial reasons",
      React.createElement<DataTableProps<{ reason: string; count: number }>>(
        DataTable,
        {
          data: summary.byReason,
          columns: [
            {
              id: "reason",
              header: "Reason",
              cell: ({ row: { original: row } }) => row.reason,
              meta: { weight: 380, align: "tokens" }
            },
            {
              id: "count",
              header: "Denials",
              cell: ({ row: { original: row } }) => String(row.count),
              meta: { weight: 90, align: "tokens" }
            }
          ],
          keyExtractor: (row) => row.reason,
          emptyMessage: "No denial reason was observed in this window.",
          label: "Denial reasons"
        }
      )
    ),
    panel(
      "Top blocked commands",
      React.createElement<
        DataTableProps<{
          commandHead: string;
          policy: string;
          count: number;
        }>
      >(DataTable, {
        data: summary.topCommands,
        columns: [
          {
            id: "command",
            header: "Command",
            cell: ({ row: { original: row } }) => row.commandHead,
            meta: { weight: 380, align: "tokens" }
          },
          {
            id: "policy",
            header: "Policy",
            cell: ({ row: { original: row } }) => row.policy,
            meta: { weight: 160, align: "tokens" }
          },
          {
            id: "count",
            header: "Denials",
            cell: ({ row: { original: row } }) => String(row.count),
            meta: { weight: 90, align: "tokens" }
          }
        ],
        keyExtractor: (row) => `${row.policy}:${row.commandHead}`,
        emptyMessage: "No blocked command was observed in this window.",
        label: "Blocked commands"
      })
    )
  );
}

/**
 * The unscoped Usage page's tab strip.
 *
 * `Aggregate usage` stays the default so every existing `/usage` link and
 * acceptance spec behaves exactly as it did; the two fleet diagnostics views
 * sit beside it.
 */
export function UsageFleetDiagnosticsView({
  view,
  range,
  scan,
  scanFailure,
  hooks,
  hooksFailure,
  hooksSinceDays
}: UsageFleetDiagnosticsViewProps): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-fleet-diagnostics": "true" },
    React.createElement(TabNav, {
      navLabel: "Usage views",
      basePath: "/usage",
      tabs: [
        { id: "overview", label: "Aggregate usage" },
        { id: "sessions", label: "Recent sessions" },
        { id: "hooks", label: "Hook denials" }
      ],
      activeTabId: view,
      hrefFor: (tabId: string) =>
        fleetHref(range, {
          view: tabId === "overview" ? undefined : tabId
        })
    }),
    view === "sessions"
      ? renderRecentSessions(scan, scanFailure, range)
      : view === "hooks"
        ? renderHookDenials(hooks, hooksFailure, range, hooksSinceDays)
        : React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            "Select a fleet view to read the session diagnostics across the newest sessions."
          )
  );
}
