import type {
  ControlApiPlaytestingHumanValidationResponse,
  PlaytestBatch,
  PlaytestComparison,
  PlaytestEpisode,
  PlaytestFinding,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { FilterBar } from "../../components/filters/FilterBar.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import {
  LIST_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  PLAYTESTING_FILTER_KEYS,
  PLAYTESTING_PAGE_SIZES,
  playtestingEpisodeHref,
  type PlaytestingFilterKey,
  playtestingPageHref,
  type PlaytestingScope,
  type PlaytestingView as PlaytestingViewTab,
  playtestingViewHref
} from "./playtesting-url.ts";

const VIEW_TABS = [
  { id: "overview", label: "Overview" },
  { id: "sessions", label: "Sessions" },
  { id: "findings", label: "Findings" },
  { id: "compare", label: "Compare" }
] as const;

export interface PlaytestingOverviewData {
  readonly batches: readonly PlaytestBatch[];
  readonly batchCount: number;
  readonly episodeCount: number;
  readonly findingCount: number;
  readonly comparisonCount: number;
  readonly latestEpisodes: readonly PlaytestEpisode[];
}

export type PlaytestingHumanValidation =
  | { readonly kind: "not-collected"; readonly reason: string }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "available";
      readonly studyId: string;
      readonly data: ControlApiPlaytestingHumanValidationResponse;
    };

export type PlaytestingListData =
  | {
      readonly resource: "episodes";
      readonly rows: readonly PlaytestEpisode[];
      readonly total: number;
      readonly nextCursor: string | null;
    }
  | {
      readonly resource: "findings";
      readonly rows: readonly PlaytestFinding[];
      readonly total: number;
      readonly nextCursor: string | null;
    }
  | {
      readonly resource: "comparisons";
      readonly rows: readonly PlaytestComparison[];
      readonly total: number;
      readonly nextCursor: string | null;
      readonly humanValidation?: PlaytestingHumanValidation | undefined;
    };

export interface PlaytestingViewProps {
  readonly scope: PlaytestingScope;
  readonly workspaces: readonly WorkspaceEntry[];
  readonly overview?: PlaytestingOverviewData | undefined;
  readonly list?: PlaytestingListData | undefined;
}

function preserveForFilterForm(
  scope: PlaytestingScope,
  editable: readonly PlaytestingFilterKey[]
): readonly { readonly name: string; readonly value: string }[] {
  const preserved: { name: string; value: string }[] = [];
  if (scope.view !== "overview")
    preserved.push({ name: "view", value: scope.view });
  for (const key of PLAYTESTING_FILTER_KEYS) {
    if (editable.includes(key)) continue;
    const value = scope.filters[key];
    if (value) preserved.push({ name: key, value });
  }
  return preserved;
}

function textFilter(
  label: string,
  name: PlaytestingFilterKey,
  value: string | undefined
): React.JSX.Element {
  return React.createElement(
    "label",
    {
      className: "flex min-w-48 flex-col gap-1 text-xs text-fg-muted",
      key: name
    },
    label,
    React.createElement("input", {
      name,
      defaultValue: value,
      className: FIELD_CONTROL_CLASS,
      maxLength: 256,
      autoComplete: "off"
    })
  );
}

function selectFilter(
  label: string,
  name: PlaytestingFilterKey,
  value: string | undefined,
  values: readonly string[]
): React.JSX.Element {
  return React.createElement(SelectField, {
    name,
    label,
    defaultValue: value ?? "",
    options: [
      { value: "", label: "All" },
      ...values.map((option) => ({ value: option, label: option }))
    ],
    className: "min-w-40",
    key: name
  });
}

function filterFields(
  scope: PlaytestingScope,
  workspaces: readonly WorkspaceEntry[]
): {
  readonly editable: readonly PlaytestingFilterKey[];
  readonly children: React.ReactNode[];
} {
  const children: React.ReactNode[] = [
    React.createElement(SelectField, {
      name: "workspaceId",
      label: "Workspace",
      defaultValue: scope.workspaceId ?? "",
      options: [
        { value: "", label: "Select workspace" },
        ...workspaces.map((workspace) => ({
          value: workspace.id,
          label: workspace.id + (workspace.enabled ? "" : " · disabled")
        }))
      ],
      className: "min-w-56",
      key: "workspaceId"
    })
  ];
  const editable: PlaytestingFilterKey[] = [];
  if (scope.view === "sessions") {
    editable.push(
      "buildSha",
      "scenario",
      "policy",
      "cohort",
      "status",
      "gameOutcome"
    );
    children.push(
      textFilter("Build SHA", "buildSha", scope.filters.buildSha),
      textFilter("Scenario", "scenario", scope.filters.scenario),
      textFilter("Policy", "policy", scope.filters.policy),
      textFilter("Cohort", "cohort", scope.filters.cohort),
      selectFilter("Execution status", "status", scope.filters.status, [
        "assigned",
        "started",
        "completed",
        "crashed",
        "infrastructure-failed",
        "cancelled",
        "budget-truncated"
      ]),
      selectFilter("Game outcome", "gameOutcome", scope.filters.gameOutcome, [
        "win",
        "loss",
        "dnf",
        "other",
        "unknown"
      ])
    );
  } else if (scope.view === "findings") {
    editable.push("severity", "status", "verificationStage", "evidenceStatus");
    children.push(
      selectFilter("Severity", "severity", scope.filters.severity, [
        "catastrophic",
        "major",
        "minor",
        "informational"
      ]),
      selectFilter("Finding status", "status", scope.filters.status, [
        "open",
        "fixed",
        "regressed",
        "withdrawn",
        "stale"
      ]),
      selectFilter(
        "Verification",
        "verificationStage",
        scope.filters.verificationStage,
        [
          "not-yet-validated",
          "fixed-on-reproduced-case",
          "sustained-improvement",
          "regressed-elsewhere",
          "insufficient-evidence"
        ]
      ),
      selectFilter("Evidence", "evidenceStatus", scope.filters.evidenceStatus, [
        "verified",
        "corroborated",
        "hypothesis",
        "not observed"
      ])
    );
  } else if (scope.view === "compare") {
    editable.push("benchmarkId", "experimentId", "decision");
    children.push(
      textFilter("Benchmark", "benchmarkId", scope.filters.benchmarkId),
      textFilter("Experiment", "experimentId", scope.filters.experimentId),
      selectFilter("Decision", "decision", scope.filters.decision, [
        "eligible-for-owner-promotion",
        "hold-regression",
        "hold-inconclusive",
        "hold-not-comparable",
        "owner-decided",
        "denied"
      ])
    );
  }
  children.push(
    React.createElement(SelectField, {
      name: "limit",
      label: "Rows per page",
      defaultValue: String(scope.limit),
      options: PLAYTESTING_PAGE_SIZES.map((size) => ({
        value: String(size),
        label: String(size)
      })),
      className: "min-w-32",
      key: "limit"
    })
  );
  return { editable, children };
}

function sectionHeading(id: string, title: string): React.JSX.Element {
  return React.createElement(
    "h2",
    { id, className: SECTION_HEADING_CLASS },
    title
  );
}

export function executionStatusBadge(
  status: PlaytestEpisode["status"]
): React.JSX.Element {
  const mapping = {
    assigned: ["pending", "Assigned"],
    started: ["pending", "Started"],
    completed: ["valid", "Completed"],
    crashed: ["invalid", "Crashed"],
    "infrastructure-failed": ["unavailable", "Infrastructure failed"],
    cancelled: ["unavailable", "Cancelled"],
    "budget-truncated": ["unavailable", "Budget truncated"]
  } as const;
  const [variant, label] = mapping[status];
  return React.createElement(StatusBadge, { status: variant, label });
}

export function gameOutcomeBadge(
  value: PlaytestEpisode["outcome"]
): React.JSX.Element {
  const variant =
    value === "win"
      ? "valid"
      : value === "unknown"
        ? NOT_OBSERVED_STATUS
        : "unavailable";
  return React.createElement(StatusBadge, {
    status: variant,
    label: value === "unknown" ? "Not observed" : value.toUpperCase(),
    title: "Game outcome is separate from playtest execution status."
  });
}

function episodeColumns(
  scope: PlaytestingScope
): readonly ColumnDef<PlaytestEpisode>[] {
  return [
    {
      id: "episode",
      header: "Episode",
      weight: 190,
      align: "tokens",
      cell: (episode) =>
        React.createElement(
          NavigationLink,
          {
            href: playtestingEpisodeHref(scope, episode.episodeId, 0),
            className: "text-accent hover:underline font-mono break-all",
            dataAttributes: { "data-playtest-episode-link": episode.episodeId }
          },
          episode.episodeId
        )
    },
    {
      id: "scenario",
      header: "Scenario",
      weight: 130,
      cell: (episode) => episode.identity.scenarioId
    },
    {
      id: "policy",
      header: "Policy / cohort",
      weight: 160,
      align: "tokens",
      cell: (episode) =>
        `${episode.identity.policyId} · ${episode.policyCohort}`
    },
    {
      id: "execution",
      header: "Execution",
      weight: 130,
      cell: (episode) => executionStatusBadge(episode.status)
    },
    {
      id: "outcome",
      header: "Game outcome",
      weight: 120,
      cell: (episode) => gameOutcomeBadge(episode.outcome)
    },
    {
      id: "steps",
      header: "Steps",
      weight: 70,
      cell: (episode) => String(episode.stepCount)
    }
  ];
}

function episodesTable(
  rows: readonly PlaytestEpisode[],
  total: number,
  scope: PlaytestingScope,
  nextCursor: string | null
): React.JSX.Element {
  const message =
    total === 0
      ? "No playtest episodes are recorded for these filters."
      : "This page has no rows; return to the first page or review the active filters.";
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-episodes-heading"
    },
    sectionHeading("playtesting-episodes-heading", "Episodes"),
    React.createElement<DataTableProps<PlaytestEpisode>>(DataTable, {
      data: rows,
      columns: episodeColumns(scope),
      keyExtractor: (episode) => episode.episodeId,
      emptyMessage: message
    }),
    React.createElement(PageSummary, {
      total,
      visible: rows.length,
      noun: "episodes",
      nextCursor,
      scope
    })
  );
}

function PageSummary({
  total,
  visible,
  noun,
  nextCursor,
  scope
}: {
  readonly total: number;
  readonly visible: number;
  readonly noun: string;
  readonly nextCursor: string | null;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: "mt-4 flex flex-wrap items-center justify-between gap-3",
      "aria-live": "polite"
    },
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      `${visible} shown · ${total} matching ${noun}`
    ),
    nextCursor
      ? React.createElement(
          NavigationLink,
          {
            href: playtestingPageHref(scope, nextCursor),
            className: "text-sm font-medium text-accent hover:underline",
            dataAttributes: { "data-playtesting-next-page": "true" }
          },
          "Next page"
        )
      : null
  );
}

function overview(
  data: PlaytestingOverviewData,
  scope: PlaytestingScope
): React.JSX.Element {
  const latest = data.batches[0];
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Batches",
        value: data.batchCount
      }),
      React.createElement(StatCard, {
        title: "Episodes",
        value: data.episodeCount
      }),
      React.createElement(StatCard, {
        title: "Findings",
        value: data.findingCount
      }),
      React.createElement(StatCard, {
        title: "Comparisons",
        value: data.comparisonCount
      })
    ),
    latest
      ? React.createElement(
          "section",
          {
            className: NESTED_PANEL_CLASS,
            "aria-labelledby": "latest-batch-heading"
          },
          sectionHeading("latest-batch-heading", "Latest batch"),
          React.createElement(
            StatGrid,
            { columns: 4 },
            React.createElement(StatCard, {
              title: "Execution",
              value: latest.status
            }),
            React.createElement(StatCard, {
              title: "Assigned",
              value: latest.counts.assigned
            }),
            React.createElement(StatCard, {
              title: "Completed",
              value: latest.counts.completed
            }),
            React.createElement(StatCard, {
              title: "Infrastructure failures",
              value: latest.counts.infrastructureFailed
            })
          ),
          React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `Build ${latest.buildSha} · ${latest.measurementVersion}`
          )
        )
      : React.createElement(EmptyState, {
          message: scope.workspaceId
            ? "No playtest batch has been recorded for this workspace."
            : "Select a workspace to read its playtest history."
        }),
    data.latestEpisodes.length > 0
      ? episodesTable(data.latestEpisodes, data.episodeCount, scope, null)
      : React.createElement(EmptyState, {
          message:
            data.episodeCount === 0
              ? "No episodes are recorded yet."
              : "Recent episode rows are not observed in this response."
        })
  );
}

function findingsTable(
  rows: readonly PlaytestFinding[],
  total: number,
  scope: PlaytestingScope,
  nextCursor: string | null
): React.JSX.Element {
  const columns: readonly ColumnDef<PlaytestFinding>[] = [
    {
      id: "finding",
      header: "Finding",
      weight: 260,
      align: "prose",
      clampLines: 2,
      cell: (finding) =>
        React.createElement(
          "div",
          {
            id: `finding-${finding.findingId}`,
            tabIndex: -1,
            "data-finding-row": finding.findingId
          },
          React.createElement(
            "p",
            { className: "font-medium text-fg" },
            finding.title
          ),
          React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            finding.findingId
          )
        )
    },
    {
      id: "severity",
      header: "Severity",
      weight: 100,
      cell: (finding) => finding.severity
    },
    {
      id: "status",
      header: "Status",
      weight: 100,
      cell: (finding) => finding.status
    },
    {
      id: "evidence",
      header: "Evidence",
      weight: 160,
      cell: (finding) => finding.evidenceStatus
    },
    {
      id: "exposure",
      header: "Episodes affected",
      weight: 150,
      cell: (finding) =>
        finding.affectedEpisodes === null || finding.totalEligibleEpisodes === null
          ? "Not observed"
          : `${finding.affectedEpisodes} / ${finding.totalEligibleEpisodes}`
    },
    {
      id: "witness",
      header: "Witness",
      weight: 120,
      cell: (finding) => {
        const episode = finding.evidenceRefs.find(
          (ref) => ref.kind === "episode"
        );
        if (!episode)
          return React.createElement(StatusBadge, {
            status: NOT_OBSERVED_STATUS,
            label: NOT_OBSERVED_LABEL
          });
        return React.createElement(
          NavigationLink,
          {
            href: playtestingEpisodeHref(
              scope,
              episode.id,
              episode.step ?? 0,
              finding.findingId
            ),
            className: "text-accent hover:underline",
            dataAttributes: { "data-finding-witness": finding.findingId }
          },
          "Open witness"
        );
      }
    }
  ];
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-findings-heading"
    },
    sectionHeading("playtesting-findings-heading", "Findings"),
    React.createElement<DataTableProps<PlaytestFinding>>(DataTable, {
      data: rows,
      columns,
      keyExtractor: (finding) => `${finding.findingId}:${finding.version}`,
      emptyMessage:
        total === 0
          ? "No findings match these filters."
          : "No findings appear on this page; check the active cursor and filters."
    }),
    React.createElement(PageSummary, {
      total,
      visible: rows.length,
      noun: "findings",
      nextCursor,
      scope
    })
  );
}

function humanValidationSuppressionBadge(
  state: "suppressed" | "partially-suppressed" | "unsuppressed"
): React.JSX.Element {
  return React.createElement(StatusBadge, {
    status: state === "unsuppressed" ? "valid" : "unavailable",
    label:
      state === "suppressed"
        ? "Suppressed"
        : state === "partially-suppressed"
          ? "Partially suppressed"
          : "Unsuppressed"
  });
}

function humanValidationCell(cell: {
  readonly id: string;
  readonly name: string;
  readonly state: "suppressed" | "partially-suppressed" | "unsuppressed";
  readonly mean: number | null;
  readonly respondents: number | null;
  readonly missing: number | null;
  readonly unit: string;
}): React.JSX.Element {
  return React.createElement(
    "li",
    {
      className: NESTED_PANEL_CLASS,
      key: cell.id,
      "data-human-cell": cell.id,
      "data-suppression-state": cell.state
    },
    React.createElement("strong", null, cell.name),
    cell.state === "suppressed" || cell.mean === null
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          cell.state === "suppressed"
            ? "Suppressed to protect small cells"
            : "Not observed"
        )
      : React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          `Native mean ${String(cell.mean)} ${cell.unit} · n=${String(cell.respondents)} · missing=${String(cell.missing)}`
        )
  );
}

function humanValidationSummaryContent(
  state: Extract<PlaytestingHumanValidation, { readonly kind: "available" }>
): React.ReactNode[] {
  const { data } = state;
  const summary = data.summary;
  const content: React.ReactNode[] = [
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "source" },
      `Study ${state.studyId} · ${summary?.instrument ?? "Human study"} · build ${data.buildSha}`
    )
  ];
  if (summary === null) {
    content.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: NOT_OBSERVED_STATUS,
        label: "Not observed"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "none" },
        "The approved study has no retained responses for this build."
      )
    );
    return content;
  }

  content.push(
    humanValidationSuppressionBadge(summary.suppressionState),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "participants" },
      summary.retainedParticipants === null
        ? "Retained participant count suppressed"
        : `${summary.retainedParticipants} retained participants · ${summary.measurementVersion}`
    )
  );
  const cells = [
    ...summary.items.map((item) => ({
      id: `item:${item.itemId}`,
      name: item.itemId,
      state: item.suppressionState,
      mean: item.mean,
      respondents: item.respondentCount,
      missing: item.missingCount,
      unit: item.unit
    })),
    ...summary.constructs.map((item) => ({
      id: `construct:${item.constructId}`,
      name: item.constructId,
      state: item.suppressionState,
      mean: item.mean,
      respondents: item.respondentCount,
      missing: item.missingCount,
      unit: item.unit
    }))
  ];
  content.push(
    cells.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS, key: "empty" },
          "No instrument items are configured for this study."
        )
      : React.createElement(
          "ul",
          {
            className: "grid gap-2 md:grid-cols-2",
            key: "cells",
            "aria-label": "Human-reported native-scale outcomes"
          },
          ...cells.map(humanValidationCell)
        )
  );
  if (summary.pairedDifferences.length > 0) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "paired" },
        "Paired build differences: " +
          summary.pairedDifferences
            .map((difference) =>
              difference.suppressionState === "suppressed"
                ? `${difference.itemId}: suppressed`
                : `${difference.itemId}: ${String(difference.meanDifference)} (n=${String(difference.pairedParticipants)})`
            )
            .join(" · ")
      )
    );
  }
  return content;
}

function humanValidationContent(
  state: PlaytestingHumanValidation | undefined
): React.ReactNode[] {
  if (!state || state.kind === "not-collected") {
    return [
      React.createElement(StatusBadge, {
        key: "status",
        status: NOT_OBSERVED_STATUS,
        label: "Not collected"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "reason" },
        state?.reason ??
          "No approved human study is linked to this comparison; model and human outcomes are not inferred from each other."
      )
    ];
  }
  if (state.kind === "unavailable") {
    return [
      React.createElement(StatusBadge, {
        key: "status",
        status: "unavailable",
        label: "Unavailable"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        state.message
      ),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "code" },
        state.code
      )
    ];
  }
  return humanValidationSummaryContent(state);
}

function humanValidationPanel(
  state: PlaytestingHumanValidation | undefined
): React.JSX.Element {
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-human-validation-heading",
      "data-human-validation": state?.kind ?? "not-collected"
    },
    sectionHeading("playtesting-human-validation-heading", "Human validation"),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "Consent-scoped human instrument results remain on their native scale. They are not model scores, and suppressed cells are never reconstructed."
    ),
    ...humanValidationContent(state)
  );
}

function comparisonsTable(
  rows: readonly PlaytestComparison[],
  total: number,
  scope: PlaytestingScope,
  nextCursor: string | null,
  humanValidation: PlaytestingHumanValidation | undefined
): React.JSX.Element {
  const columns: readonly ColumnDef<PlaytestComparison>[] = [
    {
      id: "comparison",
      header: "Comparison",
      weight: 180,
      align: "tokens",
      cell: (row) => row.comparisonId
    },
    {
      id: "benchmark",
      header: "Benchmark",
      weight: 160,
      align: "tokens",
      cell: (row) => row.benchmarkId
    },
    {
      id: "decision",
      header: "Decision",
      weight: 220,
      align: "prose",
      cell: (row) => row.decision
    },
    {
      id: "metrics",
      header: "Per-metric conclusions",
      weight: 300,
      align: "prose",
      cell: (row) =>
        row.metrics.length === 0
          ? React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: NOT_OBSERVED_LABEL
            })
          : React.createElement(
              "ul",
              { className: "list-disc pl-5" },
              ...row.metrics
                .slice(0, 4)
                .map((metric) =>
                  React.createElement(
                    "li",
                    { key: `${metric.metricId}:${metric.metricVersion}` },
                    `${metric.metricId}: ${metric.classification}`
                  )
                )
            )
    },
    {
      id: "human",
      header: "Human preference",
      weight: 150,
      cell: (row) =>
        row.humanPreference.answer === "not-collected"
          ? React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: "Not collected"
            })
          : row.humanPreference.answer
    }
  ];
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "aria-labelledby": "playtesting-comparisons-heading"
      },
      sectionHeading("playtesting-comparisons-heading", "Comparisons"),
      React.createElement<DataTableProps<PlaytestComparison>>(DataTable, {
        data: rows,
        columns,
        keyExtractor: (row) => `${row.comparisonId}:${row.version}`,
        emptyMessage:
          total === 0
            ? "No comparisons are recorded for these filters."
            : "No comparisons appear on this page; check the active cursor and filters."
      }),
      React.createElement(PageSummary, {
        total,
        visible: rows.length,
        noun: "comparisons",
        nextCursor,
        scope
      })
    ),
    humanValidationPanel(humanValidation)
  );
}

function activeList(
  data: PlaytestingListData,
  scope: PlaytestingScope
): React.JSX.Element {
  if (data.resource === "episodes") {
    return episodesTable(data.rows, data.total, scope, data.nextCursor);
  }
  if (data.resource === "findings") {
    return findingsTable(data.rows, data.total, scope, data.nextCursor);
  }
  return comparisonsTable(
    data.rows,
    data.total,
    scope,
    data.nextCursor,
    data.humanValidation
  );
}

export function PlaytestingView({
  scope,
  workspaces,
  overview: overviewData,
  list
}: PlaytestingViewProps): React.JSX.Element {
  const fields = filterFields(scope, workspaces);
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === scope.workspaceId
  );
  return React.createElement(
    PageBody,
    {
      feature: "playtesting",
      attributes: {
        "data-view": scope.view,
        "data-workspace": scope.workspaceId ?? "",
        "data-workspace-enabled": selectedWorkspace?.enabled ? "true" : "false"
      }
    },
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "Recorded game sessions and evidence. Execution state, game outcomes, evaluator verdicts, and human-reported experience are separate measurements."
    ),
    React.createElement(TabNav, {
      navLabel: "Playtesting views",
      basePath: "/playtesting",
      tabs: VIEW_TABS,
      activeTabId: scope.view,
      hrefFor: (view) => playtestingViewHref(scope, view as PlaytestingViewTab)
    }),
    React.createElement(FilterBar, {
      label: "Playtesting filters",
      action: "/playtesting",
      preserved: preserveForFilterForm(scope, fields.editable),
      summary: scope.workspaceId
        ? `Workspace: ${scope.workspaceId}${selectedWorkspace?.enabled === false ? " · disabled; history is read-only" : ""}`
        : "Choose a workspace to read playtest data.",
      children: React.createElement(React.Fragment, null, ...fields.children)
    }),
    scope.invalidQuery
      ? React.createElement(
          "p",
          { className: "text-sm text-warning", role: "status" },
          "Some URL parameters were duplicated or invalid; unsupported values were not applied."
        )
      : null,
    scope.view === "overview" && overviewData
      ? overview(overviewData, scope)
      : list
        ? activeList(list, scope)
        : React.createElement(EmptyState, {
            message: scope.workspaceId
              ? "The selected Playtesting view has no loaded result page."
              : "Select a workspace to read playtest history."
          })
  );
}
