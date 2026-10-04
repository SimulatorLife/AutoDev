import type {
  GithubActionsRunStats,
  GithubActionsRuntimeStatus,
  GithubWorkflowDefinition,
  GithubWorkflowRun
} from "@simulatorlife/autodev-core";
import React from "react";

import type {
  GithubMutationForm,
  GithubMutationForms
} from "../../lib/server/github-mutations.ts";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

const NOT_OBSERVED_STATUS = "not-observed";

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
 * Allowlisted operator mutations (dispatch for `_scheduler.yml` only, and
 * whole-workflow enable/disable for the configured scheduled allowlist) are
 * rendered below each eligible workflow when the server-provided `forms`
 * prop authorizes them. Cancel, rerun, and free-form dispatch inputs remain
 * strictly unimplemented and are never offered as controls.
 */

export interface GithubViewProps {
  readonly workflows: readonly GithubWorkflowDefinition[];
  readonly runtimeFactsAvailable?: boolean;
  readonly runtimeStatus?: GithubActionsRuntimeStatus;
  readonly runtimeMessage?: string | null;
  readonly repository?: string | null;
  readonly stats?: GithubActionsRunStats | null;
  readonly recentRuns?: readonly GithubWorkflowRun[];
  readonly forms?: GithubMutationForms;
  readonly operationsAvailable?: boolean;
  readonly mutationNotice?: "applied" | "failed" | null;
}

export function GithubView({
  workflows,
  runtimeFactsAvailable = false,
  runtimeStatus,
  runtimeMessage,
  repository,
  stats,
  recentRuns = [],
  forms = {},
  operationsAvailable = false,
  mutationNotice = null
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
      cell: (workflow) =>
        React.createElement(
          "div",
          { className: "flex flex-col" },
          React.createElement(
            "span",
            { className: "font-semibold text-slate-100" },
            workflow.name ?? workflow.id
          ),
          React.createElement(
            "span",
            { className: "text-xs font-mono text-slate-500" },
            workflow.path
          )
        )
    },
    {
      id: "events",
      header: "Trigger Events",
      cell: (workflow) =>
        workflow.events.length === 0
          ? React.createElement(
              "span",
              { className: "text-xs text-slate-500" },
              "None observed"
            )
          : React.createElement(
              "div",
              { className: "flex flex-wrap gap-1" },
              ...workflow.events.map((event) =>
                React.createElement(
                  "span",
                  {
                    key: event,
                    className:
                      "text-xs font-mono text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700"
                  },
                  event
                )
              )
            )
    },
    {
      id: "schedules",
      header: "Cron Schedule",
      cell: (workflow) =>
        workflow.schedules.length === 0
          ? React.createElement(
              "span",
              { className: "text-xs text-slate-500" },
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
                    className: "text-xs font-mono text-slate-300"
                  },
                  cron
                )
              )
            )
    },
    {
      id: "actionsState",
      header: "GitHub Actions State",
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
          status: NOT_OBSERVED_STATUS,
          label: "Unknown"
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
            { className: "text-xs text-slate-500" },
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
                  className: "text-xs text-cyan-400 hover:underline font-mono"
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
                    "font-semibold text-slate-100 hover:text-cyan-400 hover:underline font-mono text-xs"
                },
                `#${run.id} ${run.name ?? ""}`.trim()
              )
            : React.createElement(
                "span",
                { className: "font-semibold text-slate-100 font-mono text-xs" },
                `#${run.id} ${run.name ?? ""}`.trim()
              ),
          React.createElement(
            "span",
            { className: "text-xs font-mono text-slate-500" },
            run.workflowPath
          )
        )
    },
    {
      id: "event",
      header: "Event",
      cell: (run) =>
        React.createElement(
          "span",
          {
            className:
              "text-xs font-mono text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700"
          },
          run.event
        )
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
            { className: "text-slate-300" },
            run.headBranch ?? "—"
          ),
          React.createElement(
            "span",
            { className: "text-slate-500" },
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
          { className: "text-xs text-slate-400 font-mono" },
          run.createdAt
        )
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "github",
      "data-github-actions-facts-observed": runtimeFactsAvailable
        ? "true"
        : "false"
    },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, {
        title: "Workflow Definitions",
        value: workflows.length,
        subtitle: "Parsed from .github/workflows/*.yml"
      }),
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
          "div",
          { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
          React.createElement(StatCard, {
            title: "Recent Workflow Runs",
            value: stats.totalRuns,
            subtitle: `Counts cover the ${statsSampleDescription}; they are not total-history counts (${repository ?? "bound repository"}).`
          }),
          React.createElement(StatCard, {
            title: "Recent Success Rate",
            value:
              stats.successRate === null
                ? "N/A"
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
              "rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-4 text-xs text-emerald-200/90 leading-relaxed flex items-center justify-between",
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
                { className: "font-mono font-semibold text-emerald-100" },
                repository ?? "configured workspace"
              ),
              ". Allowlisted dispatch and enable/disable operator controls are available below for eligible workflows; cancel and rerun remain unimplemented."
            )
          )
        )
      : React.createElement(
          "div",
          {
            className:
              "rounded-lg border border-amber-800 bg-amber-950/30 p-4 text-xs text-amber-200/90 leading-relaxed",
            role: "note",
            "data-status": runtimeStatus ?? "unavailable"
          },
          "Workflow enabled/disabled state, run history, run status, and run counts " +
            "require the GitHub Actions API and are not available without it. " +
            "Dispatch and enable/disable operator controls require that same " +
            "observed runtime state and remain unavailable until it is. Cancel, " +
            "rerun, and schedule-modification controls remain unimplemented " +
            "regardless. Only the workflow definitions and trigger configuration " +
            "observed in YAML are shown below." +
            (runtimeMessage ? ` (${runtimeMessage})` : "")
        ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
        },
        "Workflow Definitions"
      ),
      DataTable({
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
              className:
                "text-sm font-semibold uppercase tracking-wider text-slate-400"
            },
            "Recent Workflow Runs"
          ),
          DataTable({
            data: recentRuns,
            columns: runColumns,
            keyExtractor: (run: GithubWorkflowRun) => String(run.id),
            emptyMessage: "No recent workflow runs observed."
          })
        )
      : null
  );
}
