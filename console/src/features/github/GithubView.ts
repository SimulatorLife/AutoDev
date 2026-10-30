import type {
  GithubActionsRunStats,
  GithubActionsRuntimeStatus,
  GithubWorkflowDefinition,
  GithubWorkflowRun
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { FILTER_SUMMARY_CLASS } from "../../components/filters/FilterBar.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
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
import { PathText } from "../../components/tables/PathText.ts";
import { instantLabel } from "../../components/ui/instant.ts";
import {
  ACTION_LINK_CLASS,
  ENTITY_LINK_CLASS,
  MONO_META_CLASS,
  MONO_VALUE_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { githubRunOutcome } from "./github-labels.ts";
import {
  countWorkflowStates,
  filterRuns,
  filterWorkflows,
  type GithubListFilters,
  githubListHref,
  RUN_OUTCOME_FILTERS,
  RUN_OUTCOME_LABELS,
  type RunOutcomeFilter,
  WORKFLOW_STATE_FILTERS,
  WORKFLOW_STATE_LABELS,
  type WorkflowStateFilter
} from "./github-list-url.ts";

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
  /**
   * The runs the Actions API returned.
   *
   * Null when the Actions read did not happen, and an empty list when it
   * happened and the workflows had never run. The page renders the run table
   * on the strength of `runtimeFactsAvailable`, which says the same thing, so
   * neither shape reaches the table.
   */
  readonly recentRuns?: readonly GithubWorkflowRun[] | null;
  /**
   * The outcome the runs are narrowed to.
   *
   * Optional, because a caller that does not narrow says so by leaving it out
   * rather than by passing "all".
   */
  readonly outcome?: RunOutcomeFilter | undefined;
  /**
   * The state the workflow definitions are narrowed to.
   *
   * Optional, and `undefined` means every state.
   */
  readonly state?: WorkflowStateFilter | undefined;
}

/**
 * One facet: a row of links that narrow a list to one of its values.
 *
 * The GitHub page is read-only and carries no form and no button at all -- a
 * committed contract, and the target state's: dispatch, cancel, rerun and
 * schedule controls are unimplemented and the Console must not expose them as
 * browser-side affordances. A link narrows without being one, and a link that
 * navigates to the narrowed address is the same narrowing a form would have
 * done.
 *
 * The two facets are the same control over different axes, so they are the
 * same code: the runs' outcomes and the definitions' states.
 */
function facetRow<Option extends string>({
  label,
  options,
  selected,
  href,
  dataAttribute
}: {
  readonly label: string;
  readonly options: readonly {
    readonly value: Option;
    readonly label: string;
    readonly count?: number | undefined;
  }[];
  readonly selected: Option;
  readonly href: (value: Option) => string;
  readonly dataAttribute: string;
}): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-wrap items-center gap-3" },
    React.createElement(
      "div",
      {
        // The group wraps: the names are words rather than the tools
        // catalogue's one-word roles, and a row that cannot wrap is a row that
        // runs past the edge of a phone.
        className:
          "flex flex-wrap items-center gap-1.5 bg-surface border border-border p-1 rounded-lg"
      },
      React.createElement(
        "span",
        { className: `px-2 ${MUTED_META_CLASS}` },
        label
      ),
      options.map((option) =>
        React.createElement(
          NavigationLink,
          {
            key: option.value,
            href: href(option.value),
            dataAttributes: { [dataAttribute]: option.value },
            className: `px-3 py-1 rounded text-xs font-medium transition-colors ${
              option.value === selected
                ? "bg-surface-raised text-accent"
                : `${MUTED_TEXT_CLASS} hover:text-fg`
            }`,
            // The selected chip is otherwise distinguishable only by its
            // colour, which is no way to read a selection aloud.
            ...(option.value === selected ? { "aria-current": "true" } : {})
          },
          option.count === undefined
            ? option.label
            : `${option.label} ${option.count}`
        )
      )
    )
  );
}

/**
 * The recent runs, with the facet that narrows them.
 */
function recentRunsSection({
  listFilters,
  runs,
  narrowed,
  columns,
  emptyMessage
}: {
  readonly listFilters: GithubListFilters;
  readonly runs: readonly GithubWorkflowRun[];
  readonly narrowed: readonly GithubWorkflowRun[];
  readonly columns: ColumnDef<GithubWorkflowRun>[];
  readonly emptyMessage: string;
}): React.JSX.Element {
  const isNarrowed = listFilters.outcome !== "all";
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "h2",
      {
        className: SECTION_HEADING_CLASS
      },
      "Recent Workflow Runs"
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-3" },
      facetRow({
        label: "Outcome:",
        options: RUN_OUTCOME_FILTERS.map((value) => ({
          value,
          label: RUN_OUTCOME_LABELS[value]
        })),
        selected: listFilters.outcome,
        href: (value) => githubListHref({ ...listFilters, outcome: value }),
        dataAttribute: "data-run-outcome"
      }),
      // The count of what is in view, in the same words the other filtered
      // lists use. It is a plain span rather than a filter bar's summary
      // because this page has no filter bar.
      isNarrowed
        ? React.createElement(
            "span",
            { className: FILTER_SUMMARY_CLASS },
            `Showing ${narrowed.length} of ${runs.length} runs`
          )
        : null
    ),
    React.createElement<DataTableProps<GithubWorkflowRun>>(DataTable, {
      data: narrowed,
      columns,
      keyExtractor: (run: GithubWorkflowRun) => String(run.id),
      emptyMessage
    })
  );
}

/**
 * What the active-workflow count covers.
 *
 * The Actions API does not report every workflow the repository declares, and
 * a workflow it did not report has no state to count. The count is right for
 * what arrived, and the subtitle says how much of the catalogue arrived, so
 * the number is not read as the whole. The state column draws the same
 * distinction per row.
 */
function activeWorkflowsSubtitle(
  counts: Record<WorkflowStateFilter, number>
): string {
  const unobserved = counts["not-observed"] + counts.unavailable;
  if (unobserved === 0) return "Enabled in GitHub Actions";
  return (
    `Enabled in GitHub Actions; the state of ${unobserved} of ${counts.all} ` +
    "workflows was not observed"
  );
}

/**
 * The workflow definitions, with the facet that narrows them.
 *
 * The facet is offered only when the runtime facts were read. Without them
 * there is no state to narrow by -- every workflow reads "Unavailable" -- and
 * naming the states the page has not observed would claim a fact it does not
 * have, which is the rule the state column itself follows.
 */
function workflowDefinitionsSection({
  listFilters,
  workflows,
  narrowed,
  stateCounts,
  runtimeFactsAvailable,
  columns,
  emptyMessage
}: {
  readonly listFilters: GithubListFilters;
  readonly workflows: readonly GithubWorkflowDefinition[];
  readonly narrowed: readonly GithubWorkflowDefinition[];
  readonly stateCounts: Record<WorkflowStateFilter, number>;
  readonly runtimeFactsAvailable: boolean;
  readonly columns: ColumnDef<GithubWorkflowDefinition>[];
  readonly emptyMessage: string;
}): React.JSX.Element {
  const isNarrowed =
    listFilters.state !== undefined && listFilters.state !== "all";
  return React.createElement(
    "div",
    null,
    React.createElement(
      "h2",
      {
        className: SECTION_HEADING_CLASS
      },
      "Workflow Definitions"
    ),
    runtimeFactsAvailable
      ? React.createElement(
          "div",
          { className: "flex flex-wrap items-center gap-3" },
          facetRow({
            label: "State:",
            options: WORKFLOW_STATE_FILTERS.map((value) => ({
              value,
              label: WORKFLOW_STATE_LABELS[value],
              count: stateCounts[value]
            })),
            selected: listFilters.state ?? "all",
            href: (value) => githubListHref({ ...listFilters, state: value }),
            dataAttribute: "data-workflow-state"
          }),
          isNarrowed
            ? React.createElement(
                "span",
                { className: FILTER_SUMMARY_CLASS },
                `Showing ${narrowed.length} of ${workflows.length} workflows`
              )
            : null
        )
      : null,
    React.createElement<DataTableProps<GithubWorkflowDefinition>>(DataTable, {
      data: narrowed,
      columns,
      keyExtractor: (workflow: GithubWorkflowDefinition) => workflow.id,
      emptyMessage
    })
  );
}

export function GithubView({
  workflows,
  runtimeFactsAvailable = false,
  runtimeStatus,
  runtimeMessage,
  repository,
  outcome = "all",
  state = "all",
  stats,
  recentRuns
}: GithubViewProps): React.JSX.Element {
  // The runs are null when the Actions read did not happen. The page renders
  // the run table only when the facts are available, so a null list and an
  // empty one are the same page -- and neither is a claim that the workflows
  // never ran.
  const runs = recentRuns ?? [];
  const scheduledCount = workflows.filter((w) => w.schedules.length > 0).length;
  const statsSampleSize = stats?.totalRuns ?? 0;
  const statsSampleDescription = `most recent ${statsSampleSize} returned run${statsSampleSize === 1 ? "" : "s"}`;
  const uniqueEvents = new Set<string>();
  for (const workflow of workflows) {
    for (const event of workflow.events) uniqueEvents.add(event);
  }

  // The runs are narrowed here rather than by the page, because the stat
  // cards above are about the *sample* and not about the view of it: the
  // success rate and the run counts describe every run the Actions API
  // returned, and they must not shrink because the operator narrowed the
  // table to the failures.
  const listFilters: GithubListFilters = { outcome, state };
  const narrowedRuns = filterRuns(runs, listFilters);
  const isNarrowed = listFilters.outcome !== "all";
  // The workflow definitions are narrowed by state, on the vocabulary the
  // "GitHub Actions State" column renders, so the filter's buckets and the
  // badges in the rows are the same thing.
  const narrowedWorkflows = filterWorkflows(
    workflows,
    listFilters,
    runtimeFactsAvailable
  );
  const stateCounts = countWorkflowStates(workflows, runtimeFactsAvailable);
  const isStateNarrowed =
    listFilters.state !== undefined && listFilters.state !== "all";
  const workflowEmptyMessage = isStateNarrowed
    ? `No ${WORKFLOW_STATE_LABELS[listFilters.state!].toLowerCase()} workflows were found.`
    : "No workflow definitions were found.";
  // A run the page does not count -- a skipped or neutral conclusion -- is in
  // the sample's total and in nobody's counter, so it is named here rather
  // than being quietly dropped by a filter that says "Failed".
  const runEmptyMessage = isNarrowed
    ? `No ${RUN_OUTCOME_LABELS[listFilters.outcome].toLowerCase()} runs were observed in this sample.`
    : "No recent workflow runs observed.";

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
          React.createElement(PathText, {
            path: workflow.path,
            // `break-normal` is the path's own rule: the only legal breaks are
            // the ones `PathText` marks between its segments. A `tokens`
            // column is `break-words`, which would let the browser invent a
            // break inside a segment -- the thing a path column exists to
            // prevent.
            className: `${MONO_META_CLASS} break-normal`
          })
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
      // A badge and a link, so the cell holds two things rather than one line
      // of text: `truncate` cannot ellipsize a row of blocks, so the link was
      // cut off the edge of the cell with nothing to show that it was there.
      align: "tokens",
      cell: (workflow) => {
        if (!workflow.lastRunStatus && !workflow.lastRunConclusion) {
          return React.createElement(
            "span",
            { className: MUTED_META_CLASS },
            "No runs observed"
          );
        }
        const runBadge = githubRunOutcome(
          workflow.lastRunConclusion,
          workflow.lastRunStatus
        );

        return React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement(StatusBadge, {
            status: runBadge.variant,
            label: runBadge.label
          }),
          workflow.lastRunHtmlUrl
            ? React.createElement(
                "a",
                {
                  href: workflow.lastRunHtmlUrl,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  // The name has to say which run the link opens: every
                  // workflow row carried a link named "View ↗".
                  "aria-label": `View the last ${workflow.name} run`,
                  className: `text-xs font-mono ${ACTION_LINK_CLASS}`
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
      // The run's own name over the workflow path it belongs to, which is two
      // things: `truncate` cuts a cell whose content is a column of blocks
      // rather than ellipsizing it, so the path was cut mid-segment with no
      // sign that there was more of it.
      align: "tokens",
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
                  className: `font-mono text-xs font-semibold text-fg ${ENTITY_LINK_CLASS}`
                },
                `#${run.id} ${run.name ?? ""}`.trim()
              )
            : React.createElement(
                "span",
                { className: "font-semibold text-fg font-mono text-xs" },
                `#${run.id} ${run.name ?? ""}`.trim()
              ),
          React.createElement(PathText, {
            path: run.workflowPath,
            className: `${MONO_META_CLASS} break-normal`
          })
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
      // The branch over the short commit, which is two things: `truncate` cuts
      // a cell whose content is a column of blocks rather than ellipsizing it,
      // so the branch was cut mid-segment with no sign that there was more.
      align: "tokens",
      cell: (run) =>
        React.createElement(
          "div",
          { className: "flex flex-col text-xs font-mono" },
          React.createElement(PathText, {
            path: run.headBranch ?? NOT_OBSERVED_LABEL,
            className: "text-fg-secondary break-normal"
          }),
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
        const runBadge = githubRunOutcome(run.conclusion, run.status);
        return React.createElement(StatusBadge, {
          status: runBadge.variant,
          label: runBadge.label
        });
      }
    },
    {
      id: "createdAt",
      header: "Created",
      cell: (run) =>
        React.createElement(
          "span",
          { className: MONO_META_CLASS },
          instantLabel(run.createdAt)
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
            subtitle:
              `From the same ${statsSampleDescription}: ${stats.successfulRuns} succeeded, ` +
              `${stats.failedRuns} failed, ${stats.inProgressRuns} running, ` +
              `${stats.cancelledRuns} cancelled`
          }),
          React.createElement(StatCard, {
            title: "Active Workflows",
            value: stateCounts.active,
            subtitle: activeWorkflowsSubtitle(stateCounts)
          })
        )
      : null,
    runtimeFactsAvailable
      ? React.createElement(
          "div",
          {
            className:
              "rounded-lg border border-success/60 bg-success/10 p-4 text-xs text-success leading-relaxed",
            role: "note",
            "data-status": "available"
          },
          React.createElement(
            "div",
            {
              // The badge and the message stack on a narrow window rather than
              // sharing a line: side by side, the message had 120px to say
              // that the Actions API was connected and that no mutation
              // controls exist, and the repository name was cut off the edge
              // of the callout with nothing to show that it was there.
              className:
                "flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center"
            },
            React.createElement(StatusBadge, {
              status: "ready",
              label: "Actions API Connected"
            }),
            React.createElement(
              "span",
              { className: "min-w-0 break-words" },
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
    workflowDefinitionsSection({
      listFilters,
      workflows,
      narrowed: narrowedWorkflows,
      stateCounts,
      runtimeFactsAvailable,
      columns,
      emptyMessage: workflowEmptyMessage
    }),
    runtimeFactsAvailable && runs.length > 0
      ? recentRunsSection({
          listFilters,
          runs,
          narrowed: narrowedRuns,
          columns: runColumns,
          emptyMessage: runEmptyMessage
        })
      : null
  );
}
