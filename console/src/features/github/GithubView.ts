import type {
  GithubActionsRunStats,
  GithubActionsRuntimeStatus,
  GithubWorkflowDefinition,
  GithubWorkflowRun
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import { CHIP_TONE_CLASS } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  MONO_META_CLASS,
  MONO_VALUE_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";

/**
 * GitHub resource view.
 *
 * Every row in the workflow definitions table is an observed workflow
 * definition parsed from `.github/workflows/*.yml` source: its declared name,
 * file path, and trigger events/cron schedules configured under `on:`.
 *
 * When GitHub Actions API credentials and repository configuration are
 * available, this view renders authoritative read-only workflow runtime state
 * (active vs disabled) and bounded recent run statistics.
 *
 * When credentials or repository context are absent, runtime facts remain
 * explicitly "Unavailable" without synthesizing zero or healthy values.
 *
 * Dispatch, cancel, rerun, and schedule mutation controls remain explicitly
 * unimplemented; this view never renders mutation affordances.
 */

export interface GithubViewProps {
  readonly workflows: readonly GithubWorkflowDefinition[];
  readonly runtimeFactsAvailable?: boolean;
  readonly runtimeStatus?: GithubActionsRuntimeStatus;
  readonly runtimeMessage?: string | null;
  readonly repository?: string | null;
  readonly stats?: GithubActionsRunStats | null;
  readonly recentRuns?: readonly GithubWorkflowRun[];
}

export function GithubView({
  workflows,
  runtimeFactsAvailable = false,
  runtimeStatus,
  runtimeMessage,
  repository,
  stats,
  recentRuns = []
}: GithubViewProps): React.JSX.Element {
  const scheduledCount = workflows.filter((w) => w.schedules.length > 0).length;
  const statsSampleSize = stats?.totalRuns ?? 0;
  const statsSampleDescription = `most recent ${statsSampleSize} returned run${statsSampleSize === 1 ? "" : "s"}`;
  const uniqueEvents = new Set<string>();
  for (const workflow of workflows) {
    for (const event of workflow.events) uniqueEvents.add(event);
  }

  const columns: ColumnDef<GithubWorkflowDefinition>[] = [
    {
      id: "name",
      header: "Workflow",
      align: "tokens",
      cell: (workflow) =>
        React.createElement(
          "div",
          { className: "flex flex-col" },
          React.createElement(
            "span",
            { className: "font-semibold text-fg" },
            workflow.name ?? workflow.id
          ),
          React.createElement(
            "span",
            { className: MONO_META_CLASS },
            workflow.path
          )
        )
    },
    {
      id: "events",
      header: "Trigger Events",
      // A list of chips, so it wraps between them rather than being held on one
      // line. At the default share it kept `nowrap` and showed only the first
      // chip: 17 of 30 rows lost every trigger after the first at a 390px
      // viewport, and a GitHub workflow's trigger set is the thing an operator
      // reads the row to find out.
      align: "tokens",
      weight: 150,
      cell: (workflow) =>
        workflow.events.length === 0
          ? React.createElement(
              "span",
              { className: MUTED_META_CLASS },
              "None observed"
            )
          : React.createElement(
              "div",
              { className: "flex flex-wrap gap-1" },
              ...workflow.events.map((event) =>
                React.createElement(Tag, {
                  key: event,
                  className: `${CHIP_TONE_CLASS} font-mono`,
                  children: event
                })
              )
            )
    },
    {
      id: "schedules",
      header: "Cron Schedule",
      // Holds either a cron expression or the sentence "No schedule trigger",
      // and `truncate` held both to one line: 13 of 30 rows cut the sentence to
      // "No schedule trig…" at 390px. A cron expression is one unbreakable
      // identifier and the sentence is ordinary words, so this wraps on either
      // count.
      //
      // Wide enough for "Schedule" at the share the header had before: it had
      // 68px of content and the word needed 71, so it split mid-word at 390px.
      align: "tokens",
      weight: 140,
      cell: (workflow) =>
        workflow.schedules.length === 0
          ? React.createElement(
              "span",
              { className: MUTED_META_CLASS },
              "No schedule trigger"
            )
          : React.createElement(
              "div",
              { className: "flex flex-col gap-1" },
              ...workflow.schedules.map((cron) =>
                React.createElement(
                  "span",
                  {
                    key: cron,
                    className: MONO_VALUE_CLASS
                  },
                  cron
                )
              )
            )
    },
    {
      id: "actionsState",
      header: "GitHub Actions State",
      // Wide enough for "Actions", the longest word in the header. At the
      // default share this column was 68px of content and the word needed 70,
      // so the header broke inside it on a 390px viewport.
      weight: 140,
      cell: (workflow) => {
        if (
          !runtimeFactsAvailable ||
          !workflow.actionsState ||
          workflow.actionsState === "unavailable"
        ) {
          return React.createElement(StatusBadge, {
            status: "unavailable",
            label: "Unavailable"
          });
        }
        if (workflow.actionsState === "active") {
          return React.createElement(StatusBadge, {
            status: "ready",
            label: "Active"
          });
        }
        if (workflow.actionsState === "disabled_manually") {
          return React.createElement(StatusBadge, {
            status: NOT_OBSERVED_STATUS,
            label: "Disabled (Manual)"
          });
        }
        if (workflow.actionsState === "disabled_inactivity") {
          return React.createElement(StatusBadge, {
            status: NOT_OBSERVED_STATUS,
            label: "Disabled (Inactivity)"
          });
        }
        if (workflow.actionsState === "deleted") {
          return React.createElement(StatusBadge, {
            status: "error",
            label: "Deleted"
          });
        }
        return React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS
        });
      }
    }
  ];

  if (runtimeFactsAvailable) {
    columns.push({
      id: "lastRun",
      header: "Last Run",
      cell: (workflow) => {
        if (!workflow.lastRunStatus && !workflow.lastRunConclusion) {
          return React.createElement(
            "span",
            { className: MUTED_META_CLASS },
            "No runs observed"
          );
        }
        const isSuccess = workflow.lastRunConclusion === "success";
        const isFailure =
          workflow.lastRunConclusion === "failure" ||
          workflow.lastRunConclusion === "timed_out";
        const isPending =
          workflow.lastRunStatus === "in_progress" ||
          workflow.lastRunStatus === "queued" ||
          workflow.lastRunStatus === "waiting";
        const status = isSuccess
          ? "ready"
          : isFailure
            ? "error"
            : isPending
              ? "pending"
              : NOT_OBSERVED_STATUS;
        const label =
          workflow.lastRunConclusion ?? workflow.lastRunStatus ?? "unknown";

        return React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement(StatusBadge, { status, label }),
          workflow.lastRunHtmlUrl
            ? React.createElement(
                "a",
                {
                  href: workflow.lastRunHtmlUrl,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  className: "text-xs text-accent hover:underline font-mono"
                },
                "View ↗"
              )
            : null
        );
      }
    });
  }

  const runColumns: ColumnDef<GithubWorkflowRun>[] = [
    {
      id: "id",
      header: "Run",
      cell: (run) =>
        React.createElement(
          "div",
          { className: "flex flex-col" },
          run.htmlUrl
            ? React.createElement(
                "a",
                {
                  href: run.htmlUrl,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  className:
                    "font-semibold text-fg hover:text-accent hover:underline font-mono text-xs"
                },
                `#${run.id} ${run.name ?? ""}`.trim()
              )
            : React.createElement(
                "span",
                { className: "font-semibold text-fg font-mono text-xs" },
                `#${run.id} ${run.name ?? ""}`.trim()
              ),
          React.createElement(
            "span",
            { className: MONO_META_CLASS },
            run.workflowPath
          )
        )
    },
    {
      id: "event",
      header: "Event",
      cell: (run) =>
        React.createElement(Tag, {
          className: `${CHIP_TONE_CLASS} font-mono`,
          children: run.event
        })
    },
    {
      id: "commit",
      header: "Branch / Commit",
      cell: (run) =>
        React.createElement(
          "div",
          { className: "flex flex-col text-xs font-mono" },
          React.createElement(
            "span",
            { className: "text-fg-secondary" },
            run.headBranch ?? NOT_OBSERVED_LABEL
          ),
          React.createElement(
            "span",
            { className: MUTED_TEXT_CLASS },
            run.headSha ? run.headSha.slice(0, 7) : ""
          )
        )
    },
    {
      id: "outcome",
      header: "Status / Outcome",
      cell: (run) => {
        const isSuccess = run.conclusion === "success";
        const isFailure =
          run.conclusion === "failure" || run.conclusion === "timed_out";
        const isPending =
          run.status === "in_progress" ||
          run.status === "queued" ||
          run.status === "waiting";
        const status = isSuccess
          ? "ready"
          : isFailure
            ? "error"
            : isPending
              ? "pending"
              : NOT_OBSERVED_STATUS;
        const label = run.conclusion ?? run.status;
        return React.createElement(StatusBadge, { status, label });
      }
    },
    {
      id: "createdAt",
      header: "Created",
      cell: (run) =>
        React.createElement(
          "span",
          { className: MONO_META_CLASS },
          run.createdAt
        )
    }
  ];

  return React.createElement(
    PageBody,
    {
      feature: "github",
      attributes: {
        "data-github-actions-facts-observed": runtimeFactsAvailable
          ? "true"
          : "false"
      }
    },
    React.createElement(
      StatGrid,
      { columns: 2 },
      React.createElement(StatCard, {
        title: "Scheduled Workflows",
        value: scheduledCount,
        subtitle: "Declare an on.schedule cron trigger"
      }),
      React.createElement(StatCard, {
        title: "Distinct Trigger Events",
        value: uniqueEvents.size,
        subtitle: "Observed across all workflow definitions"
      })
    ),
    runtimeFactsAvailable && stats
      ? React.createElement(
          StatGrid,
          { columns: 3 },
          React.createElement(StatCard, {
            title: "Recent Workflow Runs",
            value: stats.totalRuns,
            subtitle: `Counts cover the ${statsSampleDescription}; they are not total-history counts (${repository ?? "bound repository"}).`
          }),
          React.createElement(StatCard, {
            title: "Recent Success Rate",
            value:
              stats.successRate === null
                ? NOT_OBSERVED_LABEL
                : `${Math.round(stats.successRate * 100)}%`,
            subtitle: `From the same ${statsSampleDescription}: ${stats.successfulRuns} succeeded, ${stats.failedRuns} failed, ${stats.inProgressRuns} running`
          }),
          React.createElement(StatCard, {
            title: "Active Workflows",
            value: workflows.filter((w) => w.actionsState === "active").length,
            subtitle: "Enabled in GitHub Actions"
          })
        )
      : null,
    runtimeFactsAvailable
      ? React.createElement(
          "div",
          {
            className:
              "rounded-lg border border-success/40 bg-success/10 p-4 text-xs text-success leading-relaxed flex items-center justify-between",
            role: "note",
            "data-status": "available"
          },
          React.createElement(
            "div",
            { className: "flex items-center gap-2" },
            React.createElement(StatusBadge, {
              status: "ready",
              label: "Actions API Connected"
            }),
            React.createElement(
              "span",
              null,
              "Authoritative read-only runtime state observed for ",
              React.createElement(
                "span",
                { className: "font-mono font-semibold text-success" },
                repository ?? "configured workspace"
              ),
              ". Dispatch, cancel, rerun, and schedule mutation controls remain unimplemented."
            )
          )
        )
      : React.createElement(
          "div",
          {
            className: CALLOUT_WARNING_CLASS,
            role: "note",
            "data-status": runtimeStatus ?? "unavailable"
          },
          "Workflow enabled/disabled state, run history, run status, and run counts " +
            "require the GitHub Actions API and are not available without it. " +
            "Dispatch, cancel, rerun, and schedule mutation controls remain " +
            "unimplemented regardless. Only the workflow definitions and trigger " +
            "configuration observed in YAML are shown below." +
            (runtimeMessage ? ` (${runtimeMessage})` : "")
        ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Workflow Definitions"
      ),
      React.createElement<DataTableProps<GithubWorkflowDefinition>>(DataTable, {
        data: workflows,
        columns,
        keyExtractor: (workflow: GithubWorkflowDefinition) => workflow.id,
        emptyMessage: "No workflow definitions were found."
      })
    ),
    runtimeFactsAvailable && recentRuns.length > 0
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-3" },
          React.createElement(
            "h2",
            {
              className: SECTION_HEADING_CLASS
            },
            "Recent Workflow Runs"
          ),
          React.createElement<DataTableProps<GithubWorkflowRun>>(DataTable, {
            data: recentRuns,
            columns: runColumns,
            keyExtractor: (run: GithubWorkflowRun) => String(run.id),
            emptyMessage: "No recent workflow runs observed."
          })
        )
      : null
  );
}
