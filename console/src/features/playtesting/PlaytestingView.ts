import type {
  ControlApiPlaytestingHumanValidationResponse,
  ControlApiPlaytestingReview,
  PlaytestBatch,
  PlaytestComparison,
  PlaytestCoverageCellStatus,
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
import { DetailDrawer } from "../../components/panels/DetailDrawer.ts";
import {
  DetailGrid,
  DetailValue,
  StatGrid
} from "../../components/panels/DetailGrid.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeVariant
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
import { PlaytestComparisonDecisionForm } from "./PlaytestComparisonDecisionForm.ts";
import {
  episodeScenarioLabel,
  executionStatusBadge,
  gameOutcomeBadge,
  sessionMetaLine
} from "./playtesting-episode-presentation.ts";
import {
  batchStateLabel,
  evidenceStatusLabel,
  findingSeverityLabel,
  findingStatusLabel,
  reviewClaimStatusLabel
} from "./playtesting-labels.ts";
import {
  PLAYTESTING_FILTER_KEYS,
  PLAYTESTING_PAGE_SIZES,
  PLAYTESTING_REVIEW_DETAIL_ANCHOR_ID,
  playtestingEpisodeHref,
  playtestingFilterHref,
  type PlaytestingFilterKey,
  playtestingPageHref,
  playtestingReviewCloseHref,
  playtestingReviewHref,
  type PlaytestingScope,
  type PlaytestingView as PlaytestingViewTab,
  playtestingViewHref
} from "./playtesting-url.ts";

/**
 * The stack a drawer's sections are laid out in.
 *
 * The drawer's body is a run of labelled sections, and every one of them
 * needs the same vertical rhythm. Spelling it inline in each section is how
 * two adjacent sections end up a pixel apart.
 */
const SECTION_STACK_CLASS = "flex flex-col gap-2";

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
  /** Persisted analyst reviews; the record that survives a Runtime restart. */
  readonly reviewCount: number;
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
      /**
       * The analyst's persisted reviews for this workspace.
       *
       * Null when the review read failed: the session list is still the
       * session list without it, and a row must not claim that a session was
       * never analysed just because the counts could not be read.
       */
      readonly reviews?:
        readonly ControlApiPlaytestingReview[] | null | undefined;
      /** How many reviews the workspace holds in all. */
      readonly reviewTotal?: number | null | undefined;
    }
  | {
      readonly resource: "findings";
      readonly rows: readonly PlaytestFinding[];
      readonly total: number;
      readonly nextCursor: string | null;
      /** The analyst's persisted hypotheses about these sessions. */
      readonly reviews?: readonly ControlApiPlaytestingReview[] | undefined;
      readonly reviewTotal?: number | undefined;
    }
  | {
      readonly resource: "comparisons";
      readonly rows: readonly PlaytestComparison[];
      readonly total: number;
      readonly nextCursor: string | null;
      readonly ownerActionsAvailable?: boolean | undefined;
      readonly humanValidation?: PlaytestingHumanValidation | undefined;
    };

export interface PlaytestingViewProps {
  readonly scope: PlaytestingScope;
  readonly workspaces: readonly WorkspaceEntry[];
  readonly overview?: PlaytestingOverviewData | undefined;
  readonly currentBuildSha?: string | null | undefined;
  readonly list?: PlaytestingListData | undefined;
  readonly runDashboard?: React.ReactNode | undefined;
  readonly workspacePicker?: React.ReactNode | undefined;
  readonly sessionsWorkspace?: React.ReactNode | undefined;
}

function preserveForFilterForm(
  scope: PlaytestingScope,
  editable: readonly PlaytestingFilterKey[]
): readonly { readonly name: string; readonly value: string }[] {
  const preserved: { name: string; value: string }[] = [];
  if (scope.view !== "overview")
    preserved.push({ name: "view", value: scope.view });
  if (scope.workspaceId)
    preserved.push({ name: "workspaceId", value: scope.workspaceId });
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

function filterFields(scope: PlaytestingScope): {
  readonly editable: readonly PlaytestingFilterKey[];
  readonly children: React.ReactNode[];
} {
  const children: React.ReactNode[] = [];
  const editable: PlaytestingFilterKey[] = [];
  if (scope.view === "sessions") {
    editable.push(
      "q",
      "buildSha",
      "scenario",
      "policy",
      "cohort",
      "status",
      "gameOutcome"
    );
    children.push(
      textFilter("Search sessions", "q", scope.filters.q),
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

/**
 * The badge for one measurement-coverage cell.
 *
 * Each coverage state has its own word: "Not assigned" is not "Partial", and
 * neither is "Unsupported". Collapsing them into one badge would claim the
 * operator had measured something they had not.
 */
function coverageCellBadge(status: PlaytestCoverageCellStatus): {
  readonly status: StatusBadgeVariant;
  readonly label: string;
} {
  switch (status) {
    case "covered": {
      return { status: "valid", label: "Covered" };
    }
    case "not-assigned": {
      return { status: NOT_OBSERVED_STATUS, label: "Not assigned" };
    }
    case "unsupported":
    case "unsupported-modality": {
      return { status: "unavailable", label: "Unsupported" };
    }
    case "partial": {
      return { status: "unavailable", label: "Partial" };
    }
    default: {
      return { status: "unavailable", label: "Insufficient" };
    }
  }
}

/**
 * The panel for the most recent run.
 *
 * It says what the run was, whether it finished, and which build it ran
 * against — including when that build is not the one currently available to
 * run, which is the fact an operator comparing results needs most.
 */
function latestResultSection(
  latest: PlaytestBatch | undefined,
  latestSourceLabel: string | null,
  currentBuildSha: string | null,
  scope: PlaytestingScope
): React.JSX.Element {
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-latest-run-heading",
      "data-testid": "playtesting-latest-run"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-start justify-between gap-3" },
      React.createElement(
        "div",
        { className: "min-w-0" },
        React.createElement(
          "h2",
          {
            id: "playtesting-latest-run-heading",
            className: SECTION_HEADING_CLASS
          },
          "Latest result"
        ),
        latest
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                "div",
                { className: "flex flex-wrap items-center gap-2" },
                React.createElement(StatusBadge, {
                  status:
                    latest.status === "completed"
                      ? "valid"
                      : latest.status === "running" ||
                          latest.status === "queued"
                        ? "pending"
                        : "unavailable",
                  label: batchStateLabel(latest.status)
                }),
                React.createElement(
                  "span",
                  { className: "text-sm" },
                  `${String(latest.counts.completed)} of ${String(latest.counts.assigned)} ${latest.executionMode === "autonomous-visual" ? "sessions" : "assignments"} completed`
                )
              ),
              React.createElement(
                "p",
                { className: MUTED_META_CLASS },
                latestSourceLabel
              ),
              latest.executionMode === "adapter-accelerated" &&
                currentBuildSha !== null &&
                latest.buildSha !== currentBuildSha
                ? React.createElement(
                    "p",
                    { className: MUTED_META_CLASS },
                    "This result is from an earlier commit than the build currently available to run. Its evidence remains tied to the SHA shown here."
                  )
                : null,
              React.createElement(
                "p",
                { className: MUTED_META_CLASS },
                "Execution records describe whether assignments ran; game outcomes are shown separately on each session."
              )
            )
          : React.createElement(
              "p",
              { className: MUTED_BODY_CLASS },
              "No playtest runs are recorded yet. Start with the recommended bounded assignment above."
            )
      ),
      React.createElement(
        NavigationLink,
        {
          href: playtestingViewHref(scope, "sessions"),
          className: "text-sm font-medium text-accent hover:underline",
          dataAttributes: { "data-playtesting-browse-sessions": "true" }
        },
        "Browse all sessions"
      )
    ),
    latest
      ? React.createElement(
          NavigationLink,
          {
            href: playtestingFilterHref(scope, {
              view: "sessions",
              batchId: latest.batchId
            }),
            className:
              "mt-3 inline-flex text-sm font-medium text-accent hover:underline",
            dataAttributes: {
              "data-playtesting-latest-batch-sessions": latest.batchId
            }
          },
          "Open sessions from this run"
        )
      : null
  );
}

/**
 * The panel for the sessions recorded most recently.
 *
 * Each row leads with the outcome in words and carries the session's own id,
 * so a reader can tell two similar runs apart before opening either.
 */
function recentSessionsSection(
  recentEpisodes: readonly PlaytestEpisode[],
  episodeCount: number,
  batchCount: number,
  scope: PlaytestingScope
): React.JSX.Element {
  return React.createElement(
    "section",
    {
      className: "flex flex-col gap-3",
      "aria-labelledby": "playtesting-recent-sessions-heading"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "h2",
        {
          id: "playtesting-recent-sessions-heading",
          className: SECTION_HEADING_CLASS
        },
        "Recent sessions"
      ),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        `${String(episodeCount)} recorded across ${String(batchCount)} batches`
      )
    ),
    recentEpisodes.length === 0
      ? React.createElement(EmptyState, {
          variant: "inline",
          message:
            episodeCount === 0
              ? "No sessions have been persisted yet. A run can still be active or may finish without a session; check the live run status above."
              : "Recent sessions were not observed in this response. Browse the Sessions view to inspect the archive."
        })
      : React.createElement(
          "ul",
          {
            className: "grid gap-2",
            "aria-label": "Recent playtest sessions"
          },
          ...recentEpisodes.map((episode) =>
            React.createElement(
              "li",
              {
                key: episode.episodeId,
                className:
                  "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3"
              },
              React.createElement(
                "div",
                { className: "min-w-0 flex-1" },
                React.createElement(
                  "div",
                  { className: "flex flex-wrap items-center gap-2" },
                  React.createElement(
                    "span",
                    { className: "font-medium" },
                    episodeScenarioLabel(episode)
                  ),
                  executionStatusBadge(
                    episode.status,
                    episode.termination.reason
                  ),
                  gameOutcomeBadge(episode.outcome)
                ),
                React.createElement(
                  "p",
                  {
                    className: `mt-1 break-all font-mono text-xs ${MUTED_META_CLASS}`,
                    title: episode.episodeId
                  },
                  episode.episodeId
                ),
                React.createElement(
                  "p",
                  { className: MUTED_META_CLASS },
                  sessionMetaLine(episode)
                )
              ),
              React.createElement(
                NavigationLink,
                {
                  href: playtestingEpisodeHref(scope, episode.episodeId, null),
                  className: "text-sm font-medium text-accent hover:underline",
                  dataAttributes: {
                    "data-playtest-episode-link": episode.episodeId
                  }
                },
                episode.status === "assigned" || episode.status === "started"
                  ? "Watch"
                  : "Open session"
              )
            )
          )
        )
  );
}

function overview(
  data: PlaytestingOverviewData,
  scope: PlaytestingScope,
  currentBuildSha: string | null
): React.JSX.Element {
  const latest = data.batches[0];
  const latestSourceLabel =
    latest === undefined
      ? null
      : latest.executionMode === "autonomous-visual"
        ? `Autonomous visual · ${latest.assignmentInventory.manifest.targetOrigin} · Commit not applicable · ${latest.measurementVersion} · ${latest.batchId}`
        : `Build ${latest.buildSha.slice(0, 12)} · ${latest.measurementVersion} · ${latest.batchId}`;
  const recentEpisodes = data.latestEpisodes.slice(0, 4);
  const coverage = latest?.coverageManifest ?? null;
  const coverageDetails =
    coverage === null
      ? null
      : React.createElement(
          "details",
          {
            className: `${LIST_PANEL_CLASS} group`,
            "data-coverage-manifest": coverage.contentHash
          },
          React.createElement(
            "summary",
            { className: "cursor-pointer text-sm font-semibold" },
            "Measurement coverage",
            React.createElement(
              "span",
              { className: `ml-2 ${MUTED_META_CLASS}` },
              `${String(coverage.observedEpisodes)} of ${String(coverage.assignedEpisodes)} assignments recorded · ${String(coverage.cells.filter((cell) => cell.status === "covered").length)} metric cells meet their declared thresholds`
            )
          ),
          React.createElement(
            "div",
            { className: "mt-4 flex flex-col gap-3" },
            ...coverage.cells.map((cell) => {
              const badge = coverageCellBadge(cell.status);
              return React.createElement(
                "div",
                {
                  key: `${cell.coverageMetricId}:${cell.phaseId ?? "whole-episode"}:${cell.scenarioFamily}:${cell.cohort}:${cell.policy}:${cell.modality}`,
                  className:
                    "flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3",
                  "data-coverage-cell": cell.coverageMetricId
                },
                React.createElement(
                  "div",
                  { className: "min-w-0 flex-1" },
                  React.createElement(
                    "p",
                    { className: "font-medium" },
                    `${cell.coverageMetricId} · ${cell.phaseId ?? "whole episode"}`
                  ),
                  React.createElement(
                    "p",
                    { className: MUTED_META_CLASS },
                    `${cell.scenarioFamily} · ${cell.cohort} · ${cell.policy} · ${cell.modality} · ${String(cell.observedOpportunities)}/${String(cell.requiredOpportunities)} opportunities · ${cell.observedIndependentUnits === null ? "independent-unit count not observed" : `${String(cell.observedIndependentUnits)}/${String(cell.requiredIndependentUnits)} independent ${cell.analysisUnit}`}`
                  ),
                  cell.unsupportedReason === null
                    ? null
                    : React.createElement(
                        "p",
                        { className: MUTED_META_CLASS },
                        `Unsupported: ${cell.unsupportedReason}`
                      )
                ),
                React.createElement(StatusBadge, {
                  status: badge.status,
                  label: badge.label,
                  title:
                    cell.missingReasons.length > 0
                      ? cell.missingReasons.join(", ")
                      : undefined
                })
              );
            })
          )
        );

  const summaryMetrics = React.createElement(
    StatGrid,
    { columns: 4 },
    React.createElement(StatCard, {
      title: "Sessions",
      value: data.episodeCount,
      subtitle: "Across all test scenarios"
    }),
    React.createElement(StatCard, {
      title: "Runs",
      value: data.batchCount,
      subtitle: "Playtest batches executed"
    }),
    React.createElement(StatCard, {
      title: "Analyst Reviews",
      value: data.reviewCount,
      subtitle:
        data.reviewCount === 0
          ? "No analysis run yet"
          : "Hypotheses the analyst recorded"
    }),
    React.createElement(StatCard, {
      title: "Verified Findings",
      value: data.findingCount,
      subtitle:
        data.findingCount === 0
          ? "None verified yet"
          : "Claims backed by reproduced evidence"
    })
  );

  return React.createElement(
    React.Fragment,
    null,
    summaryMetrics,
    latestResultSection(latest, latestSourceLabel, currentBuildSha, scope),
    recentSessionsSection(
      recentEpisodes,
      data.episodeCount,
      data.batchCount,
      scope
    ),
    coverageDetails
  );
}

/**
 * The detail of one analyst review.
 *
 * The list clamps the headline so a column of them stays scannable, which is
 * right for scanning and wrong for reading: the analyst's conclusion is the
 * reason an operator comes to this view. The drawer is where the whole
 * conclusion is readable, and it is address state, so one review can be
 * linked to and a Back returns to it still open.
 *
 * The title is the conclusion and the review id is the subtitle. The id is a
 * hash of the review's identity: it says which record this is and nothing
 * about what was found, so a panel whose loudest element is the id is
 * answering a question the operator did not ask.
 */
function analystReviewDetail(
  review: ControlApiPlaytestingReview,
  scope: PlaytestingScope
): React.JSX.Element {
  return React.createElement(
    DetailDrawer,
    {
      title:
        review.headline.length > 0
          ? review.headline
          : "The analyst recorded no written conclusion for this session.",
      titleMono: false,
      badges: React.createElement(StatusBadge, {
        status: "pending",
        label:
          review.kind === "discovery"
            ? "Discovery review"
            : "Confirmatory review"
      }),
      subtitle: `${review.reviewId} · Recorded ${new Date(review.createdAt).toISOString()}`,
      closeHref: playtestingReviewCloseHref(scope),
      closeLabel: "Close review detail",
      anchorId: PLAYTESTING_REVIEW_DETAIL_ANCHOR_ID,
      dataAttributes: { "data-review-detail": review.reviewId }
    },
    React.createElement(
      DetailGrid,
      null,
      React.createElement(DetailValue, {
        label: "Hypotheses",
        children: String(review.interpretationCount)
      }),
      React.createElement(DetailValue, {
        label: "Observations",
        children: String(review.observationCount)
      }),
      React.createElement(DetailValue, {
        label: "Findings",
        children: String(review.findingCount)
      }),
      React.createElement(DetailValue, {
        label: "Status",
        children: reviewClaimStatusLabel(review.status)
      })
    ),
    // The claims themselves, not only how many there are. A count told the
    // reader that five hypotheses exist and left them unable to read any of
    // them, which is the whole content of the review.
    React.createElement(
      "div",
      { className: SECTION_STACK_CLASS },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        `What the analyst concluded (${String(review.hypotheses.length)})`
      ),
      review.hypotheses.length === 0
        ? React.createElement(
            "p",
            { className: `text-sm ${MUTED_META_CLASS}` },
            "This review records no written conclusions."
          )
        : React.createElement(
            "ol",
            {
              className:
                "flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-fg-secondary",
              "data-review-claims": String(review.hypotheses.length)
            },
            review.hypotheses.map((claim) =>
              React.createElement(
                "li",
                {
                  key: claim.hypothesisId,
                  "data-review-claim": claim.hypothesisId
                },
                claim.text,
                claim.status === "hypothesis"
                  ? null
                  : React.createElement(StatusBadge, {
                      status: NOT_OBSERVED_STATUS,
                      label: reviewClaimStatusLabel(claim.status)
                    })
              )
            )
          )
    ),
    React.createElement(
      "div",
      { className: SECTION_STACK_CLASS },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        `Findings this review raised (${String(review.findings.length)})`
      ),
      review.findings.length === 0
        ? React.createElement(
            "p",
            { className: `text-sm ${MUTED_META_CLASS}` },
            "This review raised no findings. A hypothesis that was never reproduced stays a hypothesis."
          )
        : React.createElement(
            "ul",
            { className: "flex flex-col gap-2 text-sm text-fg-secondary" },
            review.findings.map((finding) =>
              React.createElement(
                "li",
                {
                  key: finding.findingId,
                  className: "flex flex-wrap items-center gap-2"
                },
                React.createElement(
                  "span",
                  { className: "font-medium text-fg" },
                  finding.title.length > 0
                    ? finding.title
                    : "This finding carries no title."
                ),
                React.createElement(StatusBadge, {
                  status:
                    finding.evidenceStatus === "verified"
                      ? "valid"
                      : finding.evidenceStatus === "corroborated"
                        ? "ready"
                        : finding.evidenceStatus === "hypothesis"
                          ? "pending"
                          : NOT_OBSERVED_STATUS,
                  label: evidenceStatusLabel(finding.evidenceStatus)
                })
              )
            )
          )
    ),
    React.createElement(
      "div",
      { className: SECTION_STACK_CLASS },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "What the analyst recorded"
      ),
      React.createElement(
        "p",
        { className: `text-sm leading-relaxed ${MUTED_BODY_CLASS}` },
        review.summary.length > 0
          ? review.summary
          : "This review carries no written summary."
      )
    ),
    React.createElement(
      "div",
      { className: SECTION_STACK_CLASS },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        `Evidence cited (${String(review.evidenceRefs.length)})`
      ),
      review.evidenceRefs.length === 0
        ? React.createElement(
            "p",
            { className: `text-sm ${MUTED_META_CLASS}` },
            "This review cites no evidence."
          )
        : React.createElement(
            "ul",
            { className: "flex flex-col gap-1 text-sm text-fg-secondary" },
            review.evidenceRefs.map((ref, index) =>
              React.createElement(
                "li",
                { key: `${ref.kind}-${ref.id}-${index}` },
                `${ref.kind} · ${ref.id}${ref.step === undefined ? "" : ` · step ${String(ref.step)}`}`
              )
            )
          )
    ),
    React.createElement(
      NavigationLink,
      {
        href: playtestingEpisodeHref(scope, review.episodeId),
        className: "text-sm text-accent hover:underline",
        dataAttributes: { "data-review-detail-session": review.reviewId }
      },
      "Open the session this review came from"
    )
  );
}

/**
 * The analyst's hypotheses about this workspace's sessions.
 *
 * A discovery review is an unscored hypothesis set about what the analyst
 * saw on screen. It is the analyst's own conclusion, it is persisted, and
 * it is the thing a reader comes to this view for — so it is shown as
 * what it is: a hypothesis, not a defect.
 */
function analystHypotheses(
  reviews: readonly ControlApiPlaytestingReview[],
  reviewTotal: number,
  scope: PlaytestingScope
): React.JSX.Element {
  const selected =
    scope.selectedReviewId === null
      ? null
      : (reviews.find((review) => review.reviewId === scope.selectedReviewId) ??
        null);
  const columns: readonly ColumnDef<ControlApiPlaytestingReview>[] = [
    {
      id: "hypothesis",
      header: "Analyst hypothesis",
      weight: 320,
      align: "prose",
      clampLines: 3,
      cell: (review) =>
        React.createElement(
          "div",
          {
            id: `review-${review.reviewId}`,
            tabIndex: -1,
            "data-review-row": review.reviewId
          },
          React.createElement(
            NavigationLink,
            {
              href: playtestingReviewHref(scope, review.reviewId),
              // The headline is the way into the review, so the whole of it is
              // the target: an inline link's box is the union of its line
              // boxes, and the middle of that union can be a gap between two
              // lines where the click lands on the row instead of the link.
              className: "block font-medium text-fg hover:underline",
              dataAttributes: { "data-review-open": review.reviewId }
            },
            review.headline.length > 0
              ? review.headline
              : "The analyst recorded no written conclusion for this session."
          ),
          React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `${review.kind === "discovery" ? "Discovery" : "Confirmatory"} review · ${String(review.interpretationCount)} ${review.interpretationCount === 1 ? "hypothesis" : "hypotheses"} · ${String(review.observationCount)} ${review.observationCount === 1 ? "observation" : "observations"}`
          )
        )
    },
    {
      id: "session",
      header: "Session",
      weight: 200,
      cell: (review) =>
        React.createElement(
          NavigationLink,
          {
            href: playtestingEpisodeHref(scope, review.episodeId),
            className: "text-accent hover:underline",
            dataAttributes: { "data-review-session": review.reviewId }
          },
          "Open session"
        )
    },
    {
      id: "recorded",
      header: "Recorded",
      weight: 140,
      cell: (review) =>
        React.createElement(
          "span",
          { title: review.createdAt },
          new Date(review.createdAt).toISOString().slice(0, 10)
        )
    }
  ];
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-hypotheses-heading"
    },
    sectionHeading("playtesting-hypotheses-heading", "Analyst Hypotheses"),
    React.createElement(
      "p",
      { className: `mb-3 text-sm ${MUTED_META_CLASS}` },
      "What the analyst concluded from the recorded frames. These are hypotheses, not defects: nothing here has been reproduced or verified."
    ),
    // The open review's detail leads the page. The list is fifteen rows long,
    // so a panel under it would be thousands of pixels below the row that
    // opened it, and the operator would not see the conclusion they asked
    // for. The link that opens it names this anchor, so the arrival is the
    // panel and not the top of the document.
    //
    // A selection that names a review on another page opens nothing rather
    // than opening the wrong review.
    selected === null
      ? null
      : React.createElement(
          "div",
          { className: "mb-4" },
          analystReviewDetail(selected, scope)
        ),
    React.createElement<DataTableProps<ControlApiPlaytestingReview>>(
      DataTable,
      {
        data: reviews,
        columns,
        keyExtractor: (review) => review.reviewId,
        emptyMessage:
          reviewTotal === 0
            ? "No analysis has been recorded for this workspace yet. Run “Analyze this session” on a session and the analyst's conclusions will appear here."
            : "No hypotheses appear on this page; check the active cursor and filters."
      }
    ),
    React.createElement(PageSummary, {
      total: reviewTotal,
      visible: reviews.length,
      noun: "analyst reviews",
      nextCursor: null,
      scope
    })
  );
}

function findingsTable(
  rows: readonly PlaytestFinding[],
  total: number,
  scope: PlaytestingScope,
  nextCursor: string | null,
  reviews: readonly ControlApiPlaytestingReview[] = [],
  reviewTotal: number = 0
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
      cell: (finding) => findingSeverityLabel(finding.severity)
    },
    {
      id: "status",
      header: "Status",
      weight: 100,
      cell: (finding) => findingStatusLabel(finding.status)
    },
    {
      id: "evidence",
      header: "Evidence",
      weight: 160,
      cell: (finding) => evidenceStatusLabel(finding.evidenceStatus)
    },
    {
      id: "exposure",
      header: "Episodes affected",
      weight: 150,
      cell: (finding) =>
        finding.affectedEpisodes === null ||
        finding.totalEligibleEpisodes === null
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
              episode.step ?? null,
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
    "div",
    { className: "flex flex-col gap-4" },
    analystHypotheses(reviews, reviewTotal, scope),
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "aria-labelledby": "playtesting-findings-heading"
      },
      sectionHeading("playtesting-findings-heading", "Verified Findings"),
      React.createElement(
        "p",
        { className: `mb-3 text-sm ${MUTED_META_CLASS}` },
        "Claims that have been reproduced against a build. A session win or loss is not itself a finding; a finding requires a separate evidence-based investigation."
      ),
      React.createElement<DataTableProps<PlaytestFinding>>(DataTable, {
        data: rows,
        columns,
        keyExtractor: (finding) => `${finding.findingId}:${finding.version}`,
        emptyMessage:
          total === 0
            ? "No finding has been verified for this workspace. The analyst's hypotheses are listed above."
            : "No findings appear on this page; check the active cursor and filters."
      }),
      React.createElement(PageSummary, {
        total,
        visible: rows.length,
        noun: "findings",
        nextCursor,
        scope
      })
    )
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

function humanPreferenceContent(
  preference: ControlApiPlaytestingHumanValidationResponse["preference"]
): React.ReactNode[] {
  if (preference === null) {
    return [
      React.createElement(StatusBadge, {
        key: "preference-status",
        status: NOT_OBSERVED_STATUS,
        label: "Preference not collected"
      })
    ];
  }
  const content: React.ReactNode[] = [
    React.createElement(
      "h4",
      { className: "font-medium text-fg", key: "preference-heading" },
      "Paired-build preference (separate from PXI)"
    ),
    humanValidationSuppressionBadge(preference.suppressionState),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "preference-plan" },
      `Analysis plan ${preference.analysisPlanRef}`
    )
  ];
  if (preference.counts === null) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "preference-suppressed" },
        "Preference counts are suppressed to protect small participant or answer cells."
      )
    );
  } else {
    const counts = preference.counts;
    content.push(
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "preference-counts" },
        `Eligible completed pairs ${counts.eligibleParticipants} · A ${counts.preferA} · B ${counts.preferB} · ties ${counts.ties} · unable ${counts.unableToJudge} · missing ${counts.missing}`
      )
    );
  }
  const decisionLabels = {
    "supports-b-preference":
      "Evidence supports a preference for build B beyond the registered margin",
    "supports-a-preference":
      "Evidence supports a preference for build A beyond the registered margin",
    "no-material-preference":
      "No material A/B preference was detected within the registered margin",
    inconclusive:
      "Inconclusive under the registered participant, exclusion and interval gates"
  } as const;
  content.push(
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS, key: "preference-decision" },
      decisionLabels[preference.decision]
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "preference-limits" },
      `Incomplete exposure pairs: ${preference.incompleteExposurePairs === null ? "suppressed" : String(preference.incompleteExposurePairs)}`
    )
  );
  if (preference.interval === null) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "preference-no-interval" },
        "No qualified external preference interval is available; no preference claim is made."
      )
    );
  } else {
    const probability = preference.counts
      ? preference.counts.preferB /
        (preference.counts.preferA + preference.counts.preferB)
      : null;
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "preference-interval" },
        `Pr(B preferred | decisive response) = ${probability === null ? "not observed" : probability.toFixed(3)} · ${(preference.interval.confidenceLevel * 100).toFixed(0)}% exact interval [${preference.interval.lower.toFixed(3)}, ${preference.interval.upper.toFixed(3)}] · ${preference.interval.libraryVersion}`
      )
    );
  }

  if (preference.reasons.length > 0) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "preference-reasons" },
        "Decision limits: " +
          preference.reasons
            .map((reason) => reason.replaceAll("-", " "))
            .join("; ")
      )
    );
  }
  return content;
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
        label: "No instrument responses"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "none" },
        "No retained PXI/project-authored instrument responses are available for this build."
      ),
      ...humanPreferenceContent(data.preference)
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
  content.push(...humanPreferenceContent(data.preference));
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
  humanValidation: PlaytestingHumanValidation | undefined,
  ownerActionsAvailable: boolean
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
      id: "owner-disposition",
      header: "Owner decision",
      weight: 240,
      align: "prose",
      cell: (row) =>
        scope.workspaceId === null
          ? React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: "No owner decision recorded"
            })
          : React.createElement(PlaytestComparisonDecisionForm, {
              workspaceId: scope.workspaceId,
              comparison: row,
              enabled: ownerActionsAvailable
            })
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
  scope: PlaytestingScope,
  sessionsWorkspace: React.ReactNode
): React.JSX.Element {
  if (data.resource === "episodes") {
    return sessionsWorkspace
      ? React.createElement(React.Fragment, null, sessionsWorkspace)
      : React.createElement(EmptyState, {
          message: "The session workspace could not be loaded."
        });
  }
  if (data.resource === "findings") {
    return findingsTable(
      data.rows,
      data.total,
      scope,
      data.nextCursor,
      data.reviews ?? [],
      data.reviewTotal ?? 0
    );
  }
  return comparisonsTable(
    data.rows,
    data.total,
    scope,
    data.nextCursor,
    data.humanValidation,
    data.ownerActionsAvailable ?? false
  );
}

/**
 * The filters that are actually narrowing this list.
 *
 * A collapsed filter panel that says only "Filters" tells the reader
 * nothing about whether the list in front of them is the whole workspace
 * or a narrow slice of it. Saying how many filters are active answers
 * that at a glance, which is the question the reader actually has.
 */
function activeFilterCount(
  scope: PlaytestingScope,
  fields: ReturnType<typeof filterFields>
): number {
  return fields.editable.filter((key) => {
    const value = scope.filters[key];
    return typeof value === "string" && value.trim().length > 0;
  }).length;
}

function workspaceControls(
  scope: PlaytestingScope,
  fields: ReturnType<typeof filterFields>
): React.ReactNode {
  if (scope.view === "overview") return null;
  const active = activeFilterCount(scope, fields);
  return React.createElement(
    "details",
    { className: "rounded-lg border border-border bg-surface p-4" },
    React.createElement(
      "summary",
      { className: "cursor-pointer text-sm font-medium" },
      "Filters",
      active > 0
        ? React.createElement(
            "span",
            { className: `ml-2 ${MUTED_META_CLASS}` },
            `${String(active)} active`
          )
        : null
    ),
    React.createElement(
      "div",
      { className: "mt-4" },
      React.createElement(FilterBar, {
        label: "Playtesting filters",
        action: "/playtesting",
        preserved: preserveForFilterForm(scope, fields.editable),
        summary: scope.workspaceId
          ? `Workspace: ${scope.workspaceId}`
          : "Choose a workspace to read playtest data.",
        children: React.createElement(React.Fragment, null, ...fields.children)
      })
    )
  );
}

function invalidQueryNotice(scope: PlaytestingScope): React.ReactNode {
  return scope.invalidQuery
    ? React.createElement(
        "p",
        { className: "text-sm text-warning", role: "status" },
        "Some URL parameters were duplicated or invalid; unsupported values were not applied."
      )
    : null;
}

function viewContent(
  scope: PlaytestingScope,
  overviewData: PlaytestingOverviewData | undefined,
  list: PlaytestingListData | undefined,
  sessionsWorkspace: React.ReactNode,
  currentBuildSha: string | null
): React.ReactNode {
  if (scope.view === "overview" && overviewData) {
    return overview(overviewData, scope, currentBuildSha);
  }
  if (list) return activeList(list, scope, sessionsWorkspace);
  return React.createElement(EmptyState, {
    message: scope.workspaceId
      ? "The selected Playtesting view has no loaded result page."
      : "Choose a workspace to start a run or read its playtest history."
  });
}

export function PlaytestingView({
  scope,
  workspaces,
  overview: overviewData,
  currentBuildSha = null,
  list,
  runDashboard,
  workspacePicker,
  sessionsWorkspace
}: PlaytestingViewProps): React.JSX.Element {
  const fields = filterFields(scope);
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
      "section",
      {
        className:
          "flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5",
        "aria-label": "Playtesting controls"
      },
      React.createElement(
        "div",
        { className: "flex min-w-0 flex-col gap-1" },
        React.createElement(
          "p",
          { className: "text-sm font-medium text-fg" },
          "Explore, watch, and understand how your game plays."
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          selectedWorkspace?.enabled === false
            ? `${scope.workspaceId} · workspace disabled; history is read-only`
            : scope.workspaceId
              ? `Workspace: ${scope.workspaceId}`
              : "Choose a workspace to browse results or start a playtest."
        )
      ),
      React.createElement(
        "div",
        { className: "flex min-w-0 flex-wrap items-start justify-end gap-3" },
        workspacePicker,
        React.createElement(
          "div",
          { className: "flex min-w-0 flex-col items-end gap-2" },
          runDashboard
        )
      )
    ),
    React.createElement(TabNav, {
      navLabel: "Playtesting views",
      basePath: "/playtesting",
      tabs: VIEW_TABS,
      activeTabId: scope.view,
      hrefFor: (view) => playtestingViewHref(scope, view as PlaytestingViewTab)
    }),
    workspaceControls(scope, fields),
    invalidQueryNotice(scope),
    viewContent(scope, overviewData, list, sessionsWorkspace, currentBuildSha)
  );
}
